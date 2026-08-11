# カード評価フィードバック (card feedback)

判断カードを**選択して実際に使った側**が、そのカードが効いたかどうかを返す経路。
返ってきた評価が悪いカードは自動でアーカイブし、以後の検索対象から外す。

正本はこのファイル。カードそのものの設計は `clone-db.md`、運用は `operations.md`、
検索ミス計測は `active-questioning.md` §1.2 を参照する。

## 1. 目的

Genius のカードは蒸留 LLM が作るので、**使ってみて初めて効かないと分かる**ものが混ざる。
現状は人間が WebUI で retire するしかなく、実際にカードを消費するサービス側
(Claude / Codex セッション、その他 Genius を引く LUDIARS サービス) が
「これは外れだった」と伝える口が無い。

利用側からの評価を受け取り、悪いカードを自動で選択対象から外す。

## 2. 評価語彙 (統制語彙・4 値)

| rating | 意味 |
|---|---|
| `great` | 判断がそのまま効いた。この場面の正解だった |
| `good` | 役に立った。参考として妥当だった |
| `poor` | 判断が誤っていた / 従うと有害だった |
| `not-in-case` | カードの中身は妥当だが、**今回の場面には当てはまらなかった** |

`not-in-case` は**カードの品質評価ではない**。「検索がこの場面に合っていないカードを
返した」という retrieval 側の信号なので、**アーカイブ判定の分子にも分母にも入れない**。
ここを混ぜると、汎用的で正しいカードが「場面違いで引かれた回数」の多さだけで消える。

語彙は DB の CHECK 制約で強制する (カテゴリー統制語彙と同じ方針、ベタ書きの散在禁止)。

## 3. データ

migration 008:

```sql
CREATE TABLE card_feedback (
  id         TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL REFERENCES clone_cards(id) ON DELETE CASCADE,
  rating     TEXT NOT NULL CHECK (rating IN ('great','good','poor','not-in-case')),
  query_id   TEXT NULL CHECK (query_id IS NULL OR length(query_id) BETWEEN 1 AND 64),
                         -- 由来クエリ (query_log.id)。保持期間削除で消えるので FK は張らない
  source     TEXT NULL CHECK (source IS NULL OR length(source) BETWEEN 1 AND 256),
                         -- 送信元サービス / セッションの識別子
  note       TEXT NULL CHECK (note IS NULL OR length(note) BETWEEN 1 AND 4096),
                         -- 自由文
  created_at INTEGER NOT NULL
);
```

- `clone_cards.retired_reason TEXT NULL` を追加する。既存の retire は `NULL`
  (= 由来不明 / 手動) のまま、本機能が落としたものは `'feedback'`。
  UI と運用が「人が消したのか評価で落ちたのか」を区別できるようにする。
- `clone_cards.feedback_reset_at INTEGER NULL` を追加する。§4 の再アーカイブ抑止に使う。
- **`note` は自由文なので秘匿の可能性がある**。`query_log` と同じ扱いにし、
  公開 export に出さない・カード DTO にも出さない (集計だけ出す)。

## 4. アーカイブ規則

Traceability ID: `SPEC-GENIUS-CARD-FEEDBACK-ARCHIVE`

`great` / `good` / `poor` の実数だけを数える (`not-in-case` は除外)。

```
judged      = great + good + poor
poorRatio   = poor / judged
archive if  poor >= feedback.minimumPoor  AND  poorRatio >= feedback.poorRatio
```

既定値は `feedback.minimumPoor = 3` / `feedback.poorRatio = 0.6`
(`genius.config.json` で変更可)。**1 件の poor では落とさない**: 蒸留カードは
場面依存で、たまたま合わなかった 1 回で消すと復元コストの方が高い。

- アーカイブは既存の retire 機構をそのまま使う (`retired_at` を立てる)。
  active predicate は `active-card-sql.ts` の 1 箇所なので、検索・一覧・公開 export・
  蒸留の重複判定すべてから同時に外れる。**新しい「アーカイブ状態」を作らない**。
- 判定は feedback を 1 件記録した直後に同期で行う。対象カード 1 枚分の集計しか
  読まないので安い。
- 既に retire 済みのカードは触らない (retire 時刻を上書きしない)。
- **再アーカイブの抑止**: 人が un-retire したカードを過去の poor で即座に落とし直さない。
  un-retire (`PATCH {retired:false}`) の時点で `feedback_reset_at` を現在時刻にし、
  判定は `created_at > COALESCE(feedback_reset_at, 0)` の feedback だけを数える。
- アーカイブは `clone_card_revisions` に記録する (変更列名のみ。既存方針どおり値は残さない)。

## 5. 送信経路

Traceability ID: `SPEC-GENIUS-CARD-FEEDBACK-HTTP`

利用側がどの経路でも同じ語彙で返せるようにする。

| 経路 | 形 |
|---|---|
| HTTP | `POST /api/clone/cards/:id/feedback` `{rating, queryId?, source?, note?}` → 201 + 集計 |
| HTTP | `GET /api/clone/cards/:id/feedback` → 集計 + 直近数件 + 評価由来 archive 状態 (note 込み、loopback またはアクセス制御済み front door 限定) |
| MCP | `genius_card_feedback` tool。`genius_query` で引いた AI がそのまま返せる |
| CLI | `node dist/cli.js feedback <cardId> <rating> [--note <text>] [--source <name>]` |
| WebUI | カードごとに 4 ボタン + 集計表示 |

- MCP は `genius_query` と同じく **public カードだけ**を対象にする。sensitive カードの
  id は MCP 経由では出ないので、送られてきた id が sensitive なら受け付けない。
- `publicOnly: true` は一般のローカル HTTP API を狭める一方向の指定で、認証情報ではない。
  MCP server が必ず付与し、CLI / WebUI は省略する。`false` は受け付けない。
- 存在しない card id は 404。未知の rating は 400 (無言で既定値に倒さない)。

## 6. 表示

Traceability ID: `SPEC-GENIUS-CARD-FEEDBACK-UI`

カード一覧 / 詳細の DTO に集計だけを載せる (`great` / `good` / `poor` / `notInCase` の
件数)。note は載せない。集計は一覧 1 回につき 1 本のグループ集計で引き、
カード 1 枚ごとの追加クエリにしない。

## 7. 受け入れ条件

- 4 値以外は 400 で拒否され、DB にも入らない。
- `poor` が既定閾値を超えたカードは自動で active から外れ、`/api/clone/query` に出ない。
- `not-in-case` をいくら送ってもアーカイブされない。
- un-retire したカードが、それ以前の feedback だけで再アーカイブされない。
- 公開 export に `note` が出ない。
- MCP から sensitive カードへの feedback は受け付けない。

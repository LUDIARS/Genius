# Genius 補完質問 (能動学習) 設計

status: draft (2026-09-03 neco 方針決定の反映)
親設計: `spec/feature/clone-db.md` (approved) / `spec/feature/operations.md` (運用化)
前提タスク: category カード (operations.md §1)・棚卸し WebUI と supersede/非活性化 (§5)

用語: 本 spec の **retire** は operations.md §5 の「単純に非活性化」を指す
(新しい置き換え先カードを伴わない無効化)。`superseded_by` で置き換え先を張るのが
**supersede**。**active カード** = `superseded_by IS NULL` かつ retire されていない
カード。

## 0. 背景と決定事項

neco 指示 (2026-07-30): 「Voluptas のように判断を補完する質問を投げて精度を上げる」。

Voluptas のアンケートは 12 次元 / 15 軸に 1 問ずつ割り当てた**固定カタログ**
(`gamer-preferences` 28 問) で、既収集回答との比較可能性を保つため問題数を固定している。
Genius のカードは蒸留由来で「取りこぼし」が測れるため、固定カタログを持ち込まず
**コーパスの不確かさを検出してから質問を生成する適応型**にする。

回答経路の当初決定 (neco 2026-07-30): **WebUI + Discord (public のみ)**。
work×sensitive が 1,000 枚超あり、質問文には元の場面が含まれるため、当初は
Discord へ出すのを public 判定の質問だけに限っていた。2026-09-03 の方針変更で、
矛盾質問以外は sensitive も専用の `genius` チャンネルへ配信する (§3.2)。

## 1. 穴の検出 (gap detection)

5 系統。いずれも既存データで測れる (④のみ計測の新規追加が必要)。

| # | `gap_kind` | 信号 | 検出方法 | 質問の型 |
|---|---|---|---|---|
| ① | `low-confidence` | 低 confidence | `confidence < 閾値` (既定 0.5) の active カード | 「この判断で合っているか」 |
| ② | `contradiction` | **矛盾** | ローカル埋め込みの近傍 (situation 類似) かつ judgment が食い違う組 | 「実際にはどちらでやっているか」 |
| ③ | `category-gap` | カテゴリー偏り | `card_categories` 別の active カード数が下位のカテゴリー | 「このカテゴリーの判断を 1 つ挙げる」 |
| ④ | `retrieval-miss` | **検索ミス** | クエリの top1 類似度が閾値未満 / 0 件 | 「この場面ではどう判断するか」 |
| ⑤ | `curation` | 棚卸しの操作 | WebUI で retire / visibility 降格されたカード (`clone_card_revisions`) | 「正しい判断は何か」 |

`gap_kind` は上表の 5 値の統制語彙とし、統制外は保存時に reject
(operations.md §1.1 の category と同じ fail-fast 扱い)。

優先度は ④ > ② > ⑤ > ① > ③。④ は実際に直面した場面、② は既存コーパスの誤りが
検索結果を汚している状態で、どちらも実需に直結する。

### 1.1 矛盾検出 (②) の判定

- 各 active カードについて、同一象限内で situation 埋め込みの近傍 top-k (k=5) を取る。
- `clone_vec` は situation / judgment / rationale の合成埋め込みなので流用しない。
  situation 単独の埋め込みは既存 `embedding_cache` を使って生成し、検出 run 中だけ
  SQLite の一時 vec table に載せる。永続 index を増やさないため、モデル変更時の
  reembed 正本を二重化せず、2 回目以降は content-addressed cache が再利用される。
- 類似度が `contradiction.situationSimilarityMin` (既定 0.85) 以上のペアについて、
  judgment の類似度が `contradiction.judgmentSimilarityMax` (既定 0.5) 以下なら矛盾候補。
- 候補は LLM に「同じ場面で相反する指示か」を判定させ、真の矛盾のみ質問化する
  (埋め込みだけでは「同じ場面の別側面」と区別できない)。
- 同一ペアは 1 度しか質問しない。`question_targets` は対象単位の行なので**ペア単位の
  重複排除にはならない** (片方のカードが別ペアで再登場しうる)。矛盾質問は
  `target_kind = "card-pair"`・`target_id = <2 つのカード id を昇順で連結>` の
  1 行を追加で持ち、この行で判定する。根拠表示用の個別カード 2 行は
  `card-context` として併記し、別ペアへの再登場を妨げない。

### 1.2 検索ミス計測 (④) の新規テーブル

`query_log` を追加する。**これは判断ではなく生のクエリ文なので扱いを分ける**:

- 列: `id`, `text`, `domain`, `visibility`, `categories` (JSON), `top_similarity`,
  `result_count`, `created_at`。
- 記録は loopback API / MCP / hook からのクエリすべて。
- **公開 export に含めない**。カード DTO にも出さない。WebUI の質問画面でのみ参照する。
- 保持期間は `queryLog.retentionDays` (既定 30) で、**サーバ起動時と ingest 完了後**に
  期限切れを削除する。無期限保持はしない (生のクエリ文が溜まり続ける面を作らない)。
  ingest 後だけだと ingest が止まっている間 (operations.md §4 の 10 日停止のような
  状態) に保持期間が無制限に伸びるため、起動時の削除を必須にする。
- 記録失敗はクエリ本体の結果を覆さない (計測のためにクエリを落とさない) が、
  無言では捨てず stderr に出す。
- `spec/data/schema.md` の「データ分類と保護」表に `query_log` を
  「user / ローカル SQLite / loopback のみ・公開 export 禁止・保持期間付き」として
  追記する (スキーマ正本を片側だけ更新しない — operations.md §1.1 と同じ扱い)。

## 2. 質問の生成

- 生成は蒸留 backend (`claude-cli` 既定 / `ollama`) を使う。カード蒸留と同じ信頼境界。
- 入力は「穴の証拠」(該当カードの本文・矛盾ペア・クエリ文・カテゴリー名) のみ。
  絶対パス・sourceRef は渡さない (カード本文と同じ非転記ルール)。
- 出力 schema: `question` (訊く内容)、`context` (なぜ訊くのかの 1 行)、
  `category` (統制語彙)、`domain`、`visibility`、`gapKind` (§1 表の 5 値)、
  `targets` (根拠カード id / query_log id)。
- `visibility` は**カード蒸留と同じ二重チェックゲート** (`LlmPublicCardGate`) を通す。
  疑わしきは sensitive。配信可否とは独立に分類を保持する (§3)。
- 1 回の生成バッチは `questions.maxPerRun` (既定 5)。ingest 完了後に起動する。

### 2.1 新規テーブル

- `questions`: `id` (TEXT PK / ULID), `question`, `context`, `category`, `domain`,
  `visibility`, `gap_kind`, `status` (`open|answered|dismissed`),
  `asked_at` (NULL 可 — Discord へ送った時刻。WebUI のみなら NULL),
  `answered_at` (NULL 可), `discord_message_id` (NULL 可), `created_at`。
- `question_targets`: `id` (TEXT PK), `question_id`, `target_kind`
  (`card|card-context|card-pair|query_log|category`), `target_id`。
  `card-context` は矛盾質問の表示根拠で重複可。それ以外は同じ対象を再質問しないため
  部分 UNIQUE index を張る。`category` はカードを持たないカテゴリー偏りの対象。
- `question_answers`: `id` (TEXT PK), `question_id`, `text`,
  `answered_via` (`ui|discord`), `answered_by` (回答者 / NULL 可 — §4),
  `card_id` (生成されたカード / NULL 可),
  `created_at`。1 質問に複数回答が付きうる (WebUI 修正・Discord の追記)。
- 3 テーブルとも `spec/data/schema.md` に列表を追記する (スキーマ正本を
  片側だけ更新しない)。

## 3. 配信と回答

### 3.1 WebUI (全質問)

Traceability ID: `SPEC-GENIUS-ACTIVE-QUESTION-QUEUE`

- 棚卸し WebUI (`/ui/`) に質問キュー画面を追加する。loopback 限定なので
  sensitive な場面もそのまま表示できる。
- 操作: 回答する / 却下する (`dismissed`、以後同じ対象を訊かない) / 後で。
- 矛盾質問 (②) は「どちらが正しいか」を選ぶ UI にし、選択で**負けた側を
  supersede または retire** する (retire/supersede は operations.md §5 の実装を使う)。

### 3.2 Discord (専用 Genius channel、Concordia 経由)

Traceability ID: `SPEC-GENIUS-ACTIVE-QUESTION-DISCORD`

当初は Concordia の既存 chat API で完結する想定で「Concordia 側の改修は不要」としていた。

**2026-09-03 に方針変更**: 質問を `consultation` (仕事の相談) と同じ面に出していたため、
作業の相談と見分けがつかず「答えるまで進められない問い」に見えていた。Concordia 側に
**Genius 専用の `genius` チャンネルを新設**し (LUDIARS/Concordia local PR #1234)、
専用色 `0x9b59b6` を割り当てて面ごと分ける。以降 Genius の送受信先はこのチャンネル。

**反映順序**: Concordia を先に反映すること。`genius` を受けられない Concordia へ配ると
`POST /v1/chat` が 400 になり質問が届かない (relay が warn を出すので無言では消えない)。

**Concordia 側の正本 (`src/api/chat.ts`) で確認済み**: 2026-08-09 に既存 chat API の
送受信契約を確認し、2026-09-03 に `genius` channel の追加を local PR #1234 で確認した。
現行契約は次のとおり:

- `POST /v1/chat` の `channel` enum に `genius` が存在する。
- 応答は `{ "message": { id, channel, author_label, ts, text, in_reply_to, ... } }`。
- **`id` は数値**。`questions.discord_message_id` は TEXT なので保存時に文字列化する。
- `GET /v1/chat?channel=&since=&limit=` が `{ "messages": [...] }` を返し、各要素が
  `in_reply_to` (数値または null) を持つ。返信参照は取れるので Discord 経路を有効にできる。

- 送信: `POST <notify.concordiaBaseUrl>/v1/chat`
  (`channel: "genius"`, `author_label: "Genius"`)。base URL は
  `notify.concordiaBaseUrl` (operations.md §4 で追加した設定) から解決し、
  ホスト/ポート/URL をハードコードしない (CLAUDE.md)。返る message id を
  `discord_message_id` に保存。
- 受信: `GET <notify.concordiaBaseUrl>/v1/chat?channel=genius&since=<ts>` を
  polling し、`in_reply_to` が `discord_message_id` に一致するメッセージを回答として
  取り込む。`in_reply_to` 相当の返信参照が取れない場合は Discord 経路を有効にしない
  (誤ったメッセージを回答として取り込まない)。
- **sensitive も `genius` チャンネルへ出す (2026-09-03 neco 指示で方針変更)**。
  従来は「public 判定でない質問は絶対に送らない」としていたが、その根拠は
  「Concordia の channel-archives は Genius 自身の Tier 1 ingest 元であり、送った内容が
  次回 ingest で public 側へ環流する」ことだった。**この根拠は `genius` チャンネルには
  当てはまらない**:

  - `genius` は Discord の **meta カテゴリ**配下に作られる (`ensureDiscordLayout`)。
  - Concordia の `archiveStaleChannels` は **sessions / archive カテゴリ配下のみ**を
    channel-archives へ書き出す (`targetCategories`)。meta カテゴリは対象外。
  - よって `genius` の内容はアーカイブされず、Genius の `channelArchivesDir` 経由の
    Tier 1 ingest へ環流しない。

  **この「環流しない」が sensitive を許せる唯一の根拠**なので、送り先チャンネルを
  変えるとき / Concordia のアーカイブ対象カテゴリを広げるときは、必ずこの前提を
  再検証すること。実装側も `SENSITIVE_ALLOWED_CHANNEL` で番人を残してある。
- 送信ペイロードには**質問文と context のみ**を含め、カード本文・sourceRef・絶対パス・
  query_log の生テキストは載せない (この制約は方針変更後も維持する)。
- 残る露出: sensitive な質問文そのものは loopback を出て Discord 上に載る (§0 のとおり
  質問文には元の場面が含まれうる)。環流とは別の論点として neco が受容した上での運用。
- public 限定にしていた頃は sensitive が配信されずキューに滞留し、`questions.maxOpen` を
  埋めて**新規生成ごと止めていた** (2026-09-03 実測: open 20/20 のうち 16 件が sensitive、
  17 件が一度も配信されていない)。visibility で配信対象を絞るのをやめることで解消する。
- Discord 経路が無効 (`notify.concordiaBaseUrl` が null、または
  `questions.discordEnabled` が false) の場合は WebUI のみで動く。
  起動時に「Discord 質問は無効」と 1 行出す (無言で片方だけ動かさない)。
- **矛盾質問 (②) は Discord へ出さない。** 解決には「どちらのカードが正しいか」の
  選択が要り、それは WebUI にしかない (§3.1)。出すと適用できない返信を誘発する。
- 返信の取り込み開始位置は「未回答のまま残っている質問の `asked_at` の最小値」から
  求める。`asked_at` は Genius の Unix milliseconds、Concordia の `since` は Unix
  seconds なので、送信時に秒へ切り下げる。カーソルを別に覚えないので、再起動しても
  取りこぼさない。
  - Concordia の現行 API は newest-first の `limit` のみで offset / `before` がない。
    Genius は 1 回 200 件に制限し、上限到達時は「古い返信を省略した可能性」を警告する。
    完全な pagination には Concordia 側の cursor 追加が必要で、無制限取得にはしない。

## 4. 回答 → カード

Traceability ID: `SPEC-GENIUS-ACTIVE-QUESTION-ANSWER`

### 4.0 判断者 (decider) — 誰の判断を採るか

neco 指示 (2026-09-03): 「セッション登録者と判断回答者が違う場合は Genius としては
不適切」。Genius は**特定の一人の判断のクローン**なので、別人の判断が混ざった
カードはコーパスとして成立しない。

- **ユーザー別に管理する**: `clone_cards.decided_by` / `question_answers.answered_by`
  に判断者を記録し、誰の判断かで絞り込めるようにする (migration 010)。
  コーパスの物理分割はしない — 識別できれば足りる。
- **現状は neco 以外の判断を採らない**: `questions.deciderDiscordUserId` に設定した
  1 人の返信だけを回答として取り込む。判定は Concordia が ingress で載せる
  `metadata.discord_user_id` で行う。**表示名 (`author_label`) は本人が変えられるので
  使わない**。
- 判断者以外の返信・投稿者を同定できない返信は**取り込まず warn を出す**。黙って
  捨てると、答えた側が「反映された」と誤解する。
- `deciderDiscordUserId` 未設定なら **Discord からの回答取り込みを行わない**
  (質問の配信は続ける)。起動時に 1 行出す。誰の判断か決まらないまま取り込むより、
  取り込まない方が安全 (無言で片方だけ動かさない)。
- 既存行は backfill しない。判断者不明のまま残す — 分からないものを誰かの判断だと
  決めつけない。

### 4.1 カード化

- 回答は既存の手動カード経路 (`POST /api/clone/cards` 相当のサービス) で
  `sourceRef: interview:<questionId>#<answerId>`、`confidence: 1.0`、category は
  質問の category、象限は質問の象限を継承して保存する。検索側の実装変更は不要。
  `clone_cards.source_ref` は UNIQUE なので、1 質問に複数回答が付いても衝突しない
  よう answer id まで含める (`<reader>:<id>#<anchor>` 形式は schema.md の既定に従う)。
- 回答文が判断カードの形 (situation / judgment / rationale) になっていない場合は、
  蒸留 backend で整形する。**元の回答文は `question_answers.text` に残す**
  (整形で意味が変わった場合に遡れるようにする)。
  整形・カード作成・矛盾の後始末が失敗した間は質問を `open` に保ち、同じ answer id
  から再試行できるようにする。回答を保存しただけで `answered` にしてはならない。
- 矛盾質問の回答は、勝った側を残して負けた側を supersede / retire する (§3.1)。
- ⑤ (棚卸し由来) の回答は、retire されたカードの置き換えとして新カードを作る。

## 5. cadence と運用

Traceability ID: `SPEC-GENIUS-ACTIVE-QUESTION-INGEST`

- 起動契機: Tier 1 ingest の完了後 (`completed` / `completed-with-errors` 双方)。
  ingest の run 通知と同じ経路に「質問 N 件を生成」を 1 行足す。
  - 質問生成は ingest の**後処理**であり、ここでの失敗は run の status を覆さない。
    警告として出すだけにする (質問が作れないことは ingest の失敗ではない)。
  - `completed` の run はこれまで通知を出していない。質問を 1 件以上作ったときだけ
    通知を出す — 何も作っていない clean run で通知を増やさず、作ったのに誰も
    知らない状態も作らないため。
  - query_log の保持期間削除もこの後処理で行う (§1.2 の「ingest 完了後」)。
- 上限: `questions.maxPerRun` (既定 5) / `questions.maxOpen` (既定 20)。
  未回答が溜まっている間は新規生成を止める (質問の山を作らない)。
- 却下された対象・回答済みの対象は再質問しない (`question_targets` で判定)。

## 6. 設定

`genius.config.json` に `questions` / `contradiction` / `queryLog` の 3 節を追加する
(`contradiction` は矛盾検出のしきい値、`queryLog` は §1.2 の計測設定)。既存の
loader 規約に従い、不正値は fail-fast。

```text
questions.enabled            既定 true
questions.maxPerRun          既定 5
questions.maxOpen            既定 20
questions.lowConfidenceBelow 既定 0.5
questions.retrievalMissBelow  既定 0.5
questions.discordEnabled     既定 true (notify.concordiaBaseUrl が null なら無効)
questions.deciderDiscordUserId 既定 null (未設定なら Discord 回答を取り込まない — §4.0)
contradiction.situationSimilarityMin  既定 0.85
contradiction.judgmentSimilarityMax   既定 0.5
queryLog.enabled             既定 true
queryLog.retentionDays       既定 30
```

## 7. タスク分割

| task | 内容 | 依存 |
|---|---|---|
| Q1 | `query_log` テーブル + クエリ計測 (API/MCP/hook 全経路) + 保持期間削除 (起動時/ingest 後) + `spec/data/schema.md` 追記 | — |
| Q2 | `questions` / `question_targets` / `question_answers` テーブル + 設定 3 節 + `spec/data/schema.md` 追記 | — |
| Q3 | 穴の検出 5 系統 (矛盾は埋め込み近傍 + LLM 判定) | Q1, Q2 |
| Q4 | 質問生成 (蒸留 backend + public 二重チェックゲート) + 上限制御 | Q2, Q3 |
| Q5 | WebUI 質問キュー画面 (回答/却下/矛盾の勝敗選択→supersede・retire) + 質問系 API の `spec/interface/api.md` 追記 | Q4 + WebUI |
| Q6 | Discord 経路 (Concordia chat 送信 + in_reply_to polling、矛盾質問は除外) | Q4 |
| Q7 | 回答 → カード化 (整形・sourceRef・矛盾の後始末) | Q5, Q6 |
| Q8 | ingest 完了後の起動配線 + 通知 1 行追加 | Q4, operations.md §4 |

Q1+Q2 (計測と土台)、Q3+Q4 (検出と生成)、Q5+Q7 (WebUI とカード化)、Q6 (Discord)、
Q8 (配線) の 5 PR 程度を想定。

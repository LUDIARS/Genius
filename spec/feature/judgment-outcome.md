# Genius 判断の outcome 記録と席タグ

status: implemented (MUSA バックログ S1-1〜S1-4、2026-10-16)
親: `E:/Document/Ars/spec/plan/2026-09-15-musa-backlog.md` S1 /
`E:/Document/Ars/spec/plan/2026-09-15-musa-processing-design.md` §7 (判断軸・9 席)
関連: `card-feedback.md` (カード評価)・`active-questioning.md` §3.2 (genius チャンネル)
Actio: `actio:101806d1-6a45-4454-9f50-f39fbfc3c800`

## 1. 目的

判断カードは「neco ならどう裁くか」の予想に使われる。予想の信頼度を測るには
**その判断を採った結果どうなったか**を記録し、席 (判断の役割) ごとに一致率を出す
必要がある (S5 Terpsichore の retro-lesson、S10 Calliope の「Genius 予想 + 的中率」の前提)。

## 2. outcome (S1-1)

Traceability ID: `SPEC-GENIUS-OUTCOME-RECORD`

1 枚のカードに 1 つ。書き直しは上書き (最後の記入者・時刻が残る)。

| 項目 | 列 | 意味 |
|---|---|---|
| 採用した判断 | `adopted_decision` | 実際に採った判断 (カードの judgment と違うこともある) |
| 実際の結果 | `actual_result` | 何が起きたか |
| 一致・不一致 | `verdict` | `match` / `mismatch` (統制語彙、CHECK 制約) |
| 記入者 | `recorded_by` | Discord user id 等 (decided_by と同じ 1〜64 文字) |
| 記入経路 | `recorded_via` | `api` / `ui` / `cli` / `discord` |
| 日時 | `recorded_at` | サーバ時計 (epoch ms)。呼び出し側は指定できない |

- migration 011 で `card_outcomes` を別テーブルとして追加する。`clone_cards` には列を
  足さない (outcome はカード本文ではないので、再埋め込み・supersede・公開 export に
  関わらせない)。
- **既存カードは null で読める**: 行が無いカード = 未記入。backfill しない。
  カード DTO (`GET /api/clone/cards` / `:id`) の `outcome` は null。
- retire / supersede 済みのカードにも書ける (判断の結果は退役後も的中率の材料になる)。
- outcome の本文は判断者の自由文なので、card-feedback の note と同じく
  loopback / アクセス制御済み front door の内側にだけ出す。公開 export に出さない。

### 2.1 card-feedback との関係 (重複させない)

| | card-feedback (`card-feedback.md`) | outcome (本 spec) |
|---|---|---|
| 誰が返すか | カードを**検索で引いて使った側** (AI セッション・サービス) | **判断者本人** (neco) |
| 何を表すか | カードがガイドとして効いたか (検索品質・カード品質) | 判断 (予想) が結果と一致したか (判断の的中) |
| 件数 | 1 枚に何件でも | 1 枚に 1 つ (上書き) |
| 使い道 | poor が閾値を超えたら自動アーカイブ | 席別の一致率 (§5)。**アーカイブには使わない** |

`mismatch` は「カードが悪い」ではない。当時の判断として妥当でも外れることはあり、
それを理由にカードを消すと的中率の母数が歪む。逆に `poor` は的中率に入れない。
両者は同じ DTO に並べて出すが、相互に読み替えない。

### 2.2 HTTP

| 経路 | 形 |
|---|---|
| `PUT /api/clone/cards/:id/outcome` | `{adoptedDecision, actualResult, verdict, recordedBy, via?}` → 200 + outcome。`via` は `api`(既定) / `ui` / `cli`。`discord` は relay 専用で HTTP からは 400 |
| `GET /api/clone/cards/:id/outcome` | `{outcome}`。未記入は `null` (200)、カードが無ければ 404 |

未知の verdict は 400 (無言で既定値に倒さない)。

## 3. 「結果は?」の後日配信 (S1-2)

Traceability ID: `SPEC-GENIUS-OUTCOME-FOLLOWUP`

### 3.1 対象

- active で、outcome が未記入で、まだ一度も訊いていないカード。
- 判断日 (カードの `created_at`) から `outcome.followupDelayDays` (既定 **14**) 日経ち、
  かつ `delay + outcome.followupWindowDays` (既定 7) 日より新しいもの。
  窓を設けるのは、導入時に既存の全カードへ一斉に「結果は?」が飛ぶのを防ぐため
  (窓より古い判断は WebUI / API / CLI から手で記入する)。
- 1 回の配信は `outcome.maxPerRun` (既定 3) 枚まで。古い判断から順。
- 1 枚につき 1 回しか訊かない (`card_outcome_followups` の主キー)。

### 3.2 配信

- 経路は補完質問と同じ **Concordia の genius チャンネル** (`ConcordiaQuestionChannel.post`)。
  Nuntius は使わない (obsolete)。genius は channel-archives の対象外なので Tier 1 ingest へ
  環流しない (`active-questioning.md` §3.2 の前提をそのまま使う)。
- 投稿に載せるのはカード id と、**public カードなら judgment の抜粋** (600 文字) だけ。
  situation / rationale / sourceRef / 絶対パスは載せない。sensitive カードは judgment も
  載せず、WebUI で本文を確認してもらう。
- 起動は ingest 完了後の後処理 (`IngestQuestionHook`) で、補完質問の relay とは
  独立に失敗する。手動では `genius outcome followup` で 1 回回せる。

### 3.3 返信の取り込み

- 自分が投稿したメッセージ id への `in_reply_to` だけを採る (同じチャンネルの
  補完質問への返信と取り違えない)。
- 判断者は `questions.deciderDiscordUserId` (補完質問と共有)。未設定なら取り込まない。
  別人の返信は warn を出して捨てる。
- 書式:
  - 1 行目が `一致` / `不一致` (英語 `match` / `mismatch` も可) で始まる。続けて結果を書いてよい。
  - `採用:` で始まる行 = 採用した判断。省略時はカードの judgment を採用したとみなす。
  - それ以外の行 = 実際の結果。
- 読めない返信 (一致・不一致が無い / 結果が空) は outcome にしない。follow-up は開いた
  ままなので、書き直した返信を次回拾う (推測で verdict を決めない)。
- 取り込み開始位置は未回答の最古の配信時刻 (秒へ切り下げ)。カーソルを別に覚えない。

### 3.4 無効化

`outcome.followupEnabled` が false、`questions.discordEnabled` が false、
`notify.concordiaBaseUrl` が null のいずれかなら配信しない。どれも起動時に理由を 1 行出す。

## 4. 席タグ (S1-4)

Traceability ID: `SPEC-GENIUS-SEAT-TAG`

### 4.1 語彙 (§7 の 9 席)

| 値 | 席 | 女神 (§7-H) |
|---|---|---|
| `quality` | 1 品質 (QA / 審美眼 / 表現判定) | Clio |
| `team` | 2+6 チームを回す | Terpsichore |
| `pm` | 3 PM | Thaleia |
| `adjuster` | 4 アジャスター | Euterpe |
| `engagement` | 5 エンゲージメント / KPI 予測 | Urania |
| `po` | 7 PO / プロデューサー | Calliope |
| `ad` | 8 広告 / 宣伝 | Erato |
| `architecture` | 9 アーキテクチャ + 物語 | Polymnia |
| `devops` | 10 DevOps / 運営 | Melpomene |

正本は `src/domain/seat.ts`。DB の CHECK 制約はここから組み立てる。

### 4.2 提案 (AI)

- 席も提案も無い active カードを判定バックエンド (`Classifier.choice`、purpose
  `seat-classify`) で 9 席 + `none` のどれかに分類し、`card_seat_proposals` に
  `proposed` で残す。`none` = どの席の判断にも当たらない (趣味・雑談・手順記録など)。
- sensitive カードは `local-only` で判定する (categorize と同じ送出規則)。
- 語彙外のラベルは提案にしない (失敗として数え、次回の生成で拾い直す)。
- 経路: `POST /api/clone/seat-proposals/generate {limit≤50}` / `genius seats propose [--limit]`。

### 4.3 確定 (人間)

- **カードに席が付くのは人間が確定したときだけ** (`card_seats`)。提案のままでは DTO の
  `seat` は null。
- `POST /api/clone/seat-proposals/:id/decision`
  - `{action:"confirm", decidedBy, seat?}` — `seat` 省略で提案どおり、指定で別の席、
    `null` で「席なし」を確定。
  - `{action:"reject", decidedBy}` — 席を付けない。同じカードを再提案しない。
- 確定・却下できるのは `proposed` だけ。確定済みへの再操作は 409。
- `GET /api/clone/seat-proposals?status=` は一覧と `coverage`
  (active カード数 / 席あり / 席なし確定 / 確定待ち) を返す。バックログ S1-4 の完了条件
  「既存カードの 9 割に席タグ」はこの coverage で測る。

## 5. 席別の一致率 (S1-3)

Traceability ID: `SPEC-GENIUS-OUTCOME-STATS`

`GET /api/clone/stats/outcome?seat=&from=&to=`

- `seat`: 9 席のどれか。省略で全席。語彙外は 400。
- `from` / `to`: epoch ms か ISO 8601。**判断日 (カードの created_at)** で切る
  (`from` 含む・`to` 含まない)。`from >= to` は 400。
- 応答: `{seat, from, to, total, match, mismatch, matchRate, bySeat:[{seat,…}]}`。
  `matchRate = match / total`、記入 0 件は `null` (0% と「まだ無い」を混同しない)。
  `bySeat` は席の定義順、席の無いカード (`seat: null`) は最後。
- CLI: `genius outcome stats [--seat] [--from] [--to]`。

## 6. CLI

```
genius outcome set <cardId> --verdict match|mismatch --adopted <text> --result <text> --by <id>
genius outcome get <cardId>
genius outcome stats [--seat <seat>] [--from <iso|ms>] [--to <iso|ms>]
genius outcome followup
genius seats propose [--limit 100]
genius seats list [--status proposed|confirmed|rejected]
genius seats confirm <cardId> [--seat <seat>|none] --by <id>
genius seats reject <cardId> --by <id>
```

## 7. 受け入れ条件

- 既存カードは outcome / seat とも null で読め、migration 011 適用前のカードも壊れない。
- `PUT /cards/:id/outcome` で記入・上書きでき、未知の verdict は 400、無いカードは 404。
- 判断から 14 日経ったカードへ genius チャンネルで「結果は?」が 1 回だけ出て、
  判断者の返信で outcome が埋まる。読めない返信・別人の返信では埋まらない。
- `GET /stats/outcome?seat=` が席別の一致率を返す。
- 席の提案は人間の確定までカードに付かない。

## 8. 人間確認待ち (既定値を置いた決め)

- 後日配信の窓 `followupWindowDays = 7` と `maxPerRun = 3`。導入直後に過去分へ一斉配信
  しないための既定値。過去分を Discord で回収したいなら窓を広げる。
- 一致率の期間を **判断日** で切る (記入日ではない)。
- public カードの judgment 抜粋を genius チャンネルへ載せる (sensitive は載せない)。
  補完質問の「カード本文は載せない」規則の例外なので、不可なら抜粋を外す。
- 返信の「採用:」省略時はカードの judgment を採用したとみなす。
- 席分類の判定モデルは categorize と同じ安価なモデル (`distill.sensitiveCheckModel`)。
- 実データでの「配信・回収・記入まで 1 件通す」(S1-2 完了条件) と「既存カードの 9 割に
  席タグ」(S1-4 完了条件) は、サービス反映後に人間が行う。

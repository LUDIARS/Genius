# Genius → Elegantia アンチパターン登録

status: implemented (2026-10-17)
親: UX アンチパターン連携 共通設計 (2026-10-17 neco 指示。Elegantia / Augur / Revisor と分担)
関連: `clone-db.md` (蒸留)・`operations.md` §4 (ingest run の結果と通知)
Actio: `actio:81c334dd-e0e0-4838-ba54-d4c8cd68d772`

## 1. 目的

ingest で作った判断カードのうち、**製品の UX 品質基準・実装のアンチパターン**
(一般化できるもの。個人の状況判断ではない) に当たるものを、Genius に保存したうえで
Elegantia にも正式項目として登録する。人の承認は挟まない。登録した項目は Revisor の
レビュー観点・Augur のテスト項目の入力になる (各リポ側の責務)。

Traceability ID: `SPEC-GENIUS-ELEGANTIA-ROUTE`

## 2. 不変条件

- カードは常に Genius に保存したまま。Elegantia への登録はカードの写しで、
  判定・送信の成否はカードの保存に影響しない。
- **public かつ active のカードだけ**が判定・送信の対象 (`qualityRouteEligible`)。
  sensitive (local-only) のカードは outbox にも積まない。Elegantia は公開読み取り面
  (`GET /api/antipatterns`) を持つため。積んだ後に sensitive へ編集・supersede・
  retire されたカードは送信前に `skipped` にする。
- 判定は既存の `Classifier` ポートの `noul` を `purpose: "quality-route"` で呼び、
  `disclosure` はカードの visibility から申告する (`public` → `public`)。外部判定
  バックエンドへ出るかどうかは `DisclosureRoutedClassifier` が決める。
- 送信の失敗・判定の失敗は捨てない。outbox 行に `attempts` / `last_error` を残し、
  次回の ingest の flush が再試行する。stderr に 1 行警告を出す (カード本文・判定
  バックエンドの応答は載せない)。
- Elegantia のポートはハードコードしない。`genius.config.json` loader が Excubitor
  catalog 断片 (`${ARS_ROOT}/Elegantia/excubitor.catalog.yaml` の `code: elegantia`) から
  解決する。

## 3. 設定 (`genius.config.json` の `elegantia` 節)

| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | `false` | 連携の有効化。節が無い既存 config は無効で動き、起動時に 1 行明示する |
| `catalogPath` | `null` | catalog 断片のパス。null = config のあるディレクトリの隣の `Elegantia/excubitor.catalog.yaml` |
| `threshold` | `0.7` | yes とみなす Noul 確率の下限 (公開面へ出すので誤検知側に厳しく) |
| `timeoutMs` | `10000` | Elegantia への 1 リクエストのタイムアウト |
| `maxPerRun` | `50` | 1 回の ingest で処理する outbox 行の上限 |

- `enabled: true` で catalog が無い・`elegantia` エントリが無い・port が読めないときは
  ConfigError で起動を止める (無言で連携を止めない)。config に `port` は書けない (strict)。
- 解決した送り先は `http://127.0.0.1:<port>` (Elegantia の POST は loopback 限定)。

## 4. outbox (`elegantia_outbox`、migration 012)

| 列 | 意味 |
|---|---|
| `card_id` | PK。`clone_cards(id)` への FK (ON DELETE CASCADE) |
| `state` | `pending-classify` / `pending-send` / `sent` / `rejected` / `skipped` |
| `probability` | 判定の yes 確率 (判定後) |
| `elegantia_id` | 登録された Elegantia の項目 id (`sent` のときだけ非 null。CHECK 制約) |
| `attempts` / `last_error` | 失敗回数と最後の失敗 (`classify: <ErrorName>` / `send: <ErrorName>`) |

- カード本文は持たない。送信時に `clone_cards` から読み直す。
- 同じカードは 1 回しか積まない (`ON CONFLICT DO NOTHING`)。再 ingest で状態を巻き戻さない。

## 5. 流れ

1. `DistillationService` がカードを保存した直後 (新規・統合とも) に
   `SavedCardSink.onCardSaved(card)` を呼ぶ。既に保存済みの sourceRef に当たった
   ときも呼ぶ (冪等。前回の保存後に積めずに落ちた文書の再処理で漏らさないため)。
2. `ElegantiaQualityRouter.onCardSaved` は対象カードを `pending-classify` で積む。
3. ingest run の全ソース処理後、run を閉じる前に `IngestService` が
   `flush()` を呼ぶ。未処理行を古い順に `maxPerRun` 件まで処理する:
   - `pending-classify`: Noul 判定。`probability >= threshold` なら `pending-send` へ進めて
     そのまま送信、未満なら `rejected`。
   - `pending-send`: `POST /api/antipatterns`。201 / 200 (既存) で `sent`。
4. 並行 run の flush は直列化する (同じ行を二重に判定しない)。
5. run の結果 (`GET /api/clone/ingest/runs/:id`) に
   `elegantia: { registered, failed }` を載せる。null = 連携無効・連携導入前の run・
   flush 自体が失敗した run。`logs/ingest.jsonl` には `elegantia-flushed` (件数付き) /
   `elegantia-failed` を残す。flush の失敗は run の status を覆さない。
   失敗 run (`failed`) では flush を走らせない (次回の run が拾う)。

## 6. 送信ペイロード (`toElegantiaAntipattern`)

LLM で書き直さず、public 判定を通ったカード本文を決定的に写す。

| Elegantia | Genius カード |
|---|---|
| `sourceRef` | `genius:card:<card id>` (Elegantia の冪等キー) |
| `title` | `judgment` の 1 行目 (120 文字で切る) |
| `summary` | `rationale` |
| `detect` | `[situation]` |
| `fix` | `judgment` |
| `tags` | `tags` |
| `augur` | 常に `null` (計測指標は Elegantia のカタログ側で定義する) |

カードの `sourceRef` (取り込み元文書の場所) は載せない。

## 7. 受け入れ条件 (契約)

- C-8 catalogServicePort(catalogText, code): Excubitor catalog 断片から指定 code のサービスの port (1〜65535) を返し、エントリ・port が無い/重複する catalog は ConfigError で落とす
- C-9 toElegantiaAntipattern(card): 登録ペイロードの sourceRef は genius:card:<カード id> で、カードの取り込み元 sourceRef (文書の場所) を載せず、augur は null にする
- C-10 qualityRouteEligible(card): public かつ active (supersede・retire されていない) カードだけを Elegantia 判定・送信の対象にし、sensitive カードは対象にしない

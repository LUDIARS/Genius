# Genius 運用化設計 — 人間判断の自動化と棚卸し WebUI

status: draft (2026-07-30 neco 方針決定の反映)
親設計: `spec/feature/clone-db.md` (approved)

## 0. 背景と決定事項

運用化にあたり「人間の判断が必要な処理」7 項目について neco が方針を決定した
(2026-07-30)。本 spec はその決定を実装可能な設計に落とす。

| # | 処理 | 決定 |
|---|---|---|
| 1 | sensitive/public の最終判定 | LLM に委任。投機的実行スタイル (間違っていたら後から修正) |
| 2 | 蒸留 backend の選択 | 現状維持 (Claude/Codex = `claude-cli` 既定のまま) |
| 3 | サービス起動・再起動の判断 | LLM 判断。判断材料を**カテゴリーベースのカード**として供給 |
| 4 | ingest 失敗のトリアージ | エラーを気付く形で出し、LLM 判断でフォールバック |
| 5 | Tier 2 の budget | 全部 (budget 上限なし) |
| 6 | harness hook の配線 / 注入判断 | LLM 判断。使用時に **LLM がカテゴリーを渡してくる** |
| 7 | カードの棚卸し (supersede・整理) | WebUI で人間ができるようにする |

### 決定の解釈 (投機的実行 — 誤りがあれば修正する)

- **#3 と #6 の「カテゴリーベースのカード」**: カードに `category` 属性を追加し、
  検索側 (セッションの LLM・運用エージェント) がクエリ時にカテゴリーを明示して
  引く方式と解釈する。#3 はライフサイクル判断の知見を `ops-lifecycle` カテゴリーの
  カードとして蓄積し、再起動を判断する LLM がそのカテゴリーを照会する。
  #6 は「どのセッションに何を注入するか」を人間が配線設計するのではなく、
  各セッションの LLM が自分のタスクのカテゴリーを渡して能動的に引く。
- **#5 の「全部」**: Tier 2 (Claude/Codex 生 JSONL) は budget 制限なしで全未読
  ファイルを対象にする、と解釈する。増分カーソルがあるため定常運用では実質差分のみ。

## 1. カテゴリーベースのカード (#3, #6)

### 1.1 スキーマ

- `clone_cards` に `category TEXT NULL` を追加する (migration)。
  `spec/data/schema.md` の `clone_cards` 列表にも同時に追記する (スキーマ正本は
  spec 側にもあるため、片側だけ更新しない)。
- カテゴリーは**統制語彙**とし、**実行時の正本はテーブル `card_categories`**
  (`name PRIMARY KEY, description, created_at`)。初期セットは migration で seed し、
  蒸留プロンプト (`prompts/distill.md`) に埋め込む語彙リストは起動時に
  `card_categories` から生成する (プロンプトへ語彙をベタ書きして 2 つの正本を
  作らない — 追加カテゴリーがプロンプトに反映されず蒸留が旧語彙のままになる)。
  初期セット:
  - `impl-design` — 実装・設計判断
  - `review` — レビュー観点・指摘基準
  - `ops-lifecycle` — サービス起動・再起動・デプロイ判断 (#3)
  - `delegation` — Codex/Claude 委託の切り方・検証
  - `writing` — 記事・文体・対外表現
  - `data-privacy` — 秘匿・レダクション・公開可否
  - `workflow` — ブランチ/PR/worktree 等の作業手順
  - `general` — 上記に収まらないもの (既定)
- 統制外の値は保存時に reject (無言で general に落とさない — fail-fast 規約)。
- カテゴリーの追加は API (`POST /api/clone/categories`) と WebUI から可能。

### 1.2 付与

- 蒸留時: distiller の出力 schema に `category` を追加し、LLM が統制語彙から
  1 つ選ぶ。判定不能は `general`。
- 既存カード ~3,700 枚: 再蒸留はせず、本文 (situation+judgment) を安価モデルで
  分類する backfill バッチ `node dist/cli.js categorize --missing` を用意する。
  埋め込みは変更しないため再 embedding は不要。

### 1.3 検索

- `POST /api/clone/query` / `POST /api/clone/query-batch` に `categories?: string[]`
  を追加 (OR フィルタ)。未指定は従来どおり全カテゴリー。統制外の値は 400
  (query 側も無言で無視しない)。
- MCP tool `genius_query` に同引数を追加。セッションの LLM が自分のタスクの
  カテゴリーを渡す — これが #6 の主経路。
- `hooks/genius-supply.mjs` は stdin JSON (`{"prompt": "...", "categories": [...]}`)
  も受け付ける (従来のプレーンテキスト prompt は後方互換で維持)。
- `/api/clone/cards` 一覧・`/api/clone/export` にも `category` フィルタを追加。
- 上記の追加引数は `spec/interface/api.md` の一覧にも反映する。

### 1.4 #3 (ライフサイクル判断) の運用

- 再起動・起動の可否判断は従来どおり実行主体 (Excubitor / セッション) 側にあるが、
  判断材料として `ops-lifecycle` カテゴリーを照会する運用にする。
- 共有インフラの lifecycle 操作ルール (Concordia claim/release、本体フォルダ起動)
  は変更しない。Genius はあくまで判断カードの供給側。

## 2. sensitive/public ゲートの投機的実行 (#1)

- 現行実装 (蒸留時 LLM 分類 + 安価モデルの二重チェック + 疑わしきは sensitive)
  を**最終判定**とし、人間レビューを運用フローから外す。
- 誤分類の修正は事後修正で行う: WebUI (§5) と既存 `PATCH /api/clone/cards/:id`
  による visibility 変更。
- 昇格 (sensitive→public) 時のみ二重チェック (`LlmPublicCardGate`) を再実行する。
  **これは新規実装**である: 現行の `PATCH` は `CardRepository.preparePatch` で
  visibility をそのまま書き換えるだけで、gate は蒸留経路
  (`DistillationService`) からしか呼ばれていない。つまり今は API/WebUI から
  無検査で public 昇格できる。gate が sensitive と判定した場合は昇格を
  **拒否して 4xx を返す** (降格の無言実行はしない — 呼び出し側が結果を
  誤解しないため)。降格 (public→sensitive) は gate を通さず常に許可。
- 変更履歴が追えるよう、`PATCH` での象限変更は `clone_card_revisions`
  (id, card_id, changed_fields JSON, changed_by, changed_at) に記録する。
  `changed_by` は認証がないため呼び出し元識別子 (`ui` / `api` / `cli`) を入れる。
  カード本文の差分は保持しない (revisions 経由でセンシティブ本文が増殖しないため、
  変更された**列名**のみ記録する)。

## 3. 蒸留 backend (#2)

- 変更なし。`claude-cli` 既定を維持し、`ollama` への手動切替設計もそのまま残す。
- README の「外部送信できない素材は事前に ollama へ」の注意書きは維持する
  (運用者向けの注意であり、自動化しない)。

## 4. ingest 失敗の可視化と LLM フォールバック (#4)

現状の問題: 2026-07-20 の run が channel-archives の 1 文書で `run-failed` になり、
以後 10 日間誰も気付かず ingest が止まっていた。

- **ソース単位の隔離**: 1 文書の処理失敗で run 全体を fail させない。文書単位で
  エラーを記録して続行し、run 終了時に `completed-with-errors` 状態を導入する
  (握りつぶしではなく、失敗一覧を run 結果に保持する)。
  - これは `IngestRun.status` の union (`"running" | "completed" | "failed"`,
    `src/ingest/ingest-contracts.ts`) を広げる**互換性のある破壊的変更**である。
    `GET /api/clone/ingest/runs/:id` の消費側 (`GeniusHttpClient`・Timer
    Delegation の polling・`spec/interface/api.md`) を同 PR で追随させる。
    「`completed` 以外は失敗」と判定している箇所が残ると、正常終了扱いの run が
    エラー扱いになる。
- **気付く形で出す**:
  - run が `failed` / `completed-with-errors` で終わったら Concordia chat へ
    通知を POST する。**endpoint はハードコードせず `genius.config.json`
    (`notify.concordiaBaseUrl`) 経由で解決する** (ポート/URL ベタ書き禁止 —
    CLAUDE.md)。実際の通知経路 (パス・payload 形状) は Lictor/Concordia 側の
    正本を実装時に確認する。`null` = 通知無効だが、無言にはせず起動時に
    「通知は無効」と 1 行出す。値が設定されていて到達不能な場合は fail-fast
    (通知の握りつぶし禁止。ただし ingest 本体の結果は通知失敗で覆さない)。
  - **通知 payload に載せてよいのは run id・ソース名・失敗件数・
    エラー種別/メッセージ要約・リポジトリ相対の文書パスだけ**。文書本文・
    カード本文・絶対パス (個人パスを含む) は載せない。Concordia の
    channel-archives は Genius 自身の Tier 1 ingest ソースであり、通知内容は
    次回 ingest で DB へ環流する。センシティブ素材がここを経由して public 側へ
    回らないよう、本文の転記は禁止する (`spec/data/schema.md` 「ログへ本文を
    出さない」「source_ref/path を公開 export へ含めない」と同じ扱い)。
  - Excubitor から拾えるよう、構造化エラーログを stderr/`logs/ingest.jsonl` に出す
    (既存 jsonl を継続)。同じ本文非転記ルールを適用する。
- **失敗文書の永続化 (カーソルとの整合)**: 現行のカーソルは
  `{mtimeMs, locator}` の単調な high-water mark (`src/readers/cursor.ts`) で、
  「run 全体を fail させる」現行挙動のおかげでカーソルが失敗地点より先へ
  進まず、再実行で必ず同じ文書に戻ってきていた。文書単位で続行するように
  変えると**カーソルが失敗文書を追い越す**ため、対策なしでは失敗文書が以後の
  増分 run で二度と読まれない — 「気付ける停止」を「気付けない取りこぼし」に
  すり替えることになる。したがって:
  - 失敗文書は run 結果 (メモリ) だけでなく**テーブルに永続化**する
    (`ingest_failures`: source, locator, mtime_ms, run_id, error_kind,
    error_message, resolved_at NULL)。本文は保存しない (§4 の非転記ルール)。
  - `--retry-failed` はこのテーブルを入力に、カーソルと無関係に該当 locator を
    再処理する。成功したら `resolved_at` を立てる。
  - `stats` / `GET /api/clone/ingest/runs/:id` に未解決の失敗件数を出し、
    「失敗を抱えたまま `completed-with-errors` が続いている」状態が見えるように
    する。
- **LLM フォールバック**: 通知を受けたセッションの LLM が対処を判断できるよう、
  再実行手順 (`ingest --sources <failed> --retry-failed`) と判断指針
  (リトライ / 該当文書 skip / 人間へエスカレーション) を README に明記する。
  自動リトライは実装しない (判断は LLM、実行はコマンド)。

## 5. カード棚卸し WebUI (#7)

- Hono に `/ui/` を追加し、静的 SPA (ビルドレスの素の HTML+JS または Vite 静的出力)
  を loopback 限定で配信する (`src/server.ts` は `hostname: "127.0.0.1"` 固定)。
  認証なし・公開禁止は本体と同じ制約。
- ただし「認証なしの更新系 UI をブラウザに置く」ため、ブラウザ経由の
  クロスオリジン攻撃面が新たに立つ (ユーザが開いている任意のページから
  loopback の更新 API を叩ける)。最低限の対策を実装に含める:
  - CORS を追加しない (`Access-Control-Allow-Origin` を返さない)。
  - 更新系 (POST/PATCH) は `Content-Type: application/json` を必須にし、
    単純フォーム送信を弾く。
  - `Origin` ヘッダがある場合は loopback origin のみ許可する
    (既存の `loopback-url.ts` の判定を再利用できる)。
- 機能:
  - 一覧: 象限・カテゴリー・タグ・全文 (`q`) フィルタ、作成日/confidence ソート、
    supersede 済みの表示切替
  - 詳細: カード本文・sourceRef・supersede チェーンの表示
  - 編集: situation/judgment/rationale/tags/category の修正 (PATCH 経由)
  - 象限変更: visibility/domain の変更 (昇格時は二重チェック再実行 — §2)
  - supersede: 旧カードを選んで新カードで置き換える、または単純に非活性化
  - 手動カード追加 (sourceRef 重複チェック付き — 既存の重複排除仕様に従う)
- 新規 API は既存 REST の拡張のみで賄う (一覧ソート追加・supersede チェーン取得・
  categories CRUD)。DELETE は引き続き作らない。

## 6. Tier 2 全量投入 (#5)

- `ingest --tier2` の `--budget-files` 必須制約を撤廃し、未指定 = 無制限とする。
  明示指定した場合のみ上限として機能する (後方互換)。
- 撤廃対象は 4 箇所あり、**すべて同時に直す**。1 箇所でも残すと「無制限のつもりで
  上限がかかる」無言フォールバックになる:
  - `src/cli.ts` — `--tier2 requires --budget-files N` の throw
  - `src/api/routes/ingest.ts` — `budgetFiles is required when tier2 is true`
    (逆側の `budgetFiles requires tier2=true` は妥当なので残す)
  - `src/ingest/ingest-service.ts` — `Tier 2 ingest requires an explicit
    budgetFiles value` の throw、および**直後の `options.budgetFiles ?? 500`**。
    この既定値を残したまま throw だけ外すと、未指定が無制限ではなく暗黙 500 件に
    なる。未指定は `undefined` のまま下流へ渡す。
  - `src/readers/batch.ts` — `requireBudget` の `Tier 2 requires budgetFiles`。
    `undefined` を「上限なし」として扱えるようにする (全件処理)。
- 併せて `--budget-files 500` をベタ書きしている運用面も更新する:
  `package.json` の `ingest:tier2-nightly` スクリプトと、README の Tier 2 節
  (`node dist/cli.js ingest ... --tier2 --budget-files 500` の記述)、および
  `src/ingest/concordia-run-notifier.ts` の `retryHint` が通知に載せる再処理
  コマンド (run 単位の Tier 2 失敗で `--tier2 --budget-files 500` を案内していた。
  残すと「再処理のつもりで 500 件だけ読む」無言フォールバックになる)。
  `spec/interface/api.md` / `spec/feature/clone-db.md` §4 の
  「`--tier2 --budget-files N` 明示時のみ処理」も追随させる。
- Concordia Timer Delegation の夜間 job を budget なしに更新する。
  初回全量は時間がかかるため、初回のみ手動実行で消化してから timer に乗せる。
  上限が外れることで 1 run の実行時間が伸びる点に注意し、timer 側の完了待ち
  タイムアウトを初回実測に合わせて設定する。

## 7. 運用タスク (コード外)

- Timer Delegation の実登録: 日次 Tier 1 (`ingest`) + 夜間 Tier 2 (全量)。
  完了条件は run polling で `completed` / `completed-with-errors`。
- Excubitor catalog (`excubitor.catalog.yaml`) の見直し。現状は `autostart: false`
  で、`restart_policy` キー自体が未設定 (= Excubitor 既定に委ねている) ため、
  落ちたら止まったまま。**要 neco 承認** — 共有インフラ lifecycle は自己判断しない。
- 未マージ PR のマージ判断: frontmatter fix (ingest 失敗の一因の可能性)。
  蒸留プロンプト calibration docs は 4dfc4cd で main に入っているため対象外。
  PR 番号は GitHub 側で要確認 (本 spec 執筆時の番号は当てにしない)。
- 本体フォルダの checkout を main に戻す (現在 `fix/frontmatter-nested-metadata`)。

## 8. タスク分割 (フルセット実装)

| task | 内容 | 依存 |
|---|---|---|
| T1 | migration: `category` 列 + `card_categories` + `clone_card_revisions` + seed + `spec/data/schema.md` 追記 | — |
| T2 | distiller: category 出力追加 + 統制語彙 validation + プロンプト語彙の table 由来化 | T1 |
| T3 | backfill: `categorize --missing` バッチ (安価モデル分類) | T1 |
| T4 | 検索系: query/query-batch/cards/export/MCP/hook の categories 対応 + categories CRUD API + `spec/interface/api.md` 追随 | T1 |
| T5 | ingest 隔離: 文書単位エラー継続 + `ingest_failures` 永続化 + `completed-with-errors` + `--retry-failed` + status union の消費側追随 (client/api.md) | — |
| T6 | 通知: run 失敗の Concordia chat 通知 (`notify.concordiaBaseUrl` 設定追加・payload の本文非転記) + README の LLM 判断指針 | T5 |
| T7 | Tier 2 budget 無制限化 (§6 の 4 箇所 + 既定 500 撤去) + npm script/README/spec 追随 | — |
| T8 | 棚卸し WebUI (`/ui/`) + supersede チェーン API + revisions 記録 + **PATCH 昇格時の二重チェック再実行 (§2 — 新規実装)** | T1, T4 |
| T9 | 運用: Timer 実登録・初回 Tier 2 全量・autostart 見直し (要承認) | T5–T7 |

T1–T8 は 1 PR に集約せず、T1+T2+T3 (schema/蒸留)、T4 (検索)、T5+T6 (ingest)、
T7、T8 (UI) の 5 PR 程度を想定。実装は Codex 委託可 (fmt 必須・grep 非依存の
テストを含める — 委託規約に従う)。

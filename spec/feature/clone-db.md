# Genius 本体設計 — 判断カード RAG (擬似 FT)

status: approved (2026-07-17 neco 確定)
決定済み: 独立サービス / 全象限ローカル埋め込み (Ollama bge-m3) / Tier 1 先行、
Tier 2 は夜間バッチで段階投入 / 真の FT は見送り (カードは将来の FT データセットに転用可)。

## 1. 目的

実装作業を始める AI エージェント (Claude / Codex) に「neco ならこの場面でどう
判断するか」を ~200ms で供給する。生ログ検索ではなく、蒸留済み**判断カード**の
ベクトル検索で返す。

## 2. アーキテクチャ (採用・目的・設計判断)

- **採用アーキ**: 単一 Node サービス (Hono, port 4230) + ローカル SQLite
  (better-sqlite3 + sqlite-vec) + Ollama 埋め込み (bge-m3, 1024 dim) +
  蒸留ワーカー (LLM backend 切替式)。
- **目的と重視点**: 高速参照 (クエリ ~200ms) / センシティブ情報の漏洩面ゼロ /
  増分で「育つ」運用。
- **設計判断**:
  - ベクトルは派生キャッシュ。**カード本文が正** (`model` 列を持ち再埋め込みで
    モデル移行可能)。
  - 埋め込みは全象限ローカル統一 — 実装分岐なし・分類ミスが漏洩に直結しない。
  - 蒸留は `claude -p` 既定 (既存運用 Fundamentum datahub / Anatomia と同じ
    信頼境界)。最機微素材向けに `ollama` backend (gemma4:12b) も設定で選択可。
  - 索引は sqlite-vec vec0 仮想テーブル。org 初採用 (既存はJSON総当りのみ)。
    参考実装: Anatomia `src/providers/openai-embedder.ts` (OpenAI 互換
    `/v1/embeddings` クライアント + content-addressed キャッシュ)。

## 3. 四象限モデル

2 軸フラグ: `domain: work|hobby` × `visibility: public|sensitive`。

| 象限 | 例 | 共有 |
|---|---|---|
| work×public | 設計判断・レビュー観点・規約思想 | datahub push 可 (手動承認) |
| work×sensitive | 顧客/学内事情を含む判断 | push 禁止 |
| hobby×public | 記事文体・ゲーム設計思想 | push 可 (手動承認) |
| hobby×sensitive | 生活ログ由来の嗜好・私事 | push 禁止 |

- 分類は蒸留時に LLM が付与。**疑わしきは sensitive に倒す**。
- public 判定カードは保存前に**センシティブ二重チェック** (安価モデルの
  blackbox 判定、Fundamentum datahub の push 検査と同型) を通す。
  falied → sensitive へ降格 (削除しない)。
- datahub push は本設計のスコープ外の運用 (将来 task)。push 経路の実装は
  しない — `visibility` フラグと export API (`GET /api/clone/export?visibility=public`)
  までを提供する。

## 4. データソースと Tier

| Tier | ソース | リーダ |
|---|---|---|
| 1 | memory MD (`sources.memoryDir`) | frontmatter+本文パース |
| 1 | session-logs MD (`sources.sessionLogsDir`) | MD セクションパース |
| 1 | Concordia channel-archives MD (`sources.channelArchivesDir`) | MD パース |
| 1 | Review 成果物 (`sources.reviewDir`) | latest.json + MD |
| 1 | Memoria API (`sources.memoriaBaseUrl`, 5180) — diary/notes/tasks | HTTP (読み取りのみ) |
| 2 | Claude transcripts JSONL (`sources.claudeProjectsDir`) | JSONL ストリームリーダ |
| 2 | Codex sessions JSONL (`sources.codexSessionsDir`) | JSONL ストリームリーダ |

- ソースパスは **`genius.config.json` (gitignore・ローカル) で宣言**。
  未設定ソースは ingest 時に明示エラー (無言スキップ禁止。`--allow-missing`
  フラグ指定時のみ「スキップした」と出力して続行)。
- **読み取り専用**。ソース側への書き込み・移動・削除コードを一切書かない。
- Tier 2 リーダも本実装に含める (No-MVP)。ただし既定の ingest 対象は Tier 1
  のみで、Tier 2 は `--tier2 --budget-files N` 明示時のみ処理 (新しい順)。
- 増分: `ingest_state` にソースごとのカーソル (最終処理 mtime/ファイル名) を
  持ち、再実行は差分のみ。

## 5. 蒸留 (distill)

1 ドキュメント (または JSONL セッション 1 本) → 0..N 枚の判断カード。

- 抽出条件: **反事実性のある判断** (別の選択肢がありえた場面で、どちらを選び
  なぜか) のみをカード化する。単なる作業記録・事実列挙は捨てる。
- カード構造: `situation` (どういう場面か・一般化して書く) / `judgment`
  (私ならこうする) / `rationale` (なぜか) / `tags` / 四象限フラグ / `confidence`。
- ゴールド標準: memory の feedback 系 (Why / How to apply 形式) をプロンプト
  例示に使う。蒸留プロンプトは `prompts/distill.md` として外部ファイル化し
  チューニング可能にする。
- 重複統合: 新カード埋め込みと既存カードの cosine > 0.90 (同象限内) なら
  LLM に統合判定させ、統合時は旧カードに `superseded_by` を張る (削除しない)。
- LLM backend 抽象 `DistillLlm`: `claude-cli` (`claude -p --model <m>`, 既定
  haiku 級) / `ollama` (ローカル chat)。設定不備は起動時 fail-fast。

## 6. 検索・提供面

- `POST /api/clone/query` `{text, domain?, visibility?, k=8}` →
  クエリをローカル埋め込み → vec0 検索 (象限 WHERE) → tier/confidence で
  再ランク → カード配列 + score。目標 p95 < 300ms (埋め込み込み)。
  - **waiver (2026-07-17)**: 本機 (GTX 1070) は Ollama の CUDA PTX 非対応で
    CPU フォールバックとなり実測 p95 = 555ms。検索部は <50ms でクエリ埋め込みが
    支配的。環境要因のため暫定許容し、性能テストは `GENIUS_PERF_P95_MS` で
    実測に合わせられる (既定 300 は GPU 時の目標として維持)。改善は Memoria
    タスク (GPU runner 更新 or 軽量埋め込みモデル検討) で追う。
  - **Memoria #553 対応 (2026-07-19)**: GPU (CUDA PTX 非対応) は環境要因の
    ままで恒久対応不可。軽量モデルは 1024 次元固定の clone_vec スキーマ
    (`VectorStore` が 1024 以外を拒否) を壊さずに使える代替が無く見送り
    (dim 変更は別途スキーマ移行が必要、本タスクの範囲外)。実装した対策:
    1. `OllamaEmbeddingClient` に `keepAlive` (Ollama `keep_alive`) を追加。
       この環境ではモデル unload 後の再ロードが GPU 経路をまず試みて失敗し、
       実測で単発 12.8 秒の詰まりを確認 (壊れた CUDA + 既定 5 分アンロード の
       組み合わせ)。`numGpu=0` 固定に加え `keepAlive` を設定すると回避できる。
       単発クエリの温間 p95 自体は変わらない (CPU 推論コストが支配的なため)。
    2. `QueryService.queryMany` / `POST /api/clone/query-batch` /
       `GeniusHttpClient.queryMany` を追加し、複数クエリの埋め込みを 1 回の
       Ollama 往復に集約。実測: 8 件バッチで 751ms/query (逐次) → 225ms/query
       (batched) = 約 3.3〜4倍/query (直近 3 回の実測: 730/222, 754/201,
       751/225 ms)。`evaluateRecallAtK` (recall eval) をこの API に載せ替え、
       ゴールドレコード全件を 1 往復で埋め込むよう変更 (既存の逐次 N 往復から)。
       単一クエリの API 経路 (`/api/clone/query`) は意図的に変更していない
       (人為的なバッチ遅延を注入しないため)。
    詳細は `spec/tasks/task-07-query-embedding-optimization.md`。
- CLI: `genius query "<text>" [--domain work] [--visibility public]`。
- MCP server (stdio): tool `genius_query` — Claude Code / Codex から直接引ける。
- ハーネスフック用スクリプト `hooks/genius-supply.mjs`: stdin にプロンプト
  文字列を受け、top-k カードを `[genius-supply]` ブロックで stdout に出す
  (fail-closed。手動/テスト用契約)。Claude Code UserPromptSubmit が渡す JSON
  payload (`{prompt,cwd,...}`) をそのまま解釈できないため、配線用アダプタ
  `hooks/genius-harness-supply.mjs` を別途提供する (`GENIUS_HARNESS_HOOKS=1`
  opt-in・タイムアウト付き・あらゆる失敗を fail-open)。Ars 側 `.claude` hooks
  への実際の配線は運用側で行う。本リポはスクリプト提供まで。

## 7. エラー方針・観測可能性

- fail-fast: Ollama 未起動 / モデル未 pull / 設定不備は起動時・実行時に明示
  エラーで停止。`catch {}` 禁止。
- ingest / distill はステップごとに `logs/` へ JSONL 実行ログ (処理ファイル・
  生成カード数・スキップ理由)。`distill_runs` テーブルにも集計を残す。
- 初期は verbose ログ (撤去 tracker は Issue 化)。

## 8. Codex 自己検証チェックリスト (PR 説明に結果を書くこと)

- `grep -ri "openai.com\|api.openai\|text-embedding" src/` → 0 件 (外部 embedding 不使用)
- `grep -rn "C:/Users\|C:\\\\Users" src/` → 0 件 (個人パスのハードコード禁止。パスは config loader 経由のみ)
- `grep -rn "catch {}\|catch (e) {}\|=> {})" src/` → 空 catch 0 件
- `ls data/ 2>/dev/null` → git 管理下に実データなし (`git ls-files data` = 0 件)
- vec0 仮想テーブル作成 + insert + KNN 検索の統合テストが sqlite-vec 実体で green
- `npm run typecheck` / `npm test` green

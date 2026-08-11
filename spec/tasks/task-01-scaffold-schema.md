# task-01 スキャフォールド + スキーマ + 設定 loader

kind: feature
status: done

## 内容

- TypeScript + Hono + better-sqlite3 + sqlite-vec + vitest の scaffold
  (`npm run dev/build/typecheck/test/migrate`)。SRP でファイル分割
  (config / db / migration / server 起動を別モジュール)。
- migration 01: `spec/data/schema.md` の全テーブル + インデックス
  (番号連番・冪等)。
- config loader: `genius.config.json` → 無ければ example 検出時に
  コピー手順つき起動エラー。env override (`GENIUS_PORT` 等)。null ソースの
  扱いは `spec/interface/api.md` どおり。
- `/healthz` (フロントワーカーの生存) と `/readyz` (Ollama / DB の準備状態)。

## Done 条件 (機械判定)

- `npm run typecheck` / `npm test` green
- `npm run migrate` 後、sqlite で clone_cards / clone_vec / embedding_meta /
  ingest_state / distill_runs が存在
- config 未配置起動 → 非 0 exit + copy 手順を stderr 出力

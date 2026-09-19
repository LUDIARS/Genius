<p align="center">
  <img src="docs/assets/genius.svg" width="100" alt="Genius logo" />
</p>

# Genius

過去の作業記録から **「この場面ならどう判断するか」** を引ける、自分クローン判断カード DB。

<p align="center">
  <a href="https://github.com/LUDIARS/Genius/actions"><img src="https://github.com/LUDIARS/Genius/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

---

ラテン語で **守護霊 / 生来の気質** を意味し、ローマで一人ひとりに付き添うとされた守護霊 Genius に由来する。
真の fine-tuning はせず、判断カード (場面・判断・理由) を top-k で注入する
**retrieval-conditioned judgment (擬似 FT)** で、AI エージェントに本人の判断傾向を持たせる。

---

## セットアップ

設計の正本は [`spec/feature/clone-db.md`](spec/feature/clone-db.md)。

設定・運用手順は用途別に [`spec/setup/`](spec/setup/) にまとめてある:

- [本体を起動する](spec/setup/setup.md) / [CLI・MCP・hook・WebUI](spec/setup/clients.md) / [Ingest の運用](spec/setup/ingest.md) / [保守とトラブルシューティング](spec/setup/maintenance.md)
- 全設定キー: [spec/setup/config-reference.md](spec/setup/config-reference.md)

---

## 解決する課題

AI コーディングエージェント (Claude Code / Codex など) に作業を任せるとき、以下が起きる:

1. **過去に下した判断を覚えていない** — 同じ論点で毎回聞き直すか、本人と違う判断をする
2. **判断の根拠が作業記録に散らばっている** — memory・セッションログ・チャット・レビューを横断して引けない
3. **個人的・機密な記録を外部に出したくない** — 埋め込みや検索を外部 API に任せられない

Genius は作業記録を判断カードに蒸留し、ローカル埋め込みで検索できる 1 つの SQLite に集約する。
エージェントには MCP / harness hook で関連カードだけを渡す。

---

## アーキテクチャ概観

```
┌──────────────────┐   read-only    ┌─────────────────────────────┐
│ 作業記録 (Tier 1) ├──────────────►│ Genius (HTTP/Hono)          │
│ memory / session │                │  - ingest (増分カーソル)     │
│ logs / chat /    │                │  - 蒸留 claude-cli | ollama │
│ review / Memoria │                │  - 埋め込み Ollama bge-m3   │
└──────────────────┘                │  - 四象限 + sensitive ゲート │
┌──────────────────┐                │                             │
│ 生 JSONL (Tier 2)├──────────────►│  Backend: SQLite+sqlite-vec │
│ Claude / Codex   │  夜間バッチ     │  Port: 4230 (loopback 既定) │
└──────────────────┘                └──────┬──────────────────────┘
┌──────────────────┐  genius_query (public) │
│ Claude / Codex   │◄───────────────────────┤ MCP / harness hook
└──────────────────┘                        │
┌──────────────────┐  /ui/                  │
│ 棚卸し WebUI      │◄───────────────────────┘
└──────────────────┘
```

## 主機能

| 機能 | 詳細 | 関連エンドポイント |
|------|------|-------------------|
| **F1. 判断カード検索** | ローカル embedding と sqlite-vec で top-k 検索。複数クエリは 1 回の Ollama 往復に集約 | `POST /api/clone/query`, `POST /api/clone/query-batch` |
| **F2. Ingest (蒸留)** | 作業記録を読み取り専用で走査し、判断カードへ蒸留。非同期 run、増分カーソル。Tier 2 は明示指定 | `POST /api/clone/ingest/run`, `GET /api/clone/ingest/runs/:id` |
| **F3. 失敗の隔離と再処理** | 1 文書の失敗で run を止めず `ingest_failures` に記録、`completed-with-errors` で終了。`--retry-failed` で再処理、失敗 run は Concordia へ通知 | `GET /api/clone/stats` |
| **F4. 四象限と公開ゲート** | `domain: work\|hobby` × `visibility: public\|sensitive`。疑わしきは sensitive。sensitive→public 昇格はサーバ側で二重チェック | `PATCH /api/clone/cards/:id` |
| **F5. カードのライフサイクル** | 物理削除せず、置換 (`supersededBy`) か置換先なしの retire (`retiredAt`) で非活性化。改訂履歴を記録 | `GET /api/clone/cards/:id/supersede-chain` |
| **F6. 棚卸し WebUI** | 象限・カテゴリー・タグ・全文で絞り込み、編集・supersede・retire・手動追加 | `/ui/` |
| **F7. エージェント供給** | MCP `genius_query` と UserPromptSubmit 用 harness hook。どちらも public 固定で `sourceRef`・内部 ID を返さない | `dist/mcp/server.js`, `hooks/` |
| **F8. 公開 export** | active な public カードだけを `sourceRef` 抜きで出力 | `GET /api/clone/export?visibility=public` |

死活は `GET /healthz` (生存のみ)、準備状態は `GET /readyz` (DB・Ollama・build 鮮度)。
全エンドポイントの body / response は [`spec/interface/api.md`](spec/interface/api.md)。

## 設計指針

- **埋め込みは常にローカル**: 全象限とも Ollama のみ。外部 embedding URL は設定時に拒否する
- **元データに触らない**: ソースリーダは読み取り専用。移動・更新・削除しない
- **実データをコミットしない**: `data/`・`logs/`・`genius.config.json`・`eval/gold.jsonl` は gitignore。テストは合成フィクスチャのみ
- **無言フォールバック禁止**: 設定不備・model 未 pull・backend 失敗は fail-fast。蒸留 backend の自動切替もしない
- **ローカル運用**: loopback (127.0.0.1) bind、認証なし。公開する場合は前段でアクセス制御し、origin を完全一致で許可する
- **LUDIARS スタック準拠**: TypeScript + Node 22 + Hono + better-sqlite3 + sqlite-vec、WebUI は素の HTML/CSS/ES modules

---

## セキュリティ境界

- 待ち受け先は `server.bindHost` (既定 `127.0.0.1`)。Genius 自身は認証を持たないため、
  `0.0.0.0` で公開する場合は **前段でアクセス制御が済んでいること** が前提
  (Cloudflare Tunnel + Access 等)。前段を迂回して listener へ直接届かないよう、
  host firewall または container network で遮断する。公開 bind 時は起動ログに 1 行出る。
- ブラウザからは loopback origin と `server.allowedOrigins` に **完全一致** で列挙した
  origin だけが通る。ワイルドカードやサブドメイン一致は無い。これはブラウザ経由の
  攻撃対策で、認証の代わりにはならない。
- クライアント (MCP / hook / eval) の接続先は loopback のみ。
- MCP と harness hook は public 固定で、`sourceRef`・内部 ID・時刻を除く安全 DTO だけを返す。
  sensitive 検索は loopback HTTP API / ローカル CLI の明示操作に限る。
- `claude-cli` 蒸留は Claude CLI の信頼境界へ原文を渡す。外部送信できない素材を
  ingest する運用では、事前に `distill.backend` を `ollama` に切り替える。Claude 実行時は
  tools・MCP・skills・session persistence を無効化する。

---

## クイックスタート

前提は Node.js 22+、npm、Ollama。既定の蒸留 backend を使う場合は認証済みの `claude` CLI も要る。

### 1. インストール

```bash
git clone https://github.com/LUDIARS/Genius.git
cd Genius
ollama pull bge-m3
npm ci --include=dev
cp genius.config.example.json genius.config.json   # PowerShell: Copy-Item genius.config.example.json genius.config.json
```

`genius.config.json` のソースパスをローカル環境に合わせて編集する
(キーは [設定リファレンス](spec/setup/config-reference.md))。

### 2. build とテスト

```bash
npm run build
npm run migrate
npm test
```

### 3. 起動

```bash
npm start            # build 済み成果物 (開発時は npm run dev)
curl http://127.0.0.1:4230/healthz
```

サービス起動は共有 worktree や実装セッションから行わず、Excubitor または人間がプロジェクト本体で行う。
port の正本は Excubitor catalog (example は 4230)。

### 4. カードを溜める・引く

```bash
node dist/cli.js ingest                                     # Tier 1 を非同期 ingest
node dist/cli.js query "判断したい内容" --domain work --visibility public -k 8
```

棚卸しは `http://127.0.0.1:4230/ui/`。エージェントへの接続は [クライアント接続](spec/setup/clients.md)。

---

## 開発規約

LUDIARS 共通規約に従う (SRP・1 ファイル 1 責務・エラー握りつぶし禁止)。変更は feat ブランチ + PR。
テストは `test/` 配下、実データを含まない合成フィクスチャのみ。

| 場所 | 内容 |
|---|---|
| [`spec/feature/clone-db.md`](spec/feature/clone-db.md) | 本体設計 (アーキテクチャ・パイプライン・四象限) |
| [`spec/feature/operations.md`](spec/feature/operations.md) | 運用化設計 (カテゴリー・公開ゲート・WebUI) |
| [`spec/data/schema.md`](spec/data/schema.md) | DB スキーマ |
| [`spec/interface/api.md`](spec/interface/api.md) | API / 設定ファイル |
| [`spec/test/test.md`](spec/test/test.md) | テスト戦略と recall 評価 |
| [`spec/tasks/`](spec/tasks/) | 実装タスク分解 (正本) |

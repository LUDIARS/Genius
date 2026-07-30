# Genius セットアップ

## 前提

- Node 22+ / npm
- Ollama (port 11434) + 埋め込みモデル: `ollama pull bge-m3` (このマシンは
  2026-07-17 pull 済み)
- 蒸留 backend 既定 = `claude-cli` (`claude` CLI がサブスク認証済みであること)

## 手順

```text
npm ci --include=dev
npm run build
```

PowerShell で local config を作成します。

```powershell
Copy-Item -LiteralPath genius.config.example.json -Destination genius.config.json
```

POSIX shell の場合:

```sh
cp genius.config.example.json genius.config.json
```

`genius.config.json` のソースパスを実環境に合わせて記入してから migration を実行します。

```text
npm run migrate
npm test
```

サービス起動はセッションや worktree から行わず、Excubitor または人間がプロジェクト本体で
`npm start` を実行します。開発時だけ `npm run dev` を利用します。起動後は config の port で
`/healthz` を確認します (example は 4230)。

```text
curl http://127.0.0.1:4230/healthz
```

## Excubitor catalog

登録候補は code `genius`, name `Genius (自分クローン判断カードDB)`, role `backend`,
port `4230`。catalog 登録は運用側 (Excubitor) で行う。登録後は Excubitor catalog /
ProcessMap を port と endpoint の正本とし、`genius.config.json` を一致させる。

## 初回投入 (Tier 1)

```text
node dist/cli.js ingest --sources memory,session-logs,channel-archives,review,memoria
node dist/cli.js stats
```

Tier 2 (生ログ 2.7GB) は budget なしで全量投入 (`spec/feature/operations.md` §6)。
初回は手動実行で backlog を消化してから夜間 timer に乗せる:

```text
node dist/cli.js ingest --sources claude-jsonl,codex-jsonl --tier2
```

処理量を抑えたい場合のみ `--budget-files N` で上限を明示する (未指定 = 上限なし)。

引数なし ingest は Tier 1 のみ。`--tier2` を付けて `--sources` を省略すると Tier 1 と
Tier 2 の両方が対象になる。日次運用、run status の確認、MCP/hook、backup、reembed は
repository の `README.md` を参照する。

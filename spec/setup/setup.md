# Genius セットアップ

## 前提

- Node 22+ / npm
- Ollama (port 11434) + 埋め込みモデル: `ollama pull bge-m3` (このマシンは
  2026-07-17 pull 済み)
- 蒸留 backend 既定 = `claude-cli` (`claude` CLI がサブスク認証済みであること)

## 手順

```
npm ci
cp genius.config.example.json genius.config.json   # ソースパスを実環境に合わせて記入
npm run migrate                                     # data/genius.db 作成
npm run dev                                         # port 4230
curl http://127.0.0.1:4230/healthz
```

## Excubitor catalog

サービス正本: code `genius`, name `Genius (自分クローン判断カードDB)`,
role `backend`, port `4230`。catalog 登録は運用側 (Excubitor) で行う。
起動はセッションから spawn しない (Excubitor / 人間)。

## 初回投入 (Tier 1)

```
genius ingest --sources memory,session-logs,channel-archives,review,memoria
genius stats
```

Tier 2 (生ログ 2.7GB) は夜間バッチで段階投入:

```
genius ingest --tier2 --budget-files 500   # 新しい順に 500 ファイル
```

# 自分クローン DB — 実現可能性定義 (2026-07-17)

依頼: neco
目的: 「作業用に高速参照される自分自身のクローン情報」データベースを作る。
過去の LLM 作業データ・Memoria ログ・AI ノートから「何かを実装する時、私なら
どう思うか」をベクタライズし、Claude / Codex が **FT (fine-tuning) 的な思考判断を
高速に再現**できるようにする。エリアは四象限 (仕事×趣味 / 公開×センシティブ)。

結論: **実現可能。** 既存資産 (Anatomia の EmbeddingClient、Lector のチャット
HTML パーサ、Fundamentum datahub のセンシティブ検査 blackbox、Memoria の
ローカル SQLite) を組み合わせれば、新規に発明する要素は「判断カード蒸留」と
「ベクトル索引」の 2 つだけ。主リスクは蒸留品質とセンシティブ象限の取り扱い。

---

## 1. 素材の棚卸し (実測 2026-07-17)

| Tier | ソース | 形式 | 量 | 性質 |
|---|---|---|---|---|
| **1 (蒸留済み)** | memory (`~/.claude/projects/E--Document-Ars/memory/`) | MD | 28 件 / 60KB | 判断記録そのもの。最高品質 |
| 1 | session-logs (`Ars/session-logs/`) | MD | 150 件 / 1.6MB | セッション終了時の残作業・判断 |
| 1 | Concordia channel-archives | MD | 562 件 / 15.5MB | チャンネル議論アーカイブ |
| 1 | Review 成果物 (`Ars/Review/`) | MD | 5,656 件 / 16.5MB | レビュー観点 = 「私ならどこを見るか」 |
| 1 | AI ノート (Notion) | Notion | 記事十数本 | 公開向け文体・思想。page id は memory 索引済み |
| **2 (生ログ)** | Claude Code transcripts | JSONL | 35,315 件 / 1.24GB | 対話全量。判断+文脈+結果を含むが超ノイジー |
| 2 | Codex sessions | JSONL | 8,601 件 / 1.45GB | 同上 |
| 2 | Concordia concordia.db | SQLite | 831MB | チャット/セッション/レポート主永続化 |
| 参考 | Memoria data/memoria.db | SQLite | 117MB | ライフログ・タスク・ノート・日記 (趣味/生活軸の素材) |

対話ログ合計 ≈ 2.7GB (テキスト実体 ≈ 1GB ≈ 250〜400M トークン相当)。
**Tier 1 だけで ≈ 6,400 ドキュメント / 35MB** — 既に人間可読に蒸留済みで、
即日ベクタライズ可能。Tier 2 は価値密度が低くバッチ蒸留が必要。

## 2. 既存基盤の適合性 (横断調査結果)

- **埋め込み実装**: LUDIARS 全体で実運用は Anatomia のみ
  (`Anatomia/src/providers/openai-embedder.ts` — OpenAI 互換 `/v1/embeddings`、
  ローカル Ollama 可、hash フォールバック、content-addressed キャッシュ付き)。
  そのまま流用可能な抽象がある。
- **ベクトル索引**: pgvector / sqlite-vec / faiss は org 内どこにも未採用。
  既存 2 実装 (Anatomia duplication ゲート、Discutere 休眠コード) は JSON 総当り
  cosine。→ 新規導入するなら Memoria の better-sqlite3 と相性のよい **sqlite-vec**。
- **チャットログのパース**: **Lector** が ChatGPT/Claude/Gemini の保存 HTML →
  `{role,text}` 構造化を既に担う (Memoria/Tirocinium 共用)。JSONL リーダの追加のみ。
- **センシティブ判定の前例**: Fundamentum datahub が push 時に **Haiku blackbox で
  センシティブ検査**を既に実装。象限分類 (公開/センシティブ) に同じ型が使える。
- **配置先の傍証**: Tirocinium DESIGN.md:63-68 が「embedding + vector search は
  **Memoria 側に持たせる**」と既に宣言済み (未実装)。今回の要件はこの白地を
  埋める形になり、org 設計と整合する。
- **Memoria 現状**: FTS5 すら無し・LIKE 検索のみ・embedding 依存ゼロ。
  基盤新設だが、個人データをローカル SQLite に置く器としては既に確立。

## 3. 「FT 的」の解釈と方式選定

真の fine-tuning ではなく **retrieval-conditioned judgment (擬似 FT)** を採る:
問い合わせ (今やろうとしている実装の要約) → 判断カード top-k 取得 →
プロンプト先頭に注入 → Claude/Codex が「neco ならこう判断する」文脈で動く。
Anatomia supply→verify がハーネスで文脈注入する型と同型で、フック配線の前例あり。

| 方式 | AI学習量 | 作業コスト | 目的達成度 | 主目的一致度 |
|---|---|---|---|---|
| **A. 判断カード RAG (擬似FT)** ← 採用 | 高 (蒸留=判断の言語化が資産化) | 中 (蒸留+索引+API) | 高。即時更新可・出典追跡可 | ◎ 「高速参照される DB」の文言どおり |
| B. 真の FT (ローカル LoRA) | 中 (重みは不透明資産) | 高 (学習基盤+再学習運用) | 中。更新のたび再学習、根拠不明 | △ 「DB」でなくモデルになる |
| C. 生ログ全文 RAG (蒸留なし) | 低 | 低 | 低。ノイズ 95% で判断が埋もれる | △ 高速だが「クローン」にならない |

B は将来オプション (蒸留済みカードは FT 用データセットにそのまま転用可能なので、
A を先に作ることが B の準備にもなる)。

## 4. 四象限データモデル

2 軸フラグ: `domain: work|hobby` × `visibility: public|sensitive`。

| 象限 | 例 | 保存 | 埋め込み | 共有 |
|---|---|---|---|---|
| 仕事×公開 | 設計判断・レビュー観点・規約思想 | Memoria SQLite | ローカル or API | datahub push 可 |
| 仕事×センシティブ | 顧客/学内事情を含む判断 | Memoria SQLite | **ローカル限定** | push 禁止 |
| 趣味×公開 | 記事文体・ゲーム設計思想 | Memoria SQLite | ローカル or API | push 可 |
| 趣味×センシティブ | 生活ログ由来の嗜好・私事 | Memoria SQLite | **ローカル限定** | push 禁止 |

- 象限分類は蒸留時に LLM が付与 (datahub の Haiku センシティブ検査と同じ blackbox 型)。
  疑わしきはセンシティブ側に倒す。
- **センシティブ象限のテキストは外部 embedding API に送らない**。方式は
  「全象限ローカル埋め込みに統一」が最も単純 (漏洩面ゼロ・実装分岐なし)。
  Ollama + 多言語モデル (bge-m3 等、日本語対応) で品質は十分。
- 公開象限のみ Fundamentum datahub 経由で PC 間共有可 (既存のセンシティブ検査が
  二重ゲートになる)。

### 判断カード スキーマ (案)

```
clone_cards:  id, domain, visibility, situation (どういう場面か),
              judgment (私ならこうする), rationale (なぜか),
              tags, source_ref (元ログへの追跡子), confidence,
              created_at, superseded_by
clone_vectors: card_id, model, dim, vector (BLOB, sqlite-vec)
```

`superseded_by` で判断の変遷 (昔はこう考えていた→今はこう) を表現。

## 5. パイプライン (4 段)

```
[収集] Tier1 MD 群 + Lector/JSONL リーダ (Claude/Codex transcripts)
   ↓
[蒸留] LLM が「場面/判断/理由」の判断カードへ変換 + 四象限分類 + 重複統合
   ↓
[索引] ローカル埋め込み (Ollama) → Memoria sqlite-vec
   ↓
[提供] Memoria API /api/clone/query (象限フィルタ + top-k)
       + MCP tool + ハーネスフック注入 (harness-supply と同列)
```

## 6. コスト・性能見積り

- **Tier 1 蒸留**: ~9M トークン入力。Haiku 級 or `claude -p` サブスクで即日・
  実費ほぼゼロ〜$10 程度。カード ~1〜3 万枚見込み。
- **Tier 2 蒸留**: 250〜400M トークン。Haiku 級実費 $300〜500、または
  ローカル/サブスクで時間課金ゼロ。**夜間バッチで段階投入** (新しい順・
  Ars 配下優先)。全量必須ではなく逓減リターン。
- **埋め込み**: カード 10 万枚 × ~500 トークンでもローカルなら実費ゼロ、
  数時間で完了。
- **検索性能**: sqlite-vec で 10 万件 top-k << 50ms。クエリ埋め込み込みでも
  ~200ms — 「高速参照」要件を満たす。フック注入なら体感ゼロ。
- **更新運用**: session-end / 日次 Concordia Timer Delegation で新規ログを
  増分蒸留 → クローンが「育つ」。

## 7. リスクと対策

1. **蒸留品質** (最大リスク) — 「判断」でなく「作業記録」を抽出すると死ぬ。
   → プロンプトで「反事実性 (別の選択肢がありえた場面)」を抽出条件にする。
   Tier 1 の memory/feedback 系 (すでに Why/How to apply 形式) をゴールド標準に
   蒸留プロンプトを較正してから Tier 2 へ。
2. **センシティブ漏洩** — 分類ミスで公開象限に混入。
   → 疑わしきはセンシティブ / datahub 押し出し時に既存 Haiku 検査で二重ゲート /
   公開 push は当面手動承認。
3. **ノイズ埋没** — Tier 2 全量を無差別投入するとカードが汚れる。
   → confidence 列 + Tier 1 由来を優先ランク。取得時は Tier 重み付け。
4. **埋め込みモデル固定化** — model 列を持ち、モデル更新時は再埋め込みバッチで
   移行可能 (カード本文が正、ベクトルは派生キャッシュ)。

## 8. 実装委託の切り方 (GPT-5.6-Ultra 向け、次フェーズ)

Cc タスクワークフロー (spec → Castra 指示書 → GPT 実装) に載せる。task md 分解:

1. Memoria `clone` ドメイン新設 — スキーマ + migration + CRUD API (SRP 分割)
2. sqlite-vec 統合 + 埋め込みクライアント (Anatomia openai-embedder 抽象の移植)
3. 収集リーダ群 — Tier1 MD / Claude JSONL / Codex JSONL / Lector 連携
4. 蒸留ワーカー — LLM 判断カード化 + 四象限分類 + 重複統合
5. 提供面 — /api/clone/query + MCP tool + ハーネスフック
6. 増分運用 — 日次バッチ + datahub 公開象限 push (手動承認付き)

蒸留プロンプト設計 (1 の前提) と品質較正は Claude 側 (このセッション系) が担当、
コード実装を GPT-5.6-Ultra へ委託するのが適性分担。

## 9. 未決事項 (ユーザ判断待ち)

- ホスト先: **Memoria 内モジュール (推奨)** vs 新規リポ切り出し
- 埋め込み: **全象限ローカル Ollama 統一 (推奨)** vs 公開象限のみ外部 API
- Tier 2 (生ログ 2.7GB) の投入時期: Tier 1 稼働後に夜間バッチ (推奨) vs 同時

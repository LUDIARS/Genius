---
type: feature
title: "課題発見判断カテゴリ (issue-discovery) — 人間の課題発見データの蒸留"
description: "card_categories へ統制語彙 issue-discovery を追加し、蒸留プロンプトに「人間が課題を提起した発言」をカード化する指針と例を足す。Concordia の director-issue-scout (課題スカウト) が前例照合に categories:[\"issue-discovery\"] で query する。2026-08-25 neco 指示。"
service: genius
status: implemented
related:
  - feature/operations.md
  - feature/clone-db.md
updated: 2026-08-25
---

# 課題発見判断カテゴリ (issue-discovery)

> 2026-08-25 neco 指示。「人間の課題発見データを蒸留して同様の行動をする」。
> Concordia 側の課題スカウト (Concordia spec/feature/director-issue-scout.md) が
> `POST /api/clone/query {"categories":["issue-discovery"]}` で前例照合に使う。

## 1. migration — 統制語彙への追加

新規 migration (`src/db/migrations/` の次番号。**未マージの並行ブランチに同番号の
migration が無いか確認してから採番する**) で `card_categories` へ 1 行追加する:

- name: `issue-discovery`
- description: `課題発見判断 — 問題の上流原因の指摘・将来リスクの提起・課題の起案`

003-category-cards.ts の seed と同じく `INSERT OR IGNORE` で冪等に入れる。
テーブル・カラム・トリガーの変更はしない (カテゴリ行の追加のみ)。
`migrations/index.ts` への登録を忘れない。

## 2. 蒸留プロンプトの指針追加

`prompts/distill.md` へ、issue-discovery カードの認識指針を追加する。語彙一覧は
`{{category-vocabulary}}` で実行時にテーブルから注入されるため列挙の変更は不要。
追加するのは**認識のための説明と例 1 つ**:

- 指針: 人間 (主に neco) が「問題そのもの」ではなく**課題を提起した発言**を
  issue-discovery としてカード化する。具体的には:
  - 表面の問題から上流原因を指摘した発言 (「X が失敗し続けるのは上流の Y が原因」)
  - 将来リスクを先回りして提起した発言 (「このままだと N 週間後に Z が破綻する」)
  - 新しい課題・目標を起案した発言 (「〜が課題」「〜する仕組みが要る」)
  - 逆に「それは課題ではない」と却下した判断も、却下理由ごとカード化する
    (課題スカウトが誤検知を破棄するのに使う)。
- situation には観測されていた表面の問題を、judgment には提起された課題 (または却下) を、
  rationale には上流・将来と結びつけた理由を書く、という対応を例で示す。
- 既存の例の形式 (JSON 例のフォーマット) に合わせ、例は 1 件だけ追加する。

## 3. 受け入れ基準

- [ ] migration 適用後、`card_categories` に `issue-discovery` が存在する (冪等)。
- [ ] `prompts/distill.md` に issue-discovery の認識指針と例が 1 件ある。
- [ ] 既存カテゴリ・既存例は変更されていない。
- [ ] テストは合成フィクスチャのみ (実データをコミットしない — CLAUDE.md)。

## 4. 運用メモ (実装対象外)

- migration はサービス再起動時に走る。マージ後は Genius の再起動 (Excubitor 経由・
  人間の担当) が必要。
- 反映後の ingest から issue-discovery カードが貯まり始める。前例が貯まるまで
  課題スカウト側の照合は「前例なし」で fail-soft に動く。

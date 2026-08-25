# 課題発見判断カテゴリの追加

## 目的

人間が提起した課題発見判断を `issue-discovery` として蒸留し、Concordia の課題スカウトが前例照合に利用できるようにする。

## 完了条件

- `issue-discovery` を冪等に追加する migration 009 が登録されている。
- 蒸留プロンプトに認識指針と合成 JSON 例が 1 件追加されている。
- migration の統制語彙テストに `issue-discovery` が含まれている。
- 設計書が `spec/feature/issue-discovery-category.md` に保存されている。

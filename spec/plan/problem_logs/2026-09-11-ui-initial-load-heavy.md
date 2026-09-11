# Genius初期表示の待ち時間

- Date: 2026-09-11
- Area: UI initial loading
- Status: fixed in working tree

## Evidence

利用者からViewerでGeniusを開くとハングするとの報告。稼働中サービスの読み取り調査ではHTML 65ms、stats 2657ms、categories 96ms (10件)、questions 435ms (20件)。ブラウザのハング自体は未再現。`StatsRepository.get` は同期SQLiteで複数の全件集計を実施し、UIは起動ごとにstatsと質問を自動取得していた。カード一覧の遅延取得は既に実装済みで、その回帰ではない。

## Fix

初回の自動通信をカテゴリーに限定。統計と質問は利用者の明示操作で取得し、統計取得は多重起動しない。未取得の統計を編集・選択後に勝手に読み始めない。読み取りには15秒の期限を設定し、既存のエラー表示と再操作を使う。書き込みの成否をタイムアウトで誤判定する変更は行わない。

## References and verification

Pfのproject一覧にGeniusは未登録。Anatomiaのproject一覧にも未登録のため、正本 `spec/feature/operations.md` のSPEC-UI-LAZY-LISTと `ui/app-controller.js`、`src/stats/stats-repository.ts` を照合した。

テスト未実行。審査では起動時stats/questions/cards未取得、統計明示取得と連打抑止、失敗後再取得、既存編集後の明示取得状態維持を確認する。実機でのハング解消は反映後に確認が必要。

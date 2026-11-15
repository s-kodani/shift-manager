# ADR 0049: 終了記録に基づく保守受付の回収

日付: 2026-10-12。WP-10／Q116〜117。[ADR 0047](0047-maintenance-admission-and-drain.md)の補強。製品条件は変更しない。

## 判断と実装

本体終了後のlease削除だけが失敗すると凍結できない。処理終了後に`completed_at`を別のD1書込みで保存してから解放する。通常成功は行を削除し、全要求の終了履歴を蓄積しない。追加のD1更新1回は、解放失敗時の証拠を残すためのコストである。終了は業務成功を意味せず、失敗した業務を成功へ変更しない。

並列書込みは`settledMaintenanceWork`で全件の終了を待ってから最初の失敗を返す。7つのprivate PoC処理の`Promise.all`を置き換えた。早期reject後の兄弟処理が書き込む間に終了記録を付けないためである。独立した`waitUntil`配送は従来どおり別leaseを持つ。

運営者だけが`DRAINING`の同じ保守ID・期待版で、終了記録のあるleaseを明示指定して`reclaim`する。最大40件、重複拒否、ID順のfingerprintを使用。D1 batchで版更新・receipt・種別／開始／終了時刻の監査保存・選択行の削除を原子実行する。未終了行の混在や欠落は全件拒否し、監査・削除のSQL失敗は全更新をrollbackする。最後の`maintenance_recovery_commit` INSERTのtriggerで件数と選択行の不在を検査し、監査／削除が0行に省略された場合も全rollbackする。replay／inspectも確定証拠を照合する。

`maintenance_lease_recovery`は回収行だけを保持し、操作と終了証拠を不変にする。所有処理の遅い解放は、同じlease IDの回収監査と確定証拠がある場合だけ0行を受け入れる。通常の二重解放・不明IDは拒否。reclaimは凍結・再開・計算を自動実行せず、実DO確認と稼働job／再検証0の既存freeze条件を維持する。

## 代替案・残る問題

期限削除、終了したはずという申告、DOだけの停止確認は採用しない。認証／DB／R2を更新するHTTP処理の終了まで証明できない。[Workersのduration説明](https://developers.cloudflare.com/workers/platform/limits/#duration)も接続中のHTTPに固定終了時間を提供していない。旧leaseや終了記録前の中断はNULLのまま保つ。

本対応は**終了を書けた後の解放障害**を解消する。終了記録前の異常終了の回収には、全書込み経路の隔離・残存実行の終了証明が必要で、未実装である。全復旧・RPO／RTO・G1／G2をこの部分の成功だけで合格にしない。

## 検証と移行

実施記録（過去の私有資料・公開対象外）に実ローカルD1／SDK、競合・rollback・全統合・securityを分ける。migration0028は過去receiptの全列を保持してactionを拡張し、旧leaseを未終了として分類する。SQLiteによる履歴移行と実Wrangler適用を確認した。公開型`@cloudflare/workers-types 5.20261012.1`、Wrangler 4.149.0、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)、[Workers実装指針](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)を確認した。

Cloudflare配備・計算0。migration0028・業務／運営者Worker・全書込み経路の版一致が移行の前提。最終一括計画（過去の私有資料・公開対象外）まで遠隔へ反映せず、定期backup有効化保留・30日保管を維持する。

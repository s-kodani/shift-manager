# ADR 0106: 計算の受付・取消・試行履歴を同batchで確定する

- 日付: 2026-10-14
- 状態: 採用・ローカル対象検証済み／Cloudflare未配備
- 対象: R-02／06、TS-API-01〜04・TS-REC-01〜02

実D1の18省略故障で、受付outbox／audit、取消operation／job／outbox／audit、claimのattempt開始、結果採用／失敗／古い入力／取消／再試行のattempt終了が部分保存された。受付と取消要求を同batch末尾で内容・scope・版・状態・配送義務・監査まで確認する。claim・終了・結果採用も同batchでlease・試行番号・開始／終了時刻・終状態・failureとmanifest／canonical auditの一致を要求する。

終了更新を省略して現leaseがactiveのままなら失敗とし、通常の古いlease／並行claim敗者の0行とは区別する。rollback後もactive jobが残り、新計算を許可せず、物理停止・故障修復を経て既存の回収経路へ戻す。試行上限3と停止先行、R2孤立objectの非採用を維持する。

正常な更新でもD1のmeta.changesはjobとattempt triggerの書込を合わせて2となった。従来のchanges===1はfalseを返していた。終了・結果採用はUPDATE RETURNING idの実対象行で判定し、triggerの変更件数に依存しない。[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)と[Prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)を参照し、最新取得済みWorkers型のbatch／resultsと製品型検査を使う。

計画（過去の私有資料・公開対象外）／結果（過去の私有資料・公開対象外）に修正前18失敗、修正後の正常成功判定7失敗・changes=2診断、最終225成功を残す。旧公開固定metadataの7専用ケースは既存実装で成功し、変更不要だった。schema・製品条件・solver／目的関数は変更しない。Cloudflareは最終一括、backup HOLD／30日を維持する。

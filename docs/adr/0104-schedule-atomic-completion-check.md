# ADR 0104: 公開と取消のcommit後の状態まで同batchで確認する

- 日付: 2026-10-14
- 状態: 採用・ローカル検証済み／Cloudflare未配備
- 対象: TS-API-01〜04、TS-OPS-05〜09、R-03／06

## 問題と判断

下書き・公開・固定解除・取消の23省略故障を実D1/R2で注入した。12件で部分保存や成功扱いが残り、11件は既存guardが拒否した。commit前のseal検査だけでは、最後のcommit INSERTやそのAFTER triggerによるhead／企業版／通知の省略を検出できない。

publicationCompletionGuardを共通化し、公開と取消の同batch末尾でversion／commit／現在のhead／検証head／企業版／audit／固定seal・digest・実assignment数を確認する。取消には受付effective head／承認通知／参加解除数の確認を加える。固定解除はrelease fact／commit／audit／企業版と検証headの更新、下書きはversion／head／audit／入力版とR2 manifestの一致を要求する。

fixedSourceStatementsの末尾にseal・digest・lock／exception数の確認も置く。新公開／取消と旧版metadata hydrationで同じstatement列を使い、seal INSERTが省略されてもmetadataだけを確定させない。旧版hydrationの専用実行は今回の26故障とは別の未確認範囲として残す。

false時は既存のabs(INT64_MIN)方式でSQL失敗にして全rollbackする。batch後の照会で欠落を見つけるだけでは途中factsが既に確定するため採用しない。R2は先行uploadしたimmutable orphanを保持し、同IDの修復・並行／遅延再送を維持する。schema／固定・休憩・取消条件・権限を変更しない。

## 実結果と限界

修正前115成功／12失敗。修正後125成功／2失敗は、既存テストのcommit位置／文数依存で失効注入が移動・未発動となったためで、実SQLをWeakMapで識別して修復した。派生検証headの3故障を追加し、最終対象130件成功。全体結果とnativeは実施記録（過去の私有資料・公開対象外）へ記録する。全制約の独立検証・実SDK停止・認証ブラウザー・遠隔D1をこのSQL故障で代替しない。

既存の[Cloudflare batch契約](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)と確認済みWorkers型5.20261014.1のAPIを使う。配備は最終一括へまとめ、Cloudflare追加配備／計算0・backup HOLD／30日を維持する。受付／却下／既読などは書込台帳（過去の私有資料・公開対象外）の次単位へ残す。

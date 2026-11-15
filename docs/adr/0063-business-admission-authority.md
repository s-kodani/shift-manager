# ADR 0063: 一般業務受付のSQL・保存・配送・チェック権限を失効可能にする

日付2026-10-13。WP-04／10・R-02・TS-API／REC。製品条件、計算予算、公開・取消条件を変更しない。

## 問題と判断

一般業務はD1だけでなくR2、Queue、独立checkerを利用する。認証用SQLの失効だけを流用すると、遅延した保存・配送・RPCが、受付の削除や再開の後に動く可能性がある。実行終了を開始時刻から推測せず、完了記録なしの受付を安全に失効させるため、業務用の権限範囲を追加する。

migration0031の`resource_guard=1`はFOREGROUND・guard_version1に限定する。値の変更は禁止し、旧受付・認証受付を後から昇格できない。運営者の既存`retire`が同じD1 batchでscopeを監査へコピーし、受付を削除する。監査とlive leaseのscope不一致はSQLで拒否する。失効は完了時刻の記録ではない。

- 業務SQLは同じtransaction内で受付・scopeを確認する。既に作ったstatementも、失効後と再開後に実行できない。
- R2は`etagDoesNotMatch: '*'`の条件付き新規保存に限定し、delete・multipartは渡さない。保存条件はawait前にコピーする。保存前後のSQL確認とD1の採用条件を組み合わせ、遅れた書込みは未参照objectに限定する。未参照objectの即時削除はせず、GCは別途安全性を検証する。
- Queueは厳密に検証したcompute／revalidation messageだけをコピーして送る。遅延・重複は既存のjob／入力版／試行番号の検査で処理する。送信後に受付が失効した場合、その応答を成功として返さない。
- 手動checker RPCに受付IDを渡す。DOはactive RPCを立ててからD1権限を確認する。遅延RPCは失効後にcheck fenceやprocessを作れず、確認と失効が競合した実行はfreezeのDO検査で止める。稼働・停止未確認・残るfenceは引き続き凍結を拒否する。
- HTTP後の配送は、受付済みforegroundのDB facadeを引き継がず、元bindingsと独自BACKGROUND受付を使う。その未終了受付は本変更の失効対象ではない。

メール再設定要求とAI説明は外部providerへの効果があるため、従来の完了必須受付を維持する。業務scopeは任意のfetchや追加providerの失効を保証するものではない。経路を追加する際は実際の外部効果と必要なadapterを再確認する。

## 代替・限定・証跡

開始時刻によるTTL削除、全受付をSQL guardだけで失効可能にする案は、残存実行の権限・物理停止を説明できない。R2の即時削除は、応答消失・並行採用の不確実な状態で、参照済みobjectを消す危険があるため採用しない。

`maintenance-leases-v3`でresource_guardを公開し、業務／運営者Worker・CLI・schemaを同じ版に合わせる。実施結果（過去の私有資料・公開対象外）と保守手順（過去の私有資料・公開対象外）を参照する。workerd D1／R2と制御Containerの検証を、実SDK・Cloudflareの物理停止証明へ拡張しない。Cloudflare追加実行0、最終一括・定期backup有効化保留・保管30日を維持する。

# ADR 0065: 配送用BACKGROUND受付を限定して失効可能にする

2026-10-13。WP-04／10・R-02・TS-API／REC。製品条件・計算予算・最大3attemptを変更しない。

## 問題と判断

Queue受信・HTTP後の配送・配送回復のBACKGROUND受付が終了記録前に中断すると、旧SQL・R2・RPCがまだ動く可能性があり、時刻だけで削除して凍結できない。既存guard_version1はFOREGROUNDだけに限定されている。この制約と旧監査を保持し、0032でBACKGROUND／guard_version0／resource_guard0だけにdelivery_guard1を追加する。既存行は0のまま、昇格・scope変更を拒否する。

信頼済みの呼出し先をQueue受信、compute／revalidationの配送、Cronの配送回復・SQL pruningに限定する。SQLは同じD1 batchで受付を確認し、R2は既存immutable adapter、Queueは厳密なcanonical messageのみ。DOのrunJob／runRevalidationに受付IDを渡し、activeRpcを持ってからD1を確認する。失効した遅延RPCはfence・processを作れない。入力／結果のSQL・R2とRPC前後も同じscopeを使う。DONE応答が遅れた場合も再確認し、失効後のackを拒否する。

DOの旧fence回復でも、新しい呼出し元のscopeを使う。物理停止確認後にだけ同じjobを回復し、停止未確認や古いSQL権限のまま結果・retryを採用しない。手動checkerのservice fence回復にもそのFOREGROUND scopeを渡し、raw DBへの回復書込みを残さない。

## 原子失効と互換性

既存retireの同じoperation／期待版／明示IDを使い、専用の不変delivery auditへ記録する。FGとBGを混在選択した場合も、状態・両audit・削除・合計件数commitが1transactionで確定する。audit silent skipは全rollback。失効は完了記録ではない。旧BG・外部provider・旧コードは昇格／retire対象へ追加しない。

inventoryはmaintenance-leases-v4でdelivery_guardを公開する。migration・業務Worker・運営者Worker・CLIを同版へ合わせる。old receiptのFK・値は保持する。最新コードを旧schemaのコピーへ直接つないで互換性があるとは扱わず、旧backupのschema upgradeと再開前照合の手順は残課題にする。

## 証跡と残る受入

実施結果（過去の私有資料・公開対象外）／事前計画（過去の私有資料・公開対象外）。D1／R2・DO storage／RPCと制御Containerの故障試験、actual local SDKの101人通常計算・公開・凍結／終了を区別する。実SDKでの失効・停止故障・処理中／配送中復元、元不在認証再発行、外部provider隔離、RPO／RTO・G0〜G2・現場受入は残る。Cloudflare追加0、定期backup保留・30日保管を維持する。

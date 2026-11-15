# ADR0108: 最終確認の架空fixtureと既存PoC所有台帳

- 日付: 2026-10-15
- 状態: 実装・ローカル検証／最終Cloudflare未配備

最終確認の通常API4jobには、準備時に計算を開始しない架空1人と101人のfixture、通常計算として受け付けたJ2だけの故障登録、観測・停止・資格情報廃棄が必要である。旧compute-startは新規計算を自動開始するため、そのまま最終driverへ接続しない。

PoC専用の`/__poc/final-fixture`と`/__poc/final-control`を追加する。外側tokenに加えてENVIRONMENT=poc・mail／AI disabledを要求する。1人は既存inputFixture、101人は既存registeredOperationalFixtureへ架空源を渡す。通常の製品ルーターからはimportしない。企業名を所有UUIDと結び付け、既存cancellation_probe台帳に識別schemaを保存する。既存の期限後cleanupを利用するため、その企業名形式を維持する。DB移行や通常製品仕様は追加しない。

owner・予定job IDを企業作成より先に保存する。応答不明／失敗した準備を再実行せず、同じownerを観測・廃棄する。初回変更を必要とする管理者・全スタッフの資格情報を返すが、初期パスワードを台帳・ログへ保存しない。後続の計算は通常APIのみで受け付け、準備入口はjob／outbox／Queueを作らない。

J2のRUNNING attempt1だけを既存compute_probeへ登録し、既存のowned interruption RPCを利用する。準備で登録したcompany／team／job IDと照合し、別jobを生成しない。稼働中のrelease／cleanupは拒否する。期限切れ・準備失敗・廃棄済みownerも読取でき、資格情報は既存の廃棄処理でenabled／session／passwordを0にする。

既存PoC cleanupのidle確認後にもjob受理が可能だったため、資格情報とowner閉鎖のD1 batch末尾でactive job／owner leaseを再検査する。0行の更新を成功として扱わず、競合時は廃棄全体をロールバックする。終了を通すために稼働jobを見なかったことにしない。

実施結果（過去の私有資料・公開対象外）。この選択はfixture準備の採用であり、4ケース全体の演習・実SDK故障・復旧・正式品質ゲート・Cloudflare合格ではない。架空101人の複雑な実源による通常品質は既存証跡と後続の同じfixture演習へ接続する。

# ADR0115: 最終4計算後の技術復旧を同じ実行へ接続する

2026-10-15追加：復旧後の配信資産照合（過去の私有資料・公開対象外）を接続した。sourceのasset manifestと本文を結び、targetは既存の認証反映・再開・fresh login後に同じSHAを確認する。改変で資格情報終了・元再開へ進めない。段階数・一度のbackup／restore・22業務応答・計算数は維持する。対象9／全補助165／security7成功であり、実SDK一括・Cloudflareの成功ではない。

- 日付: 2026-10-15
- 状態: 実装・制御transportでローカル検証済み。新しい全体SDK演習・Cloudflare未実行

最終Cloudflareの`run`は、既存4jobがVERIFIED・停止済みになった後に、元の通常HTTP文書取得、保守凍結、現行認証checkpoint、完成コピー、同じ隔離先への復元、SQL／R2／schema照合、認証反映、旧session拒否／fresh login、22本文SHA比較、先の資格情報終了、元の保守再開へ進む。既存のbackup・maintenance・schema・recovery-securityを使い、ソルバーの新規jobを復旧の代用にしない。

各段階を送信前にprivateな同じownerへ記録し、backup IDもexport前に固定する。既存IDを上書きする、応答不明のimport・認証・ログインを再送する、後続へ進む処理は追加しない。段階途中の不明／時間超過はUNCERTAINを残し、同じchild operationを読み取り照会する。全体の30分に復旧を含め、通常のsource cleanup・5分の終了確認は別に維持する。復旧失敗時の自動resumeは行わない。

初回変更後の4名の架空passwordが従来は消えており、復旧先の新規ログインに使えなかったため、送信前のprivate保存とsource cleanup時の削除を追加する。通常ユーザー・実データの資格情報を収集する機能は追加しない。cookie／password／認証hashをpublicな結果へ出さず、完成コピーと認証操作のhash資料はprivateに保持する。

本変更は実行の接続であり、正式レビュー・G0／G1・最終cohort凍結・遠隔合格を発行しない。制御したHTTP／サービスの試験と既存の実SDK復旧を区別し、新しい全体の実SDK演習を残す。実施結果（過去の私有資料・公開対象外）。製品仕様・ユーザーの範囲除外・定期backup保留・最後のCloudflare一括方針を維持する。

2026-10-15追記：復旧前の共通4job driverへ、所有する終端jobに2回ずつ制御envelopeを渡す遅延・重複配送検査（過去の私有資料・公開対象外）を接続した。実consumerのACK／retryとD1・R2の前後一致、idleを確認し、送信前receiptと再送拒否を維持する。Queue brokerの配送時間や物理ソルバーの追加試験とは区別する。製品仕様・計算回数・時間上限・独立レビュー要件は変更しない。

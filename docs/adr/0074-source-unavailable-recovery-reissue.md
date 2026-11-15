# ADR 0074: 復旧元不在時の確認済み認証・権限再発行

2026-10-14。R-02、TS-AUTH／REC、Q106〜108・Q116〜117。状態：技術・運用の限定実装。本人確認方法の実運用、全復旧・RPO／RTOの達成を確定しない。通常の製品仕様・権限と日常操作を変更しない。

## 選択した構成

[ADR 0060](0060-restored-authentication-reconciliation.md)の現行source checkpointを取れない障害では、古いbackupの認証・権限をそのまま復活させない。運営者が別途確認した本人・連絡先・現行権限の一覧と旧環境の隔離証跡を渡す専用machine APIを追加する。凍結した復元先・fresh restore UUID・保守版・backup ID・元／先DB IDを結び付ける。

CLIは利用者ごとに24 random bytesの一時パスワードを生成し、Better Auth 1.7.7のnative scryptをローカルで計算する。送信前にprivate handoffと所有IDを保存する。APIへ送るのはhashで、平文・メール・hashをreceiptや標準出力へ出さない。バックアップに存在するhashの再利用をサーバーの読取と更新batchで拒否する。任意hashから「実際の秘密がランダム」と自動証明する機能ではなく、専用CLIと信頼された運営者の手順を前提にする。

確認済み利用者だけをenabled／初回変更必須にし、明示した企業管理者・チーム権限だけを原子的に反映する。未確認者はban・disabled・資格情報と権限なし。旧session・reset token・legacy membershipを全削除する。復元内にない利用者や不一致のcompany／team／staff参照を拒否する。予定・勤務・公開・入力・スタッフ番号等の業務データは変更しない。

本人・権限確認と隔離の証跡はopaqueな受付番号だけを保存し、本人確認書類・自由文の個人情報は別の運営者管理へ置く。これは本人確認の自動化・実施証明ではない。元DBへ接続できないことだけを旧Worker／Queue／外部providerの停止証明にしない。元から復元先への書込経路を隔離できない場合は進めない。

## 再開と競合

migration0033は再発行専用の不変receiptと、checkpoint／再発行のどちらかを示すauthorization VIEWを追加する。元を凍結してcheckpointを取得したという架空の証跡は作らない。同じrestoreへの両方式・別ID再適用は拒否する。保守版・権限・旧hash再利用・集合照合・receiptを単一D1 batchで検査し、silent skipもrollbackする。再発行後もFROZENを維持し、別の明示resumeを要求する。

確認は復元凍結時刻以降・15分以内、一覧最大2000人・compact要求900,000 bytes、HTTP body1,000,000 bytesを実装上限とする。2000人の性能保証やCloudflareの公式上限ではない。外部認証providerが残る場合はこの経路を拒否する。一括再発行は1回の復元判断として行い、未確認者を後から同じreceiptへ追加するAPIは提供しない。必要な確認を終えてから一覧をprepareする。

応答不明は同IDのinspectへ進み、未発見だけで新しいPOSTを許可しない。確認済みのreceiptとprivate handoffを照合してから、本人確認済みの連絡経路で秘密を個別に引き渡す。実際の引渡し・利用者の受領は運営者の手順で記録する。COMMITTEDに限る明示retireでprivate handoffと要求内hashを終了し、以後は同IDの読取照会だけを維持する。未確定を終了させない。

## 復元互換性と限定

既存0027〜0032および現行0033のコピーをreviewed migration計画で現行0033へ移行し、元の全業務行・R2参照・凍結状態を保持する。旧計画の自動書換・不明なSQLの自動再送はしない。旧Worker／DO／providerの隔離、処理中／配送中の全復元、本番本人確認・引渡し、RPO／RTOは別の受入である。

手順・実施記録（過去の私有資料・公開対象外）を参照。Cloudflare追加配備・計算をせず、最終一括・定期backup保留・30日保管を維持する。

# ADR 0060: 復元した認証・権限は現行情報の照合後に再開する

2026-10-14補足：[ADR 0074](0074-source-unavailable-recovery-reissue.md)に元不在時の確認済み再発行を限定実装。以下の元不在「未実装」は先行記録で、現在も実別環境CLI・隔離／引渡し・全復旧の受入は残る。

日付: 2026-10-13。対象WP-01／10・R-02・TS-AUTH／REC。基点`097078bf036b0f53327aff777bc0bb0a368adb17`。製品仕様・勤務・公開の条件は変更しない。

## 問題と判断

SQLバックアップには取得時点のパスワード、権限、利用停止、初回変更フラグ、セッション、再設定トークンが含まれる。そのまま業務を再開すると、取得後の変更・権限取消・失効が巻き戻る。以前のローカル復元演習の「旧sessionの再利用」は新しい再開条件へ流用しない。

新しい復元先にはfresh UUIDの`RECOVERY_SECURITY_ID`を業務・運営者Workerの両方へ設定する。対応する不可変receiptが存在するまで、認証を含むAPI、運営者の企業発行、保守の再開を拒否する。コピーされた別の復元先のreceiptでは解除しない。通常環境の空文字は従来の経路を保つための設定であり、復元先で空にして制御を回避しない。生成したlocal profileはUUIDとconfigの一致を必須にする。

現行の認証情報を取得できる元をFROZEN・受付／計算／再検証0にし、専用運営者APIで全認証checkpointを取得する。元は反映完了まで凍結、または停止を維持する。checkpointの15分期限は実装上の上限であり、取得後に元で変更がないことを自動証明する機能ではない。信頼できる現行情報を取得できない障害では、この経路で再開せず、本人確認・権限再発行の別手順を整える必要がある。

## 原子的な反映

- 最新userのメール、メール認証状態、role／ban、credentialのハッシュ、access、company_admin／team_member／legacy membershipを固定schemaで取得する。MVPのcredential以外のproviderを拒否する。復元に存在しない最新利用者・企業・チームを自動作成しない。
- 復元した利用者のうち現行情報にない人はban・利用停止・初回変更必須とし、資格情報・権限を除く。最新権限が参照する企業・チーム・スタッフが復元にない場合は全反映を拒否する。
- 全旧sessionとverificationを削除する。実Better Authが発行した再設定リンクの失効と、初回変更前の業務拒否を対象試験で確認する。再設定リンクの試験はメモリ内の配送で、Resendへの送信ではない。
- D1の同じbatch内で、FROZEN／保守版／ID／無活動／期限を検査し、固定表を置換、各表の期待集合と実集合を双方向EXCEPTで検査する。0行・RAISE(IGNORE)を成功扱いにしない。abs(INT64_MIN)のSQL失敗で、途中の更新もrollbackする。[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)／[ADR 0059](0059-database-only-admission-retirement.md)。
- 保守版を1進め、migration0030の不可変receiptを残す。receiptはtarget DB・restore UUID・運営者principal・checkpoint digest・source版へ結び付ける。別操作への流用、更新・削除を拒否する。反映後もFROZENを維持し、別の明示resumeで再開する。
- checkpointは最大2000 users／accounts／access、権限各8000件・compact900,000bytes。reconcile要求だけ1,000,000bytes、通常の運営者要求は4096bytesを維持する。これは選んだ安全な処理上限で、Cloudflareの製品上限や本番全規模性能を証明した値ではない。

## 運用と代替案

CLIは新しい専用local環境だけを対象とする。checkpointと送信payloadはprivate directory0700／file0600に保持し、stdoutにはID・段階・件数だけを出す。資格情報ハッシュ・cookie・token・メール本文を証跡やGitへ入れない。送信前にDISPATCHEDを保存し、応答不明なら同じIDでinspectする。receipt不在だけで再送や新ID作成をしない。

旧sessionだけを消す案では古いパスワードや権限が復活する。全利用者を一律再発行する案は復旧元不在時の代替だが、本人確認・初期管理者の安全な引渡しを別途設計する必要がある。今回は現行情報を確認できる障害に限定し、前者で済ませず最新認証情報を原子的に反映する。

## 実施状態と残る作業

実施結果（過去の私有資料・公開対象外）を参照。コード実装、ローカル468統合・58運用・17native・security9検査成功、実復元の認証反映・明示再開・実ログイン・権限照合・資格情報終了まで確認した。commit／push後の最新CIは未確認。一般業務の異常終了受付、処理中・配送中の復元、元が利用できない復旧、全サービスのRPO24時間／RTO1時間、全UI／遠隔／G0〜G2は残る。Cloudflare追加配備・計算0、メール／AI送信0。最終一括・定期backup保留・30日保管を維持する。

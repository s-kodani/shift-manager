# ADR 0048: 専用ローカル環境での認証付き復元演習

日付: 2026-10-12。状態: 限定実装・ローカル試験済み。WP-10／TS-OPS／復旧受入。Cloudflareの最終受入・本番運用・RPO／RTO達成は未確認。

## 問題と判断

ユーザーの費用指定に従い、[保守制御](0047-maintenance-admission-and-drain.md)で取得したSQL＋R2コピーを、Cloudflare資源を作らず別の実workerd環境へ復元する。既存の遠隔復元を繰り返す案は最終一括検証まで保留する。SQLiteの単独読込や模擬認証だけでは、通常の認証・R2取得・Queues／DO／Containerの復帰を証明できない。

新しいlocal profileは、専用UUID配下のprivateなconfig・profileと、異なるD1 ID・R2名・Worker名・Queue名を持つ。保存先はそのconfig直下の標準ローカルstate。元DB指定、remote binding、env／account／dev.persist_to、外部DO接続、symlink、既存R2／DO／Queueの持込みを拒否する。復元receiptへconfig SHAと保存先を結び付け、再開・応答不明照会・最終照合時も同じ対象を要求する。遠隔profileの既存ガードと過去receiptは維持する。

SQL・R2の完全照合前にWorkerを起動せず、復元されたFROZENを自動解除しない。運営者が専用の保守操作で再開する。DO／Queue stateはコピーしない。稼働ジョブ・再検証・leaseを含む復元点を拒否し、終端の履歴と独立証明はD1／R2から復元する。

認証secretはSQL／R2パッケージへ含めず、ローカル演習用のprivateファイルから別途用意する。Resend・Workers AIはdisabledで、外部のメールAPIキーはコピーしない。同じ認証secretと復元時点のセッションによる復帰、別の新規ログイン、最後の全資格情報終了を区別して確認する。実障害での古い失効・権限変更・セッションの照合方針は残る。

## 実装中に発見した問題

migration0025の`leave_effective_head`／`leave_all_notice` VIEWが旧SQL準備ツールの許可形式になく、インポート前に停止した。VIEWを保持してテーブル・index・dataの後、triggerの前へ置き、全スキーマ・全行hashと外部キーの照合を維持する。形式を無条件に通す変更や、VIEWを削除した部分復元にはしない。同じ復元ID・空の対象で修正後に続行した。

## 実施結果と制約

実施結果（過去の私有資料・公開対象外）で75テーブル・2 VIEW・R2参照3件、認証付きの公開勤務／履歴／CSV／本人表示／通知、実Queues・DO・Containerによる復元後計算、元データの不変性と資格情報終了を確認した。新しいガード・VIEWの回帰を含む運用37試験が成功した。

架空1名・1か月・単発の演習。異常終了leaseの回収、活動中の状態からの復旧、失効情報の照合、故障・異条件・大規模の反復、独立した運営者、遠隔受入と現場評価は残る。30日保管・定期取得の有効化保留・確定製品仕様を変更しない。

2026-10-13後続判断：[ADR 0060](0060-restored-authentication-reconciliation.md)で、現在の復元先はfresh restore UUIDのreceiptまで再開不可とした。古いsessionの再利用は当時の観測に限り、現行再開手順では全旧session／tokenを失効させ、最新認証／権限を反映してfresh loginする。以前の復元成功を、認証照合の新演習・終了処理の完了へ読み替えない。

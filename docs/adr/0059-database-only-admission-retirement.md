# ADR 0059: D1専用の認証受付は書込み権限を原子的に失効させる

日付: 2026-10-13。対象WP-01／10・R-02・TS-AUTH／REC。基点`cad3046d703dc7827ac7f64faa48f83190b04720`。製品条件・勤務・公開の状態遷移は変更しない。

## 問題と判断

終了記録前に処理が中断すると、従来の受付行は凍結を止め続ける。時刻・HTTP切断・DOの計算停止だけでは、業務Workerの旧コールバックがD1へ書き込まないことを証明できない。全ての行を期限で削除する案は採らない。

D1だけで完結する認証経路に限り、受付の権限を全SQL操作の同じbatch内で検査する。運営者はその権限を明示失効できる。旧処理は生きていても、失効後のSQLは全体が失敗する。これは実行終了の推測ではなく、以後のD1操作を禁止する証明であり、`completed_at`を捏造しない。

対象はログイン・ログアウト・セッション取得・パスワード再設定の確定・本人の初回変更・access取得の固定allowlist。パスワード再設定メールの要求、一般の業務API、R2／Queues／Container、運営者の企業発行、Cron、旧版の受付は対象外。外部処理を含む未終了受付は、停止／隔離を証明する別の復旧作業として残す。

## 実装境界

- migration0029で`guard_version`を追加する。旧行と通常受付は0、保護した認証受付だけ1。登録後の昇格・降格は拒否する。
- リクエストごとにDB facadeを作り、Hono contextのenvだけを置換する。共有envやモジュール大域へ保存しない。
- prepare／bindを保持し、run／all／first／batchは原文とその受付の確認を同じD1 batchへ送る。別facade・生DBからのstatement、exec／raw／withSession／dump・未知のメソッドは拒否する。固定Better Auth 1.7.7の実adapterと実ログイン／変更で確認する。
- 確認は`SELECT CASE WHEN EXISTS(有効な受付) THEN 1 ELSE abs(INT64_MIN) END`。SQLiteの整数overflowで、失効時にbatch全体を中断する。0行の更新をSQL失敗と仮定しない。[SQLite公式のabs仕様](https://www.sqlite.org/lang_corefunc.html#abs)と[Cloudflare公式のbatch原子性](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)を根拠にし、実workerd D1で失敗・rollbackを確認する。確認専用の書込み行は増やさず、受付IDの索引検索とSQL1文が各DB操作へ増える。一般性能・課金額は未計測。
- 応答前にも権限を確認する。Better AuthがDBエラーをHTTP応答へ変換しても、失効503へ明示置換し、古いSet-Cookieを返さない。
- `retire`はDRAINING・保守ID・期待版・明示ID最大40件を要求し、未終了／FOREGROUND／guard_version1のみ選ぶ。版更新・専用receipt・失効監査・削除・最終commitを原子化する。監査は完了回収と別に保管し、古いIDの再発行を禁止する。
- 最終commitが黙ってスキップされても、SQLの最終確認でrollbackする。この保証は既存`reclaim`にも適用する。競合で状態更新0行の場合は409を維持する。
- 再送・応答不明は同じoperation IDを照会する。失効後の古い解放は専用commit証跡がある場合だけ受理する。OPENへ再開しても旧受付の権限は戻らない。

## 受入と残範囲

実施記録（過去の私有資料・公開対象外）に、遅延した実Better Auth変更、初回変更必須・新規ログインの復帰、混在選択拒否、版競合、途中失敗・silent skip、既存移行のFKとreceipt保持を記録する。

今回の変更は認証受付の失効を実装する。業務更新・計算／配送中の復元、古い失効／権限／sessionの復元後照合、旧Worker・資格情報・namespaceの隔離、RPO／RTO、全UI・実Cloudflare・G0〜G2・現場受入は未完了。Cloudflare検証は最終一括、定期backup有効化は保留、保管30日、Resend通常送信disabledを維持する。

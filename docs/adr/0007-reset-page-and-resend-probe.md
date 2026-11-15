# ADR 0007: 再設定画面とResend実送信の検証

日付: 2026-10-10。状態: 再設定画面・実送信試験の実装判断。実受信・リンクからの変更はユーザー確認とD1照合済み。送信元ドメインの採用判断は未完了。

## 背景

ユーザーがPoC Workerに `RESEND_API_KEY` を設定し、テスト送信先を指定した。シフト通知はアプリ内のまま、メールの用途はパスワード再設定とする。受信先アドレス・APIキー・再設定トークンをコミットや試験レポートに含めない。

## 判断

- `/reset` のHTML・CSS・ブラウザJSを同じWorkerから配信する。小さい認証画面に新しいフレームワークは追加せず、参照モックの配色を使う。業務画面は引き続きWP-05で接続する。
- メールのリンクを `/reset#token=...` とする。fragmentはHTTPへ送らず、画面起動後にURLから除去する。トークンは画面のメモリだけに保持し、POST本文でBetter Authへ渡す。再読み込み時はメールのリンクを開き直す。
- 公開するのは再設定画面・2資産と、Origin／容量／形式を検査する再設定POSTだけ。PoC操作、通常の認証・業務APIは既存のPoCトークンで保護する。
- 受信先は保護された試験リクエストから取得し、架空アカウントのメール配送だけに差し替える。架空ユーザーには企業・チームの所属を与えない。D1の試験マーカーは架空IDと期限だけで、受信先は保存しない。
- 送信元未定の間は、この明示的な試験だけ `onboarding@resend.dev` を使う。製品の `MAIL_DELIVERY` はdisabledを保持する。認証済みFromが決まったら製品設定へ反映する。
- Better Authの成功応答を配送成功の証明にしない。配送コールバックでResendの2xxを確認した場合だけ試験をacceptedと記録する。受信・リンク操作の成功は別の証跡を必要とする。
- Workerの送信は `redirect: manual` とし、3xxも拒否する。実際のworkerdでは `error` がRequest生成時に例外となった。公式Request文書の列挙だけで互換性確認済みにしない。

## 代替と残課題

Static Assets bindingによる配信は、製品画面全体の配信を組み込む際に再評価する。今回の3ファイルはText moduleとしてバンドルし、モックプレビューのsandboxを解除しない。既存メールのquery tokenとの互換性は今回不要で、実送信前にfragmentへ変更した。

実送信試験の失敗・明示終了時は架空ユーザー、資格情報、セッション、再設定トークンを削除する。期限切れの試験は次の試験開始またはPoC再設定POSTで掃除する。定期GCは未実装。ログイン／再設定メール要求の製品画面、公開時の濫用対策、認証済み送信ドメイン、実端末・復旧は残課題。

## 証跡・参考

実施記録（過去の私有資料・公開対象外）、[Resendのテスト宛先制限](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)、[Cloudflare Requestのredirectとヘッダーの注意](https://developers.cloudflare.com/workers/runtime-apis/request/)、Better Auth 1.7.7の `node_modules/better-auth/dist/api/routes/password.mjs` と `create-context.mjs` を確認した。

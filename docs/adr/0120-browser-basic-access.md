# ADR 0120: PoCの製品画面へBasic認証の入口を追加する

2026-10-15。ユーザーの「Cloudflare環境の画面へBasic認証でアクセスしたい」という依頼による変更。

`/app`、画面資産、許可済みの認証APIと登録済み業務APIに、ブラウザー標準のBasic認証を追加する。既存Bearer認証も検証用に維持する。`/__poc/*`、運営者の発行・保守API、未許可の認証APIをBasic認証へ開放しない。再設定リンクの公開画面・token検査は維持する。

共通のBasic認証はサイトへの入口である。個人のBetter Authログイン・初回変更・企業／チーム／本人権限を同じ製品ルーターで検査する。保守受付の前後で同じ入口検査を使い、認証前にD1へ受付を書かない。設定が不足する場合とPoC以外の環境はBasicを拒否する。

`BROWSER_BASIC_USER`／`BROWSER_BASIC_PASSWORD`をWorker Secretsへ保存する。比較は固定長SHA-256とtimingSafeEqualを使い、応答はno-store。Basicの拒否は401とWWW-Authenticate、管理APIへの不適切なアクセスは403とする。ブラウザーにはBearer tokenを渡さず、個人のsession cookieを引き続き使用する。

ブラウザーのBasic認証キャッシュはアプリのログアウトとは別である。共有端末ではプライベートウィンドウを使い、利用後にウィンドウを閉じる。入口と個人のパスワードを混同しないよう引渡し手順に明記する。

今回の配備は`--containers-rollout=none`のWorker更新1回に限定する。既存の稼働前確認を維持し、Containerのimage・instanceを更新せず、migration・計算・メール・AI・定期backupを実行しない。[Cloudflareのrollout説明](https://developers.cloudflare.com/containers/configuration/rollouts/)／[Basic認証例](https://developers.cloudflare.com/workers/examples/basic-auth/)。ローカル試験後に配備・管理者発行・ブラウザー確認をまとめる。

利用用アカウントは架空企業の初期企業管理者を既存operatorで1回発行する。過去の無効化済み試験アカウントを復活させず、既存の個人アカウントを変更しない。初回変更の必須状態を残して引き渡す。認証情報は端末内の0700 directory／0600 fileへ保存し、チャット・Git・通常ログへ載せない。

製品仕様・数理条件・MVP受入結果は変更しない。アクセス手順・結果（過去の私有資料・公開対象外）へ実施結果を記録する。

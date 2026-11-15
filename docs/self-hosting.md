# 自分のCloudflare環境へ配備する

技術プレビューの自己配備手順です。匿名で使えるデモや共有環境は提供していません。初期状態は共通Basic認証と個人ログインで保護され、私有PoC入口には別のBearer tokenが必要です。

## 対象と費用

利用者自身のCloudflareアカウントで、D1、非公開R2の入力bucket、Queue、Worker／Containerを用意します。Cloudflare側の契約・利用料金・上限を事前に確認してください。Containerはstandard-2相当・最大1を既定とします。追加のバックアップbucket／operator Worker名も設定に記録しますが、バックアップ定期実行は有効化しません。

ローカル品質ゲートを先に確認してください。配備と検証の対象・計算回数・時間上限、作成する資源・削除手順を作業前に記録します。通常環境を使い捨て検証に使わず、別の検証資源は失敗時も回収してください。

## 資源と非公開設定

`npx wrangler login`で利用者のアカウントへ認証します。アカウントIDを明示した環境で`wrangler d1 create`、`wrangler r2 bucket create`、`wrangler queues create`を使い、自分が所有する新規資源を作成します。各コマンドの`--help`で固定されたWrangler版の引数を確認してください。共有資源の自動作成・選択は行いません。

`infra/target.example.json`をリポジトリ外の非公開ファイルへコピーし、すべての例を自分の値へ変更して`chmod 600`にします。アプリ／operatorのoriginは、それぞれのWorker名と自分のworkers.devサブドメインに一致させます。対象ファイルは絶対パスで指定してください。

`appSecretsFile`は次のキーを持つ非公開JSONの絶対パスです。十分にランダムな値を端末内で生成し、`chmod 600`にしてください。秘密値をコマンド引数・Git・チャットへ直接書きません。

- `BETTER_AUTH_SECRET`、`POC_TOKEN`、`BROWSER_BASIC_PASSWORD`: それぞれ独立した32文字以上のランダム値
- `BROWSER_BASIC_USER`: 共通Basic認証の利用者名

`operatorSecretsFile`は独立した32文字以上の`OPERATOR_TOKEN`を持つ非公開JSONの絶対パスです。新規インストール時だけ生成し、既存環境では既存の秘密値を保持してください。CLIは指定した秘密値を配備するため、意図せず再生成するとログイン・セッションへ影響します。

## 初回配備

```sh
npm run remote -- --target /absolute/private/target.json render
npm run remote -- --target /absolute/private/target.json dry-run
npm run remote -- --target /absolute/private/target.json migrate --initial
npm run remote -- --target /absolute/private/target.json deploy --initial
npm run remote -- --target /absolute/private/target.json deploy-operator --initial
```

対象設定は既定で存在しません。プレースホルダー、URLの不一致、不適切なファイル権限は拒否します。初回migrationはアプリWorker不在と空DBを確認し、初回配備は同名Workerの不在を配備直前にも確認します。既存Workerに`--initial`を使うことはできません。

`render`は所有ディレクトリに設定を生成するだけです。`dry-run`はコード・イメージをローカル構築し、Cloudflareへ配備しません。配備は公開側のクリーンなGitコミットを使い、コミットと全追跡ファイルのSHA、対象設定、配備受付を端末内の`.cache/deployments/<UUID>`に記録します。

## 最初の企業管理者

対象設定を指定したシェルで次の操作を行います。prepareは端末内の準備、sendは作成済みの同じIDを送信します。自分の会社名・管理者名・メールをJSONの標準入力から渡します。

```sh
export SHIFT_MANAGER_TARGET=/absolute/private/target.json
npm run operator -- prepare < /absolute/private/company.json
npm run operator -- send <prepareが返したID>
```

`company.json`は`companyName`、`adminName`、`adminEmail`だけを持ちます。初期パスワードは返された非公開handoffファイルを端末内で開いて確認し、安全な経路で管理者へ渡します。ログイン後に必ず変更してください。応答不明時は新しいprepare／sendで再作成せず、同じIDの`npm run operator -- inspect <ID>`で照会します。

## 更新・確認・復旧

既存アプリの更新は`deploy`を`--initial`なしで実行します。ビルド前・配備直前のpreflightで実行中ジョブ・再検証・所有Containerを確認し、busyなら停止します。migrationも明示操作です。運用データの移行はバックアップ・互換性・保守状態を別に確認してから実行してください。

配備コマンドの成功はContainer内の実行確認ではありません。Workerの100%適用、Containerのrollout完了・イメージの同一性、認証、画面、架空の小規模計算1回と独立検証を上限付きで確認してください。`status`は実行状態を調べ、計算を開始しません。

秘密値・入力・SQLを含み得るログは非公開の所有ディレクトリだけに保存します。応答不明は`UNCONFIRMED_INSPECT_SAME_OWNER`として残し、自動再送しません。切り戻しても接続先DBやデータは元に戻らない点に注意してください。既存の復旧ライブラリは所有・凍結・入力版・hashの検査を維持しており、その拒否を削って通さないでください。

定期バックアップ・メール・AIは初回の提供範囲外です。使い捨て資源は名前・ID・接続先・共有参照・処理終了を確認してから削除し、一覧・個別照会で不在を確認します。停止や資格情報の無効化だけで削除完了にしません。

参考: [Wrangler環境とbindings](https://developers.cloudflare.com/workers/wrangler/environments/)、[Container配備](https://developers.cloudflare.com/containers/guides/deploy/)。

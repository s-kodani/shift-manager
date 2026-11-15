# Shift Manager

コールセンター・BPO向けのシフト管理Webアプリです。勤務条件・希望・需要から案を計算し、独立した検証器で検査してから管理者が公開します。

**開発者向けの技術プレビューです。** 実チームへの導入評価、すべての運用条件、複雑な500人条件の性能を保証するリリースではありません。履歴不足の案は参考案として扱い、公開を拒否します。必要人数の不足は必須条件違反と区別します。

## 主な機能と構成

- 企業・チーム・スタッフの権限、初回パスワード変更、アプリ内通知
- 勤務条件・需要・スキル・希望・研修／会議・勤務履歴の管理、CSV取り込み
- シフト計算、独立検証、手動編集・固定、公開、休暇・欠勤取消後の再配置
- Reactの画面、Hono／Better AuthのAPI、Cloudflare D1・R2・Queues・Durable Objects
- Python／OR-Toolsを別Containerで実行。Worker内で長い最適化を実行しません

## ローカルで始める

Node.js 22.12以上、npm、uv、Python 3.11、Dockerが必要です。Containerの受入対象はlinux/amd64です。Dockerはビルドや`npm run check`のdry-runでも使用します。Cloudflareのログイン・APIキー、Resend、AIの設定は不要です。

```sh
git clone https://github.com/s-kodani/shift-manager.git
cd shift-manager
npm ci --legacy-peer-deps
node scripts/init-local.mjs
uv sync --project services/optimizer --frozen --python 3.11
npm run db:migrate
npm run dev:ui
```

別ターミナルで架空の企業・管理者を作成します。

```sh
npm run ui:fixture -- start
```

`http://localhost:8787/app`を開き、端末内の`.cache/local-ui-fixture.json`に保存された資格情報でログインしてください。初回パスワードを変更して利用します。入力済みの勤務条件を確認し、必要な履歴を根拠付きで登録してから、計算・検証・公開へ進めます。資格情報を共有・コミットしないでください。

終了前に`npm run ui:fixture -- cleanup`を実行し、開発サーバーをCtrl+Cで終了します。cleanupはログイン資格情報を失効させますが、ローカルの架空の履歴は保持します。完全に破棄する場合は、サーバー・所有Containerの終了後に当該ローカル状態を削除します。[開発と回収](docs/development.md)も参照してください。

実SDK・Queues・Dockerを使う架空1人の専用環境は次のコマンドです。既存の8787番ポートを使う環境と同時起動しないでください。

```sh
docker pull cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8
npm run dev:bounded-sdk -- --staff=1 --process-profile
```

この環境は起動だけでは計算しません。出力された所有UUIDのfixtureを使い、終了はCtrl+Cで行います。回収結果と所有Container・イメージの不在を確認してください。

## 検証

```sh
npm run types
npm run types:backup
npm run types:operator
npm run check
npm run test:optimizer
npm run test:cancellation-native
```

セキュリティ検査は`npm run security:install`の後、`npm run security:check`を実行します。実イメージの検査方法・期限付きVEX・ツール依存overrideは[セキュリティ検査](docs/security.md)を参照してください。CIは配備せず、外部PRに運用資格情報を渡しません。

## 自分のCloudflare環境へ配備する

利用者自身のアカウント・D1・非公開R2・Queue・Worker名と秘密値が必要です。Workers／Containersの利用料金は利用者側で発生します。既定の接続先や共有デモはありません。

[自己配備手順](docs/self-hosting.md)に沿って非公開の対象設定を作成し、`npm run remote -- --target /absolute/private/target.json ...`を使用してください。設定なし・プレースホルダー・別アカウントへの要求は拒否します。通常環境のコード・DBを変更する操作は明示実行とし、応答不明時は同じ操作の記録を確認してから判断します。

## 仕様・貢献・ライセンス

[製品仕様](docs/shift_management_design.md)、[最適化モデル](docs/shift_management_optimization_model.md)、[検証方針](docs/shift_management_test_strategy.md)が仕様の入口です。過去の判断記録は当時の状態を示し、READMEの実行手順と最新の確定判断を優先してください。古い私有検証記録は公開対象に含めていません。

修正提案は[貢献手順](CONTRIBUTING.md)、脆弱性は[非公開の報告手順](SECURITY.md)に従ってください。製品コードの正本はこのリポジトリです。私有環境の設定・資格情報・運用記録は分離して管理します。

自作コード・文書・本リポジトリのオリジナル画像はApache-2.0です。第三者コードの権利は各ライセンスに従います。[LICENSE](LICENSE)、[NOTICE](NOTICE)、[第三者ライセンス](THIRD_PARTY_NOTICES.md)を参照してください。`private: true`はnpmへの誤配布を防ぐ設定で、ソースのOSSライセンスを制限しません。初回はソースと自己構築手順のみを提供し、公式バイナリ／Containerイメージや匿名公開デモは提供しません。

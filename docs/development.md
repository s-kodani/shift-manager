# 開発・検証・回収

READMEの手順はローカル専用です。標準の設定は架空の資源名とローカルDBだけを使います。`infra/.dev.vars`は端末内で生成され、Git・Containerビルドへ入りません。メール・AIは無効です。

## ローカルでの確認

`npm run dev:ui`と`npm run ui:fixture -- start`は画面・入力の小規模な確認用です。実Queues／Durable Objects／Container SDKの確認には、READMEの`dev:bounded-sdk -- --staff=1 --process-profile`を使います。起動時に表示される所有ディレクトリの`fixture.json`に資格情報があります。Dockerには余裕を持って6GiB以上を割り当ててください。

既存のポート・ソケット・Containerを流用したり削除したりしないでください。検証前に用途と所有範囲、終了方法を確認します。中断・失敗時は同じUUIDの記録を保持し、新規計算を反復せず状態を照会します。

## 終了と削除

UI fixtureはサーバー稼働中に`npm run ui:fixture -- cleanup`を実行してからCtrl+Cで終了します。これは資格情報の失効であり、データの削除ではありません。

専用SDK環境はCtrl+Cで終了し、出力されたUUIDの`artifacts/bounded-sdk/<UUID>/cleanup.json`を確認します。Container・optimizer／proxyイメージ・ソケット・資格情報の回収に失敗があれば、同じ所有記録とDocker一覧を照合して残存を解消します。共有イメージ・他の実行を一括削除する`docker system prune`は使いません。

不要な状態の完全削除は、プロセス終了と所有資源の不在を確認し、必要な証跡を保存してから、対応する`.cache/bounded-sdk/<UUID>`と専用の生成物だけを削除します。`infra/.dev.vars`は別の開発環境と共有していれば保持します。継続保持する証跡には用途・期限・担当を記録します。

## 品質と制約

`npm run check`は型・運用・API・クライアント試験とWorker／Containerビルドを行います。`npm run test:optimizer`は制約・独立検証・小規模正解比較、`npm run test:cancellation-native`は実Python checkerと状態遷移の境界を確認します。これらは実チーム評価、全画面E2E、500人条件の性能達成の代替ではありません。

公開前に新規cloneから実行し、私有環境の資格情報・状態・過去の証跡がなくても成功することを確認してください。製品ルールの正本と最新の判断記録を優先し、テストを通すために必須条件を弱めないでください。

# ADR 0009: Reactの業務画面と同一配信元のAPI接続

日付: 2026-10-11。状態: WP-05の部分実装。MVP全画面、G0／G1、500人表示性能、実端末の受入は未完了。

## 判断

保存した参照モックの配色、左ナビゲーション、カード、月間・日別・結果の共通タブを参照し、`apps/web/product`にReact／TypeScriptで業務画面を実装する。元モックのHTML・inlineイベント・デモの公開処理は移植せず、参照保存版を保持する。確定したQ&AとAPIの権限・状態を優先する。

既存のWorkers／Hono／D1／Better Authを継続し、Viteで静的アセットをビルドする。SSR・ルーターを持つフレームワークとCloudflare Vite pluginは今回は導入しない。既存WranglerとWorkers試験を保持し、認証後の画面に必要な構成から始める判断である。公開ページのSEO、SSR、細かな画面URL、500人の表の仮想化が必要になった段階で再評価する。ReactとViteの使用を、全候補の採用や性能達成と同一視しない。

Workerと画面は同じOriginを使う。`/app`と明示した`/app-assets/assets/*.js`／`*.css`だけをASSETS bindingへ渡す。`run_worker_first: true`で入口の検査を先に行い、PoCの認証ガードをアセット配信で迂回させない。HTML fallbackは無効。HTMLは静的な起動要素だけで、業務情報は認証したAPIから取得する。セッション・パスワード・入力データをlocalStorage／sessionStorageへ保存しない。CSP、no-store、no-referrer、noindex、nosniffを適用する。

## 画面の状態と境界

- 初回変更前は業務画面へ進めず、業務APIの拒否も保持する。再設定要求はResendの設定検査を通し、送信元未定の環境では送信できない旨を表示する。
- 保存・受付・取消は操作IDと入力版／試行を送る。不明応答では同じ操作を再確認する。版競合で新しい版番号だけに置き換えて旧フォームを自動上書きしない。明示的な再読込で最新入力を取得する。
- チーム・月の変更時は前の取得を中断し、取得世代で古い応答を拒む。月間・日別・結果は同じジョブと凍結入力を参照する。変更後は過去入力の案と表示する。
- ソルバー状態と独立検証状態を分ける。案なしを休日へ、未検証を不足0へ読み替えない。履歴不足の参考案は公開不可のまま。公開機能そのものは後続で実装する。
- 時間表示は分単位。30分の休憩や予定で60分の論理枠を分割し、切替の準備・移動7分も分けて表示する。直接必要人数の空欄と0、指定された係数の精度を保持し、丸めで保存を通さない。

## ローカル検証

製品・PoCのentryから読み込まない専用`local-ui-worker.ts`を用意する。loopback・ENVIRONMENT=local・秘密値の照合で固定した架空fixtureの発行／再配送／終了に限定する。資格情報はignoredの所有ファイルだけへ保存し、終了時に所属者の利用権・セッション・パスワードハッシュを無効化する。1時間経過したfixtureは次のローカルrequestで終了する。これは実運用の企業発行APIやデータ削除／R2 GCの実装ではない。

ローカルのアセット再ビルド・コード変更はWranglerの実行環境を再起動する。計算中の再ビルドを避ける。中断した所有fixtureは既存のジョブ・永続排他を通して同じメッセージを再配送する。CloudflareのQueues／Cronでの復旧証跡とは区別する。

実行結果と未検証事項は業務画面の実施記録（過去の私有資料・公開対象外）へ記録する。

## 参照

- [React: アプリを一から構築する際の選択](https://react.dev/learn/build-a-react-app-from-scratch)
- [Vite: 本番向けビルド](https://vite.dev/guide/build)
- [Workers Static Assets: bindingとWorkerの実行順序](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Containers: ローカル開発](https://developers.cloudflare.com/containers/guides/local-dev/)

# ADR 0053: 実ローカルSDKのDocker作成受付で資源上限を適用する

日付: 2026-10-12。状態: ローカル検証基盤。Cloudflare互換性・MVP受入・性能達成は別判定。

## 判断

認証付きHTTP資源試験（過去の私有資料・公開対象外）ではQueue配送・DO RPC／終了が制御adapterだった。既存の実SDK／ブラウザー成功例はDocker無制限で、起動時の資源上限を証明できない。実Queues／DO／Container SDK・製品Workerをそのまま使用し、専用ローカルDocker Unix socketで作成要求へ上限を付ける。

現在のWrangler 4.149.0／Miniflareの`dev.container_engine` schemaと実装を確認した。DOのローカルcontainer optionsはimageName／imagesで、instance_typeからDocker CPU／memoryへの適用はない。専用のlocal configでcontainer_engineだけを私有socketへ向ける。image buildと計算内容は変更しない。製品／PoC Workerと通常設定はこの受付をimportしない。

`scripts/run-bounded-sdk-local.mjs`は架空500人の新規D1／R2／Queue／Worker／DO名、私有secretとfixtureを生成する。既存8787と同じ所有prefixのコンテナがあれば停止する。fixture登録は業務関数で、全マスタのUI登録試験ではない。起動スクリプト自体は計算を開始せず、製品UIの計算ボタンを使用する。

## Dockerの受付・証跡

[Cloudflare公式のstandard-2仕様](https://developers.cloudflare.com/containers/platform/limits/)に対応する1 CPU・6 GiB・追加swapなしを、[Docker Engine API](https://docs.docker.com/reference/api/engine/version/v1.51/)のHostConfigで指定する。正確な私有Worker名・DOの64桁ID・proxy suffix、予期したimage名と実image IDを照合してからcreateする。起動前にinspectでRunning=falseとNanoCpus／Memory／MemorySwapを確認する。起動応答を実SDKへ返す前にhealthの全Python SHA・非root／shellなしとkernel cgroup上限を照合する。

SDK egress proxyは別image／別資源として記録し、ソルバーの上限・最大メモリへ数えない。SDKが作成前に未存在名をDELETEする場合は、その正確な所有名についてDockerでも404を確認し、実削除を行わず404を返す。存在する未所有オブジェクトは拒否する。作成応答で得た所有IDを削除後も保持し、遅れて到着するwaitにはDocker本来の応答を転送する。未知IDの書込み・他実行名は拒否する。HTTP attachのduplexは所有対象だけに限定する。

solver payload・認証secretをDocker受付ログへ保存しない。作成・上限・SHA・kernel観測・停止前状態・削除・拒否を私有UUIDの証跡へ記録する。所有SDKの実行／フェンス／processが終了したことを確認してfixture資格情報を無効化する。D1の501資格情報とenabled／session／password残数を照合し、私有secret／fixture／sessionファイル、Worker・socket・今回のコンテナを終了する。先行コンテナは停止しない。

## 代替案と限界

Docker CLIのimage確認・fixture生成・資源観測・終了も`--host unix:///var/run/docker.sock`へ固定する。Docker contextやDOCKER_HOSTによってHTTP受付と別のデーモンを操作しない。全500人の実測後に追加した固定であり、追加の専用コンテナの起動／全20 SHA／kernel上限／削除で確認する。500人実測ソースとcommit時ソースのSHAは実施証跡で分ける。

healthで起動後にdocker updateする案では起動時の上限を証明できない。制御adapterへの置換は実SDKの証明に使わない。Cloudflare追加試験は最後の一括へ残す。Docker CPU quotaは実Cloudflareの速度を再現せず、disk12GBは制限しない。proxy／workerd／ブラウザーはソルバーcgroup外で、ホスト負荷にも影響を受ける。

受付互換性の失敗と、制約検証・探索状態・配置品質を区別する。正本・通常120秒／通信150秒・全候補・固定の範囲を変えない。結果は実施記録（過去の私有資料・公開対象外）へ分離する。通常メールdisabled、backup30日・定期有効化保留を維持する。

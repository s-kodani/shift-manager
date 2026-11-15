# ADR 0050: 大規模計算のローカル資源制限

日付: 2026-10-12。状態: 検証基盤の採用。Cloudflare互換性・通常プロファイルの最終採用・性能目標達成は別判定。

## 判断

費用を抑えるユーザー指定に従い、無制限Dockerでの500人成功に続く資源リスクをローカルで確認する。現在の`infra/wrangler.jsonc`のstandard-2／max_instances=1を維持する。[Cloudflare公式仕様](https://developers.cloudflare.com/containers/platform/limits/)を2026-10-12に取得し、standard-2の1 vCPU・6 GiBをローカルDockerの`--cpus 1 --memory 6g --memory-swap 6g`へ適用する。追加swapは許可しない。

`npm run test:compute-bounded-native`は101人、500人の架空30分枠・暦月1か月を順に1回ずつ実行する。既存の3層ルール・月下限・役割・研修・分単位切替・固定例外・履歴と全候補を維持する。通常のmvp-joint-v1／v4、120秒探索予算、150秒のsolve＋別checkの通信期限を変えない。手書き比較案は独立検査・採点だけに使い、ソルバーへヒント・初期解として渡さない。最終評価は段階順に比較し、制約VERIFIEDと品質達成を分ける。

Docker inspectでCPU・メモリ・swapの適用と稼働を確認する。healthから全PythonソースSHAと非root・shellなしを照合し、古い再利用イメージを拒否する。kernelのmemory.current／memory.peak／memory.events／cpu.max／cpu.statを観測し、OOM、観測失敗、所有コンテナの終了を記録する。UUIDごとのディレクトリへ入力・テスト・資源証跡を保持する。失敗時はそのケースで止まり、UNKNOWN／失敗を自動再実行して置換しない。

## 代替案と限界

無制限Dockerは経路の接続確認には使えるが、資源上限の証明にしない。Cloudflareでの反復測定は費用方針に従って最終一括へ残す。CPU quotaは実CloudflareのCPU速度を再現せず、disk12GBもこの試験では制限しない。memory.peakはcacheを含むcgroupの最大値で、Pythonのプロセス高水位RSSと別の値。Mac Dockerの仮想化・他プロセスの負荷も影響する。

今回は準備済みsnapshot、実HTTP solve／別checkとworkerd D1／R2の通常保存・読取を確認する。登録・認証・実Queues／Container SDK・UI・固定再計算・公開後再配置の全経路は、この資源試験だけで完了扱いにしない。1回ずつの結果は異なる条件での反復・5分目標・G0〜G2・現場受入の代替にしない。

結果は実施記録（過去の私有資料・公開対象外）へ分離する。製品仕様、Cloudflareのサイズ・計算予算、バックアップ30日・定期有効化保留、通常メールdisabledを維持する。

# ADR 0045: 重い処理の排他を保ち、Containerのhealthへ並行応答する

2026-10-12。判断: PythonのHTTP輸送へ実装し、ローカルの実SDK／workerd／Dockerで限定確認。Cloudflare採用・資源／性能受入は未判定。実施記録（過去の私有資料・公開対象外）。

500人の通常計算後に別HTTP checkが500になった。直列の`HTTPServer`では計算中のDocker healthがタイムアウトし、遅れたGETでBrokenPipeErrorを観測した。OOMイベントは確認しておらず、明示停止のSIGKILL／exit137をOOMと扱わない。この観測だけで以前のCloudflare SOLVE／HTTP500の原因を確定しない。

`ThreadingHTTPServer`でhealthを別リクエストとして処理する。solve／check／benchmarkはプロセス内の同じLockで1件に限定し、競合時は待機列を増やさず503／BUSYを返す。DOの永続フェンス・権限・終了規則は維持する。応答にConnection: closeを付け、本文書込時の切断は二重応答・例外本文へ変換しない。モデル・独立チェッカーの判定・依存・v4／120秒・150秒通信期限・standard-2／max_instances=1は変更しない。

代替のhealth期限延長は、処理終了まで応答できない構造を残すため採らない。重い処理の無制限並列化も採らない。一般公開向けHTTPサーバーへの置換ではなく、既存のContainer内の私有HTTP輸送への限定変更とする。[Python公式のThreadingHTTPServerと接続制御](https://docs.python.org/3.11/library/http.server.html)を参照した。公開入口の認証・body上限・Containerへの到達制御はWorker側に置く。

修正後はソースSHAが一致する新イメージで、認証付き500人の通常ジョブが初回試行FEASIBLE／VERIFIED、公開15,500行・500人への通知・本人限定31行となった。healthは計算中も成功し、終了時の所有フェンス／プロセスはfalse。これはローカル1条件・1成功で、4.21GBの最大RSSを資源制限のないDockerで観測した。Cloudflare standard-2との互換性・反復品質は未検証。

ローカルWorkerのhot reloadではPythonイメージが古いままだった試行も失敗記録へ残した。Python変更後は停止確認→ローカルWorker再起動／イメージ再構築→全ソースSHA照合→計算の順にする。失敗したD1競合テストは、同じ版の実証明を直列取得し、更新直前で合流してD1更新だけを競合させる形へ修正した。実プロセスの排他とD1原子競合の検証を区別する。

追加Cloudflare実行は0。最終一括検証計画（過去の私有資料・公開対象外）へ未検証事項を残す。

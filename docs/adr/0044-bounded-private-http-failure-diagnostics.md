# ADR 0044: 私有Container検証のHTTP失敗を上限付きで分類する

2026-10-12。判断: 私有検証経路へ採用。実Cloudflareの前回HTTP500の原因、保存候補方式の通常採用・性能受入は未判定。[ADR 0042](0042-private-saved-candidate-cloud-probe.md)、実施記録（過去の私有資料・公開対象外）。

## 理由と範囲

前回の小規模Cloudflare試験はSOLVE／PROBE_HTTP_500までしか記録できず、同じ入力・イメージのローカル成功から原因を確定できなかった。ユーザーの費用方針に従い、追加のクラウド試行より先に、既知の応答形式を見分ける診断をローカルで整える。

`POST /__poc/optimizer-saved-benchmark`の認証・架空ID・上限・排他・停止規則を維持し、既存のphase／code／issuePathsに任意の`http`を追加する。成功応答、通常の業務計算・保存・公開、120秒設定、開始から150秒の通信期限は変更しない。新しい入力設定・自動再試行は追加しない。

HTTPエラー本文を最大4,096バイト・4,097読み取り・2秒（共有期限の残りが短ければその範囲）に制限する。空チャンクが続いて時計が進まない制御ストリームも読み取り回数で終了する。完了した本文だけを分類し、過大・読み取り失敗・時間切れは未認識とする。cancelの拒否・未完了でHTTPコードを失ったり、プロセス停止を待たせ続けたりしない。

Python serverの単一errorキーの既知JSON、インストール済み`@cloudflare/containers`0.3.7の固定起動／容量エラープレフィックスだけを列挙した署名へ変換する。余分なキー・未知の値・異なるHTTP状態・不正UTF-8は未認識とする。本文・例外のsuffix・ヘッダー・秘密値・本文ハッシュは診断へ返さない。署名は応答形式の分類であり、発信元や根本原因の証明ではない。

## 代替案・限界

本文をそのまま保存する案は内部情報を混入させ、無制限text読み取りは停止の前に処理を滞留させるため採らない。HTTP状態だけを残す従来方式は安全だが切り分け不足が残る。未知の本文を正規表現で広く分類せず、固定の未認識にする。

実DO SQLite／RPCと制御したHTTP／process adapterの試験で停止待ち・停止失敗・回復を確認する。これは実Container SDKの起動や実Cloudflareの再現ではない。Python／Dockerソースは今回変更しない。実環境の採否は最終一括検証計画（過去の私有資料・公開対象外）に残す。定期バックアップ有効化保留・30日保管・通常メールdisabledを維持する。

参照: [Container class](https://developers.cloudflare.com/containers/api/container-class/)、[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。SDKの具体的なプレフィックスはリポジトリの固定依存0.3.7の実コードで確認した。

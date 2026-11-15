# ADR 0119: Container一覧はID探索に限定し、個別GETでimageを照合する

2026-10-15。技術実装の決定。製品・optimizer・schema・依存・品質ゲートは変更しない。

`3a3cc0e`の最終配備は検査済みimageの単一pushと4 Workerの配備・版確認に成功したが、観測は一覧GETが返した旧imageを検出して停止した。Cloudflare solve・機能fixture・正式凍結は0。後続の読取診断で、一覧はsource application version 17／旧imageを返す一方、個別GETはversion 18／今回のimageを返した。rolloutはcompleted、100% target・旧version instances 0であり、配備失敗と同一視しない。source preflightはjob・再検証・busy process 0。

一覧はnamespaceからapplication IDを探す用途に使う。image・quota・所属は、そのIDの個別GETへ照合する。戻りIDが要求IDと一致することを確認し、registry config digestと検査済みimage IDの一致も従来どおり必須とする。最後の再取得でもID・imageを再確認する。一覧が正常でも、個別GETの別namespace・別ID・異なるimage／quotaを許容しない。

API40要求・registry8コマンド・5分の既存上限内で、個別GETを2回追加する。失敗した観測ownerは保持し、台帳の上書き・手動成功化・同owner再送をしない。新候補の同commit固定11・security9・SDK・独立レビューを揃えてから新しい最終cohortで確認する。

[Cloudflareの配備説明](https://developers.cloudflare.com/containers/guides/deploy/)は、Worker配備とContainer rolloutが非transactionalであり、CLI成功が全instanceの更新完了を意味しないことを示している。今回の一覧／個別GETの不一致は実測であり、すべてのAPI応答に同じ遅延があると一般化しない。実施記録（過去の私有資料・公開対象外）。

個別GETにactive_rollout_idがある間は、同じ観測owner内で5秒間隔・各application最大7読取（待機最大30秒）に限定して待つ。別ID・namespace・quotaは待たず拒否する。既存のAPI40要求／観測5分を共有し、上限を増やさない。最後の再確認で新たなrolloutがあれば停止する。CLI成功とrollout完了の間が非同期であることに対応し、失敗済みownerの再起動は許可しない。

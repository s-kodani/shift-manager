# ADR 0071: ローカルSDK開発のUserWorker直接HTTP経路

- 日付: 2026-10-13
- 状態: ローカル資源制限付きSDK入口で採用。本番・全UI・全復旧の採用判定とは別
- 対象: R-04の初回ログイン、local-only開発手順

## 判断

`npm run dev:bounded-sdk`のHTTP受付を、Node loopback HTTP→Wrangler LocalRuntimeのMiniflare dispatchFetchへ変更する。製品Worker・Better Auth・scrypt・初回変更必須・Queues／DO／Containers SDKは維持し、別ProxyWorker経由のHTTP転送を省く。通常のWrangler API起動、PoC配備、Cloudflare経路は変更しない。比較用に明示`--proxy`を残す。

Wrangler 4.149.0の公開unstable APIとraw.runtimes.mfを使うため、固定版一致・local環境・メール／AI disabled・remote bindingなし・fresh owner・同ownerの独立Docker gate・persist stateの所有境界を必須にする。WebSocketは426、本文は16 MiBまで、元URLと複数Set-Cookieを維持する。POST再送を追加しない。依存更新時は停止し互換性を再検証する。

## 根拠と代替

前回比較（過去の私有資料・公開対象外）では従来Proxy3件中1件・内部close候補10件中4件が失敗し、closeは不採用。直接候補は10件成功したが単独認証だけで採用しなかった。今回の実SDK・ブラウザー結果（過去の私有資料・公開対象外）で、架空101人・実Queues／DO／Containers SDK・1 CPU／6 GiBの通常計算1件、公開時別検証、停止先行、本人31日・通知・CSV拒否、双方の初回変更、所有資源・102資格情報の終了を確認し、資源制限付きlocal入口に採用する。

起動にはcontainerBuildIdが必要であることと、worker.readyはUserWorker準備完了ではないことを実失敗から確認した。build ID発行・上限30秒のUserWorker準備待ち・起動失敗の非0終了を実装する。初回失敗は保持し、成功に書き換えない。

## 限定と次の確認

直接経路の実行は`--direct`を明示した1ケースで、通常採用は同じbranchを既定にする変更。500人・異条件反復、故障／取消／復旧、HTTP切断／本文境界・全UI・実端末・Cloudflare受入は別に残る。並列処理や安全条件を弱めるための迂回ではなく、local開発HTTP経路の変更だけである。最終Cloudflare一括、定期backup有効化保留、復旧コピー30日保管を維持する。

# ADR0109: 有限のローカル最終演習と既知の未受付snapshotの修正

- 日付: 2026-10-15
- 状態: ローカル実SDKの4job検証済み／Cloudflare未実行

既存bounded SDKへ明示的な`--final-acceptance`モードを追加し、所有loopback・private PoC入口・通常calendar fallback・1 CPU／6 GiB・外部providerなしを検査する。起動だけではfixture／jobを作らない。専用driverはownerと操作IDを送信前に保存し、通常API4job・故障1回・同job復帰・固定／取消／別再配置／公開／本人照会を実行する。Cloudflare配備やremoteモードは提供しない。

初回演習はJ3のsnapshot前で既知のHTTP409を受けて停止した。原応答本文のcodeは未保存だった。現行APIと下書きheadの存在から、raw snapshotへ下書き文脈を渡さなかったことを原因と推定した。通常アプリと同じ下書きsnapshot入口へ修正する。製品のsource guardを緩めない。

同一snapshotと予定J3が404、全SDKがidle、J1／J2がVERIFIED・J2 attempt2、故障1回・既存操作すべてCONFIRMED、cleanup未開始・時間内を実観測してから、明示的な`resume-reallocation`で元のJ3／J4だけを送る。回復は1回に限定し、既知拒否の記録をownerへ残す。未知のjob producer、既存J3／J4、未停止、時間超過では再開しない。通信断を理由にjobを置換しない。

4job／5attempt、実プロセス停止、公開／本人照会、104資格情報と全所有資源の終了を確認した。実施結果（過去の私有資料・公開対象外）。同じ演習内での修正後継続であり、修正版のfreshな全経路反復・技術復旧／CSVを含む最終cohort・正式G0／G1／Cloudflare合格ではない。

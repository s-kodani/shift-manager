# ADR 0042: 保存候補の実Cloudflare検証を通常計算から分離する

2026-10-12。判断: 検証経路を採用。`mvp-joint-seed-v1`の通常PoC採用・性能目標の達成は未判定。[ADR 0041](0041-checked-saved-candidate.md)、実施記録（過去の私有資料・公開対象外）。

## 理由と実装範囲

既存の私有`/benchmark`は入力4MB・内部チェックの要約を返す。保存候補8MBを含む新しいsolve envelopeと、通常ジョブ同様の別HTTP`/check`を検証するため、保護された`POST /__poc/optimizer-saved-benchmark`を別に追加する。既存入力の仕様・上限は維持する。

PoC tokenと`ENVIRONMENT=poc`、固定の架空企業・チーム・スタッフ・ジョブID、架空下書きID、厳格なキー／版／入力4MB・候補8MB・全体16MBを照合する。方式・時間をHTTP入力から指定できず、内部ヘッダーの`mvp-joint-seed-v1`（v4／120秒）を使う。対象は既存の`synthetic-poc`のみで、企業・チームの下書き、D1／R2／Queues、公開、通知を変更しない。

Durable Objectの既存の排他と永続チェックフェンス内でhealth→solve→別check→healthを実行する。開始時から150秒の共有通信期限、応答の上限付き読み取りを維持し、結果の入力ID・版・候補参照・プロファイル・予算を照合する。別checkの違反とソルバー評価との不一致を拒否する。UNKNOWNで案がない場合はNOT_RUNを記録し、解なしや試験合格へ変換しない。

healthは配備したPython全ファイルのSHAと非root／shellなし・配備IDを返す。前後が不一致なら実測を拒否する。返す証跡は個人別の配置を含まない要約・実レスポンスSHA・各工程時間とする。CLIは実行前に保存したホストの全Python SHA、実行後のファイル、遠隔のファイル集合／SHAを照合する。結果取得・解析失敗でも所有プロセスをfinallyで停止し、停止確認失敗ならフェンスを保持する。成功応答の停止確認と、後続のstate照会は別々に保存する。

## 代替案と制約

通常PoCプロファイルを直ちに切り替える案は、保存候補の追加検査・構築が120秒予算と品質に与える影響を実Cloudflareで確認してから判断する。既存benchmarkの上限を緩める案は、単純入力と保存候補の境界を曖昧にするため採らない。healthのSHAは秘密値ではなく、私有PoCでのみ閲覧できる既存のhealth経路を使う。

コンテナ起動・HTTP/RPC・solve・別check・停止の実測は、Queues待ち・業務D1／R2・ブラウザーを含む通常業務の受入ではない。配備前ガードのTOCTOU、反復品質、実チーム条件、G0〜G2、5分目標は別に残す。定期バックアップの有効化保留・30日保管、実メールdisabledを維持する。

DOインスタンスの中断ではfinally自体が完了しない場合がある。今回の500人試行では実ログの接続例外と永続チェックフェンス残存を確認した。通常ハーネスは再実行を拒否し、同じ論理オブジェクトのプロセス停止確認後に既存のチェック回復を行った。メモリ上のboot IDは再起動で変わるため、永続オブジェクト・フェンスの所有を表すIDとして扱わない。成功した試行だけで障害時停止や反復性能を保証しない。

参照: [Cloudflare Container class](https://developers.cloudflare.com/containers/api/container-class/)、[Durable Objectsの並行処理・保存規則](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)。使用中の`@cloudflare/containers`0.3.7・Wrangler4.149.0と実コードを優先し、今回の変更でAPI・構成を移行しない。

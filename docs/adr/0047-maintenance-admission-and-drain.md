# ADR 0047: 保守の原子受付停止と終了確認

日付: 2026-10-12。WP-10／Q116〜117の復旧準備。製品条件は変更しない。

## 判断と実装

共有D1全体を保守の単位とし、`OPEN → DRAINING → FROZEN → OPEN`を専用運営者Workerから操作する。企業管理者・チーム管理者の業務APIには保守権限を追加しない。

- `OPEN`では認証を含むAPI・初期企業発行・PoC／ローカルfixture操作の開始前に、D1条件付きINSERTで処理のleaseを取得する。状態確認だけの先行SELECTでは競合を防げないため、受付自体をSQLで直列化する。0行をSQL失敗と仮定せず拒否する。
- `DRAINING`では新規受付を503で拒否する。受付済みの処理とQueues／Cronの回復は終了できる。`waitUntil`の配送にも独立したleaseを持たせる。
- `FROZEN`への移行前に、全チームと専用synthetic DOの実行・計算／チェックフェンス・プロセスを確認する。条件付きUPDATEでlease・受付済み計算・再検証がすべて0であることを再検査し、状態変更と不変の操作記録を同じD1 batchで保存する。
- `FROZEN`ではCronの更新と新規RPCを開始しない。遅いQueue配送は終端のD1記録が確認できたものだけackし、不明なものを完了扱いにしない。
- 全制御は操作ID、期待版、開始時の保守ID、理由、運営者principalに結合する。同IDは不変の過去receiptを返す。現在の状態は別のstatus照会で確認する。監査の保存失敗は状態変更もロールバックする。
- leaseは処理終了後に自分のIDだけを解放する。時刻・HTTPタイムアウト・利用者の画面終了を根拠に期限削除しない。解放に失敗すれば凍結を拒否する。

業務APIのGETも認証セッションを更新する可能性があるため対象に含める。通常Workerの静的画面・health、運営者の照会、読み取り専用の配備前確認は保守の更新受付と分離する。開発fixture用Workerは前後の掃除も更新するので、全fetchを保護する。

## バックアップと画面

新しいコピーの取得前、SQL書き出し内容、R2コピー終了後で、同じ`FROZEN`の保守ID・版と処理0件を照合する。コピー中の再開・別保守への移行を成功へ読み替えない。旧スキーマの既存コピーは従来のcatalog形式で検証できるが、旧コピーを保守制御の成功証拠には使わない。

503・500・通信断・保存後の処理失敗で、画面は未確認の操作IDと入力を保持する。再開後に同じ操作を確認でき、確定した4xx拒否だけを未確認状態の解除に使う。シフト条件の緩和、再計算・公開・通知の自動実行は追加しない。

## 検証範囲と未検証

実施記録（過去の私有資料・公開対象外）にローカルD1の競合／ロールバック、実SDKの外部DO binding、画面、SQL／R2コピーを分けて記載する。Cloudflare追加配備・計算は0。動作中の旧版Workerには本制御がないため、最終移行では全書込み経路の版一致と旧実行の終了が前提になる。

異常終了で残るleaseの安全な回収、実環境の故障／反復、別環境への認証付き全サービス復旧、RPO24時間／RTO1時間、G1／G2は未達。単純なlease削除を復旧手順として提供しない。バックアップの定期有効化保留・30日保管を維持する。将来の定期有効化では保守制御との連携も必要になる。

参考: [D1 batchの原子性](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Workersの実装指針](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[DO binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/durable-objects/)。実装時に公開型`@cloudflare/workers-types 5.20261012.1`とWrangler 4.149.0のschema・helpを確認した。

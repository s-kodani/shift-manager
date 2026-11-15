# ADR 0103: 初期登録・権限・履歴を実状態で原子確認する

- 日付: 2026-10-14
- 状態: 採用・ローカル検証済み／Cloudflare未配備
- 対象: TS-AUTH-02／06、TS-API-02／04、TS-NEW-15／17、R-04／06

## 問題と判断

企業・チーム・スタッフ・カレンダー・権限付与／解除・履歴の27省略故障を実D1で検査した。24件で部分保存や成功扱いが残り、3件は既存の外部キー／参照ガードで拒否できた。修正前の失敗は保持する。

初期credentialのstatement列にuser／accountの正確なhash／初回変更必須の確認を加え、passwordを返す前に同じbatchで要求する。企業作成はcompany／admin／audit、通常product commitはoperation／audit／企業版とresource、権限解除はrevocation／role／audit／企業版を確認する。履歴はoperation／audit／企業版と、期待全行／根拠の両方向EXCEPTを使う。

確認falseは既存方式のabs(INT64_MIN)でSQL失敗にし、全部rollbackする。statement文数やmeta.changesだけ、batch後の読取だけでは部分確定を拒否できないため使わない。schemaや権限仕様を増やさず、同ID／並行再送・初期秘密の再表示禁止を維持する。

初期credentialの確認はCSVにも共通適用され、正常100行の回帰へ通す。SQL statementが新規本人ごとに1つ増えるため、遠隔の100行受入はR-07へ残す。依存版・初期password生成・Better Auth hash形式は変更しない。[Cloudflare batch契約](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)と確認済みWorkers型5.20261014.1のAPIを使用する。

## 実結果と残る範囲

修正後は対象5ファイル89件成功。実施記録（過去の私有資料・公開対象外）へ最終全体検証と証跡を記録する。全書込を一度で保護したとは扱わず、有限の書込台帳（過去の私有資料・公開対象外）に残る下書き・公開・固定・取消・受付／通知などを分離した。Cloudflare配備は最終一括へまとめ、追加配備／計算0・backup HOLD／30日を維持する。

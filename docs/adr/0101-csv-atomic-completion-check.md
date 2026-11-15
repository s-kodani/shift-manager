# ADR 0101: CSVの保存状態を同じbatch末尾で確認する

- 日付: 2026-10-14
- 状態: 採用・ローカル検証済み／Cloudflare未配備
- 対象: Q100〜101、TS-IO-04、TS-API-04、R-04

## 問題

実workerd D1へRAISE(IGNORE)の故障を注入すると、スタッフCSVの監査／receipt／既存本人情報／新規account・access・membership、需要CSVの監査／receiptの9ケースで不完全反映が残った。スタッフは成功応答を返す場合があり、需要のreceipt省略は応答が失敗しても入力版が既に確定していた。通常のSQL例外によるrollbackやmeta.changesの確認だけでは、この欠落を防げない。

## 決定

同じD1 batchの末尾に読取SQLを追加する。スタッフはoperation・企業版・監査・receiptと、最大100人の期待する本人情報／契約版を照合する。新規にはcredential・初回変更必須・チーム所属を要求し、メール変更時はemailVerified解除・旧session／reset tokenの不存在を確認する。最大100人を1つのJSON配列で結合し、1人ずつ別ネットワーク呼出しを行わない。

需要はoperation／計画payload／企業版／監査／receipt／CSVとプレビューdigestの一致を確認する。共通commitInputへ末尾確認statementの任意引数を追加し、需要CSVだけが使用する。通常の非CSV入力の振る舞いは今回変更しない。

不一致時は、既存の保守／復旧処理と同じCASEのfalse側でabs(INT64_MIN)を評価してSQLエラーにする。失敗がbatch内で起きるため、本人・認証・入力・監査・receiptを全部rollbackする。通常はSELECTだけで、schemaや保存テーブルを追加しない。既存の同ID並行／遅延再送の照合は維持する。

代替案のbatch後の読取は、既に確定した部分反映を戻せないため採用しない。各statementのmeta.changesは省略位置の検出だけでは全体rollbackにならず、triggerの派生更新も別に確認する必要がある。新しいsealテーブル／migrationはこの上限と既存のimmutable記録では不要と判断した。

## 検証と限界

修正前24成功／9失敗を保持し、修正後33成功、旧session／reset tokenの削除省略2件と公開再検証16件を含む対象51件が成功した。全API／運用・build・型・securityの最終結果は実施記録（過去の私有資料・公開対象外）へ記録する。実D1はローカルworkerdであり、Cloudflare遠隔D1の今回の受入ではない。UI／APIのCSV仕様・行数・秘密の再表示方針は変更しない。

公開の[最新D1 batch契約](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)とWorkers型5.20261014.1を照合した。batch内のSQL失敗が全体をrollbackすることに依存し、ゼロ行を例外と仮定しない。最終Cloudflareは既存の一括計画へ含める。非CSV入力の全無言省略位置の監査はR-06で別に扱い、今回のCSV試験で代替しない。

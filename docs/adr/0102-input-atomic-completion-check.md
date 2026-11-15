# ADR 0102: 入力・本人提出の完了状態を同じbatchで検証する

- 日付: 2026-10-14
- 状態: 採用・ローカル検証済み／Cloudflare未配備
- 対象: TS-API-01〜05、TS-NEW-07／17、R-04／06

## 問題と判断

[CSVの修正](0101-csv-atomic-completion-check.md)に続いて、6入力種別の監査・実版・企業版更新とsnapshotを実D1のRAISE(IGNORE)で検査した。修正前20故障の18件で不完全な保存が残った。本人提出・受付再開の別batchも6件中5件で欠落を検出できなかった。月別の版省略3件は既存の固定参照ガードが拒否していた。失敗と既存の拒否を区別して保持する。

共通inputCompletionGuardを同じbatch末尾で使い、operation・audit・企業版と実入力版／snapshotを結合する。通常設定保存ではpayload・適用月、月別入力では固定参照登録も期待値と照合する。本人提出はdeadline／calendar／own staffの既存書込検査を維持し、同じ共通guardと本人用のpayload／固定参照／calendar結合を追加する。受付再開は入力版を増やさず、window／audit／対象と意図の一致を確認する。

snapshotはキー・digest・byte数・月・入力版・系譜の一致と、manual_draft系譜に対応するinput_snapshot_draftの保存を要求する。欠落は同batch内のabs(INT64_MIN)でSQL失敗にし、全D1変更をrollbackする。先にアップロードしたR2はimmutable orphanとして保持し、削除・上書きで別配送の成功を失わない。同IDの明示修復と既存の並行配送照合を維持する。

batch後の読取では部分確定を戻せず、statement文数／0行の判定だけではtriggerの派生更新まで証明できないため採用しない。追加のsealテーブル／migrationは不要とした。既存の[Cloudflare batch契約](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)、確認済みWorkers型5.20261014.1とSQL確認方式を使用する。bindingや依存版を変更しない。

## 検証・限界

修正後の最終対象135件は成功。初回の対象133成功／2失敗は既存ハーネスのbatch4文の決め打ちで故障注入が発動しなかったためで、実入力INSERTを識別して再検査した。最終全体結果は実施記録（過去の私有資料・公開対象外）へ記録する。ローカルD1／R2であり、実遠隔D1／SDK・UIの今回の再受入ではない。製品仕様・schema0033を維持し、全ての独立した業務mutationの無言省略をこのguardで保護したとは扱わない。

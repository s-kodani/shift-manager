# ADR 0066: 復元スキーマを移行し、認証反映前に期待値と照合する

日付: 2026-10-13。対象WP-10／R-02／TS-REC・AUTH。基点`f508f0d767c1a411129cf3218c851ae6104c8b74`。製品仕様・公開勤務・権限を変更しない。

## 問題と判断

旧コピーには現在の受付権限列・監査表がない。通常のmigration適用だけでは、原バックアップの全SQLハッシュと不一致になり、認証照合CLIのprepareが止まる。照合を省くと、移行による変更と復元漏れ・改変を区別できない。

原SQL／R2の完全性と復元先との一致を先に確認する。原SQLを独立したPython SQLiteへ読み込み、レビュー済みの未適用migrationだけを順序どおり適用して期待SQL・catalogを作る。その同じ移行SQLを専用ローカル復元先へ適用し、全schema・全行・FK・全R2本文を期待値と比較する。期待値は実復元先から作らない。原manifest・SQL・objectsは変更しない。

## 対象と不変条件

- 現在は保守導入済み0027〜0032のFROZEN・無活動コピーを対象とする。移行台帳の連続番号・ファイル名と、当該版の参照schemaを照合する。[D1のmigration台帳](https://developers.cloudflare.com/d1/reference/migrations/)を保持し、既存の台帳行を置換しない。
- 0028〜0032は空の権限・監査表を追加し、旧受付の権限を昇格しない。移行台帳以外の全既存表の行hash、R2参照、保守ID／版／FROZEN／無活動が変わらないことを独立に検査する。移行対象の列追加は空の受付表であり、既存行を省略して照合する仕組みではない。
- 新しい台帳行の`applied_at`は計画を準備したUTC日時に固定し、移行SQL・期待値の両方へ同じ値を入れる。実際の送信・終了日時は別のownerに記録する。
- schemaの版と台帳が食い違う、未知表、未レビュー版、元が稼働中、SQLの外部DB接続・extension読込みを拒否する。ローカル専用fixture表2種とD1内部表は参照schema比較の対象外だが、原コピーの既存表の行hash比較は維持する。
- migration全32ファイル、移行SQL、期待SQL、原SQL、復元UUID／DB／bucket／profile SHAをownerへ結ぶ。照会時にも原コピーから期待値を再構築し、owner内catalogだけを信頼しない。private file・directory・symlink・hardlinkを検査する。

## 送信と認証反映

`prepare-upgrade`→`apply-upgrade`→`verify-upgraded`を別の明示操作にする。現在版もno-opの計画と照合を通す。送信前にDISPATCHEDを保存し、移行応答が不明なら同じ復元先を読取照合する。SQLを自動再送・再importしない。生存するproducerがあるDISPATCHEDは検証完了へ進めない。

認証照合のprepareとsendは、移行後の全SQL／R2照合を再実行する。sendの照合失敗では認証要求を送信せず、同じoperationをPREPAREDのまま保持する。認証反映後にはuser／session／権限／保守監査が意図的に変わるため、COMMITTED／応答不明の照会は既存の不可変receiptを使う。移行前の原hashへの一致を要求して再送しない。

## 代替案と未対応

`wrangler d1 migrations apply`だけで進める案は移行後の独立期待値と全内容証明がない。認証表や台帳を照合から一律除外する案は復元漏れを見逃す。今回は原コピーと移行後期待値を区別する。

0026以前、0033以降、remote targetは未レビューとして拒否する。対応するにはデータ移行・無活動の証明を追加する。新たなデータ変換を伴うmigrationを追加した場合も、この方式へ自動追加しない。処理中／配送中・元不在復旧、provider隔離、RPO／RTO、最終Cloudflareと全受入は残る。

実施結果（過去の私有資料・公開対象外）に限定ローカル演習・失敗・残範囲を記録する。Cloudflare追加配備／計算0、定期backup有効化保留・30日保管を維持する。

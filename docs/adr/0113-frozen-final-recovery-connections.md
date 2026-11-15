# ADR0113: 凍結した最終復旧先へのスキーマ・認証・保守接続

- 日付: 2026-10-15
- 状態: 実装・ローカル検証済み。正式cohort作成／Cloudflare未実行

最終一括の技術復旧は、元の4jobがVERIFIED・停止済みである凍結実行に結び付ける。新しい`owned-fictional-final-restore-rehearsal` profileを、privateな最終UUID領域の`recovery`へ置く。D1／R2／Worker／Queue／運営者の名前・ID・origin、profile／設定SHAを、元のexecution-release・execution-binding・owner・実ローカル検査archiveへ照合する。任意のURLや、名前だけ一致するtargetを受け付けない。

既存のSQL／R2復元・スキーマの原本比較・認証checkpoint／反映／同ID照会・保守操作を共通で使う。新profileの書込みは同じclean commitを要求し、変更後のcodeやdirty worktreeではtoken読取前に止める。元のarchiveによる読み取り照会は残す。保守operationの保存領域をcohort・復旧元／先・binding SHAで分け、同じoperationを別の環境へ送れないようにする。未知の結果を理由に新しいimportや認証反映を自動送信しない。

最終D1専用検査の`final_d1_probe`はPoCの遅延作成テーブルで、migration0033には含まれない。現行の復旧schema照合はこの追加で拒否することがコード上分かった。任意テーブルの除外を増やさず、既知のDDLをreferenceへ追加して厳密に比較する。元の行とindex・trigger・外部キーを含む全catalogの一致を維持し、定義改変・追加index・RUNNINGのproducerは拒否する。製品schema0033を変更しない。

循環importを作らないため、既存のrelease条件とローカル検査の読取り証明を副作用のないmoduleへ分けた。release条件の関数本文は変更前とbyte一致を確認し、CI代替のユーザー承認、独立レビュー・演習・復旧binding・費用上限を維持する。

新しいローカルの架空2社を完成コピーから別環境へ復元し、0033照合・実認証反映・旧session失効・22応答一致と所有終了を確認した。遠隔設定の選択・改変／版拒否は制御したarchive／HTTPS応答で検証した。実Cloudflareの互換性や正式凍結済みとはしない。実施結果（過去の私有資料・公開対象外）。

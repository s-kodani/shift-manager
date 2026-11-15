# ADR 0092: 受渡しlayoutの逐次書き出し

2026-10-14。R-01。状態：限定測定済み、500人への効果は未検証。

hashで結び付けたprivate model handoffのlayoutだけ、全スタッフ日リストと全JSON文字列の同時保持をやめ、1行ずつ同じ順序・内容で書く。activeSlotPoolsは行生成後に書き、全行が参照するpoolを欠落させない。バイト上限は書き出し中に適用し、manifestがない途中ファイルは復元拒否する。負のliteral・role interval・勤務候補・目的・設定・SHA／版検査・checkerは維持する。

モデルtextも1messageずつ書く候補を試した。固定版schema全root fieldの往復は一致し、メモリは減ったが10万変数／20万制約の限定測定で約11倍遅かったため採用しない。モデルは元のnative exportを維持する。根拠schemaは[OR-Tools v9.15公式定義](https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model.proto)。binary・別solver・準備時間の丸め・候補削減への変更はない。

15,500架空抽出行の限定測定でlayoutのピーク約613→87 MiB、2.38→2.35秒、同じfile byte／SHAを確認した。実モデル構築・CP探索・Linux cgroupの性能達成とは区別する。計画（過去の私有資料・公開対象外）／実施結果（過去の私有資料・公開対象外）。通常profileは変更しない。

Cloudflare追加0・最終一括、定期backup保留／30日、試験導入範囲外を維持する。

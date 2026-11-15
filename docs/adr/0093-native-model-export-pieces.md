# ADR 0093: 診断用モデルをnative textの断片へ書き出す候補

2026-10-14。R-01。状態：小規模の内容一致・限定測定済み、500人の効果は未検証。通常Worker profileへの採用ではない。

分離構築の観測で250万変数／438万制約のモデル完成後、hint・約1.12 GBのtext exportを経てlayout開始時に120秒上限へ達した。モデル完成後のhint設定・一括text生成を経てpeakは6 GiB近くへ達した。hintとexportの秒数・peak寄与は別々に測れていない。

Pythonで1messageずつtext化した候補は遅すぎたため不採用だった。代案として、固定版OR-Toolsのnative exportを20,000 message以下の断片へ使い、同じ順序で結合する。断片はindexを振り直さず、全変数・全制約・root field・hintを復元後の全モデルへ保持する。[公式schema](https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model.proto)のroot field集合が変われば拒否する。断片には未収録変数への参照があるため、各断片を解いたり独立した有効モデルと扱ったりしない。

同じCpModelをclearして再利用し、list化は20,000件以下に制限する。最後にname・search strategy・assumptions・optional各messageを保持する。大きな単独messageとtailは全体を扱うため、絶対的なメモリ上限を保証する方式ではない。バイト上限を超える断片は結合せず、完成時だけ最終fileへreplaceする。途中例外時はprivate一時fileを削除し、既存fileは上書きしない。親期限停止時は子回収後のprivate root削除を維持する。

10万変数・20万制約・10万hintの最終候補は、直前runの旧方式とbyte／SHA・復元protoが同じ。peak約256→205 MB、0.38→0.67秒で、メモリと速度に交換条件がある。対同時測定・大規模効果・受渡し完成・CP品質達成とはしない。初版のiterator互換失敗と、モデル再作成版のpeak低下なしを実施記録（過去の私有資料・公開対象外）へ残す。

private handoffをこの候補へ変更し、小規模全proto／hint・実CP／独立checker・例外cleanupを確認する。通常計算のモデル／目的／hint／120秒・保存／公開は変更しない。次の規模計画で効果を確認する。Cloudflare追加0、最終一括、定期backup保留／30日、試験導入範囲外。

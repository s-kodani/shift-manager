# ADR 0095: 名前省略モデルの一括native export診断

2026-10-14。R-01。状態：小規模一致を確認、規模の時間／メモリは検証対象。

debug名省略でモデル本体の構築は短縮したが、分割exportは120秒内に完成しなかった。private save_bundleの既定は分割nativeを維持し、分離build診断だけwhole-native-v1を選択する。名前省略によるsource RSS／出力減少が、一括出力の時間とメモリの交換条件を改善するか確認する。

全proto・index・domain・制約・hint・外部map・目的を保持する。modeはlayout設定とreadyへ記録し、未知modeを拒否する。native出力はpending.txtへ書き、byte上限確認後だけ最終fileへreplaceする。途中例外・超過でpendingを掃除し、既存fileを上書きしない。子の期限／強制停止は親の回収後のprivate root削除を維持する。

両方式の小規模全proto／hint・元実CP／独立checkerを比較し、出力の方式だけの変更であることを検証する。受渡しが完成してもCP・品質・通常採用の達成とはしない。計画（過去の私有資料・公開対象外）／実施記録（過去の私有資料・公開対象外）にOOM・時間未達も残す。

通常Worker profile・既定の名前生成・120秒・製品仕様は変更しない。Cloudflare追加0、最終一括・定期backup保留／30日・試験導入範囲外。

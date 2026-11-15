# ADR 0094: 診断モデルのdebug変数名省略

2026-10-14。R-01。状態：小規模のモデル等価性を確認、規模効果は検証対象。

OR-Toolsの[固定版公式schema](https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model.proto)ではIntegerVariableProtoのnameはdebug／log用途で、省略可能と定義される。Python内部debug_namesは既定trueを維持し、分離build診断だけfalseにする。条件式でf-string自体を作らず、生成するlabelを空にする。自動constantの数値名は残す。事後巡回で全変数を変更する方式は使わない。

index・domain・全制約・hint・候補・目的・外部のstaff／date／task／role mapは維持する。モデル受渡し設定へboolを記録し、型が不正なら拒否する。APIに任意設定は追加せず、通常Worker profile・120秒・保存／公開は変更しない。名前省略だけでCP成功・品質改善・通常採用と判定しない。

変更前4条件のproto／hintを保存し、既定trueの完全一致と、名前以外を変えないfalse版の一致を確認した。名前付き／省略版の実CPと独立checker、固定・予定・役割を持つ保存案、分離した子の受渡しを検証する。計画（過去の私有資料・公開対象外）／実施結果（過去の私有資料・公開対象外）に試験と残る制約を分ける。

Cloudflare追加0、最終一括・定期backup保留／30日・試験導入範囲外を維持する。

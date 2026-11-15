# ADR 0089: 入力とSHAに結び付けたモデル受渡し基盤

2026-10-14。R-01。状態：小規模の基盤検証・通常未統合。

モデル構築中のデータとCP処理を同じプロセスに保持すると、大規模でメモリが増える。構築プロセス終了後にCP専用プロセスへ渡すため、全モデル・初期hint構築直後の任意prepared callbackを追加する。通常はNoneで、候補・制約・目的・設定・既存探索を変更しない。

固定版9.15.6755のPython helperでbinaryモデルの直接復元を確認できなかったため、対応しているtext protobufを用いる。layoutには候補、正確な実稼働slot pool、Bool／負literal index、役割interval、整数目的の係数／offset・順序、設定を保存する。pickleや任意コードの復元を行わない。

manifestは入力全体hashとtenant／team／月／版／job／attempt、モデル件数、固定ファイルのSHAとサイズを結び付ける。受信側は呼び出し元が保持するmanifest SHAを必須にし、symlink・不足・変更・上限超過・不正index／目的順序を拒否する。text上限1.5 GB・layout256 MBは診断用ガードで、規模性能の達成値ではない。

小規模probeは元の段階目的と上位評価の保護を実行し、CPの目的値と抽出後の独立checkerが一致しなければ拒否する。通常profile・親120秒・Worker保存／公開への統合は未実装。大規模のtextサイズ・parseメモリ・時間は別途測定する。

計画（過去の私有資料・公開対象外）／結果（過去の私有資料・公開対象外）。Cloudflare追加0、大規模再計算0、最終一括、定期backup保留／30日、試験導入範囲外。

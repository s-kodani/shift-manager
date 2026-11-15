# ADR 0088: 検査済み初期案を保持し、残時間で全体探索へ進む診断

2026-10-14。R-01／R-02。状態：診断統合・通常未採用。

初期案の生成call内で、同じ入力と全assignmentのSHAが一致するVERIFIED証明だけを再利用する。期待vector指定時は一致も必須、指定なしはchecker自身の評価を保持する。変更があれば再検査し、親・外部HTTP checkerは再利用せず新たに検査する。

初期案が独立検査を通るたび、親所有の一時領域へ原子的なcheckpointを書く。その後は元の全候補モデル・段階目的を残時間で実行し、保存済み初期案を初期値に渡す。検査済み評価より悪い結果は採用せず、候補なし／予算切れは保持した案へ戻す。モデルINFEASIBLE／最適結果と検査済み案が矛盾する場合は失敗として診断する。

初期案由来のprefixはsolverStatus UNKNOWN・candidateStatus CHECKED・globalSolverStatus NOT_RUN／UNKNOWNで、publication BLOCKED_A1。通常のFEASIBLE／OPTIMALへ変換しない。全体CPが実際に得た検査済み結果は従来の状態で扱う。診断profile `mvp-early-checkpoint-v1`だけがこのprefixを受け付け、通常profile・Worker許可profile・保存／公開は維持する。

親120秒、子停止／回収、期限停止以外の非0終了時の拒否、入力hash／版／job／attempt、全条件再検査、一時ファイル削除を維持する。単に検査済み初期案を返すことを、全体探索完了・最適証明・MVP完成へ置き換えない。

計画（過去の私有資料・公開対象外）／結果（過去の私有資料・公開対象外）。Cloudflare追加0、最終一括、定期backup保留／30日、試験導入範囲外。

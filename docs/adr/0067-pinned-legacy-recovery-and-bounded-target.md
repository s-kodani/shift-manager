# ADR 0067: 旧版の実コードから現行版への復旧を隔離して検証する

日付2026-10-13。対象R-02／WP-10／TS-REC。基点72591afe32695c125af866650b97511cda91ebda。製品仕様・計算条件・本番設定を変更しない。

## 判断

旧コピーを移行してから最新認証・通常計算まで再開する一体検証には、存続中の架空sourceが必要である。過去fixtureの期限切れ資格情報を復活させず、schema0031時点の実コミットf83164e3d2c2a3190c7f5c86e7c897b205c53e0eをGit archiveから新しいprivate directoryへ抽出する。mainのcheckoutを戻さない。新しい架空101人を旧版の通常登録・計算・公開から作る。

旧codeを各Git blobと照合し、Node依存版、最適化・契約・runtime build scriptの現行との一致を要求する。差がある状態は自動採用しない。必要なfixture依存も抽出し、起動前のdry-run buildを通す。D1／R2／Queue／DO／Docker socketはこのsourceだけのlocal構成を検査する。remote・外部service・他WorkerのDO・他queue／engineを拒否する。

復元先も起動前から1 CPU／6 GiB／追加swapなしにする。owned local restore profileに、UUIDと一致する`dev.container_engine`だけを許す。保存先の変更や任意engineの許可ではない。Dockerゲートはsource／restoreの厳密なowner prefixとimmutable image IDを照合し、非所有のmutationを拒否する。profile SHAは復元前に固定し、後から既存receiptの対象を変更しない。

## 実施結果と限定

事前計画（過去の私有資料・公開対象外）／実施記録（過去の私有資料・公開対象外）。旧0031の新しいコピー→全復元→0032移行・期待値照合→最新認証反映→旧session／password拒否→管理者／本人のfresh login・全業務本文一致→現行targetの通常計算まで診断した。元／先とも1attempt FEASIBLE／別check VERIFIED。両資格情報・所有資源は終了した。

初回の抽出依存不足、登録直後のProxy接続断、復元gate下のhealth200待ちの誤りを保存する。当初20分の観測は未達で、同じsource／targetの明示追加10分診断で終了した。成功例に置換して時間・安定性を合格扱いにしない。

SDKの`running=false`とDocker削除の記録時刻に差を観測した。終了時の実Docker不在は確認したが、Dockerの削除時刻だけではプロセスが止まった時刻を証明できない。今回のSDK停止表示を、結果採用前の実プロセス停止の独立証明へ読み替えない。local SDK／Dockerのstop契約・観測方法を別途確認する。旧版を本番採用する判断ではない。

R-02の処理中／配送中・元不在復旧、stop契約・外部provider隔離、RPO／RTO、反復・全UI・G0〜G2は継続する。Cloudflare追加配備／計算0、定期backup保留・30日保管を維持する。

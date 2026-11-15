# ADR 0056: 探索の要求時間・呼出し時間・CP内部時間を分けて記録する

日付: 2026-10-12。対象WP-03・TS-OPT／PERF。500人実SDKの固定再計算（過去の私有資料・公開対象外）で、設定120秒に対してsolve内`totalSeconds`122.592秒を観測した。製品の5分目標、設定予算、HTTP／保存／表示の実時間を同じ値として扱わない。

## 判断

初期探索と本探索の各CP呼出しについて、要求秒数、呼出し全体の単調時計／process CPU時間、当該responseの`wall_time`／`user_time`、呼出し時間とresponse wall時間の差を記録する。差の負値を0へ丸めない。証明済み0による省略段階は`solverInvoked:false`のままにし、CPを実行した時間を捏造しない。

計測は観測だけとする。要求時間の配分・候補・目的の順序・初期案採用・独立検査・状態分類を変更しない。障害注入adapterなどがresponseなしでstatusを返す場合は、時間値を`null`、理由を`NO_SOLVER_RESPONSE`として記録する。0秒・合格・解なしへ読み替えない。実CP responseのあるケースでは数値の取得と整合性を測定する。

## 診断と採用範囲

終了・資格情報無効化済みの私有ローカルfixtureから、成功した固定再計算ジョブの元D1／R2本文を読取専用で照合する。`test:compute-budget-native`は保持した全500人・明示固定／例外各1件の元本文だけを1回測る。同じSHA・120秒・1 CPU／6 GiB／追加swapなし・別HTTPチェッカーを維持し、変更したソースのimage ID・20 Python SHAと終了を記録する。過去のSDK結果を、新しいソースでの実SDK受入としない。

実測で呼出し外／内部の差と予算超過を切り分けてから、時間制御の変更を判断する。時間上限や資源を無条件に増やす案、モデルを間引く案、希望／不足・休憩などの条件を下げる案は採用しない。計測追加の実装と、時間内に有効案を得る安定性・品質・全体最適性・MVP受入は分離する。実施記録（過去の私有資料・公開対象外）を参照する。

## 本探索前処理なしの技術候補

最初の保持入力測定では、本探索の要求27.122秒に対してCP response wall31.087秒、Python呼出しとの差約0.013秒となった。全体112.596秒なので前回の全体超過は再現していないが、CP内部の経過が要求を超えるケースとして記録する。どの内部工程が超過したかはこの数値だけで確定しない。

後続候補`mvp-joint-main-no-presolve-v1`は、本探索だけ`cp_model_presolve=False`とする。初期案の制限付き探索・独立検査・全モデル・段階目的・時間配分・seed／worker数は維持する。通常プロファイルと保存候補プロファイルの既定はTrueで、Workersの要求・採用条件は変更しない。別名の結果を通常結果として保存する回避策は追加しない。

`test:compute-presolve-native`で同じ入力・imageの通常／候補を各1回、別チェッカー・cgroup・終了まで比較する。小規模では業務／チーム、ceil／floor、明示／圧縮役割、v3／v4の16条件について全18通りの正解と比較する。候補追加と小規模合格、500人実測、通常経路への採用・反復品質・実SDK受入を分離する。どちらかが失敗したらその試行を保持し、自動再実行しない。

参考：[OR-Toolsの時間上限設定](https://developers.google.com/optimization/cp/cp_tasks)、[v9.15のSolveCpModel](https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model_solver.cc)、[v9.15の前処理parameter](https://github.com/google/or-tools/blob/v9.15/ortools/sat/sat_parameters.proto)。リポジトリの固定版・実行環境を正本にし、一般的なAPI説明をこの入力での厳密な終了保証へ読み替えない。

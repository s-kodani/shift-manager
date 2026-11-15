# ADR 0087: 全モデル構築前に初期案を独立検査する診断

2026-10-14。R-01。状態：診断実装・通常未統合。全体ソルバーの採用／性能達成とは別。

500人の全モデルは250万変数／438万制約で、初期hint完了だけで約108秒、初期案CP開始後にOOMと親期限へ達した。初期案の検査にも全モデル構築を前提としているコストを切り分ける。

既存の候補生成・分集合・区間境界・資格／役割、calendar／interval hintを、軽い整数indexで実行する。初期案生成のためのmetadataで、全問題のsolver変数や制約ではない。全勤務候補を保持し、元の出力と同じ選択勤務・実稼働slot・役割intervalへ変換する。

通常／希望休日hintの最大2案を独立checkerへ通し、VERIFIEDのみ保持する。同じ優先順位の正確な整数objectiveVectorを辞書順で比較する。通常／個人・履歴・固定・例外・取消・休憩・準備・継続・役割が検査で成立しなければ返さない。候補の不成立を原問題INFEASIBLEとは表示しない。

calendarは既存の補助CPを用いる。全体の段階最適化は実行していないため、candidateStatus CHECKEDとglobalSolverStatus NOT_RUNを分け、publication BLOCKED_A1を維持する。小規模の最適値と一致しても全体最適証明を付けない。

内部診断`/initial-candidate`と固定profile `mvp-checked-hint-v1`のみで検証する。通常`/solve` profile・Workerの許可profile・保存／公開・ジョブcheckpointは変更しない。通常保存案との統合・検査済み初期案を保持して全モデルを改善する構成は後続の未実装事項。

計画（過去の私有資料・公開対象外）／実施結果（過去の私有資料・公開対象外）。Cloudflare追加0、最終一括、定期backup保留／30日、試験導入範囲外。

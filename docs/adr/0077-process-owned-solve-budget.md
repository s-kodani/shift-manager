# ADR 0077: 計算の実行期限を所有子プロセスで管理する候補

2026-10-14。R-01／TS-PERF。状態：技術候補。通常設定への採用前にWorker／実SDK互換性の確認を残す。製品仕様・通常profileは変更しない。

協調的な`stop_search()`は500人の指定時間超過を解消しなかった（[ADR 0076](0076-cooperative-cp-deadline-candidate.md)）。親が巨大なCPモデルを保持して子へコピーする代わりに、モデル構築・探索・初期独立検査を専用子へ移す。入力JSONを渡し、子で従来と同じ全候補・必須条件・段階目的・120秒内部予算・worker1／seed0を使う。

`mvp-joint-process-budget-v1`だけがこの境界を使う。HTTP入口は固定の120秒設定で、入力から任意のコマンド・期限・ファイルパスを受け取らない。親は入力検証後、private TemporaryDirectoryへ入力を保存し、shellなしで固定Pythonモジュールを新しいPOSIX sessionに起動する。親の待機期限後は所有process groupへTERM、1秒後に必要ならKILL、さらに1秒以内に回収を確認する。回収失敗は実行エラーとし、所有Containerの外側期限を維持する。OS停止や未割当I/Oまで含む硬いHTTP応答保証を主張しない。

子は独立checkerで確認した案だけを一時ファイル→原子renameでcheckpointへ残す。結果ファイルと区別し、pendingの途中データを読まない。親は最大16 MBのファイルから入力hash・企業／チーム／月／各版・job／attemptを照合し、割当を独立checkerで再検査して目的ベクトルの一致も確認する。privateな一時保持であり、Container障害後の永続復旧を提供するものではない。

正常終了では実solver状態を維持する。期限終了では`termination=PROCESS_DEADLINE`と実行のUNKNOWNを記録する。検査済み案が残れば最終FEASIBLE、なければUNKNOWN／NOT_RUN。初期hint制限探索のOPTIMALを全目的の証明として返さない。子の異常終了、破損・古い入力・未検証の案はエラーで拒否し、残ったcheckpointを成功へ流用しない。親子の回収後にprivate directoryを削除し、例外時も同じ所有回収を行う。

計画（過去の私有資料・公開対象外）／実施結果（過去の私有資料・公開対象外）へ同源・同入力比較、追加の再検査時間、親子込みのcgroup peak、未検証範囲を残す。単体の成功をCloudflare互換性・全SDK受入・500人全操作5分の達成へ読み替えない。Cloudflare追加0、最終一括、定期backup保留・30日保管、試験導入範囲外を維持する。

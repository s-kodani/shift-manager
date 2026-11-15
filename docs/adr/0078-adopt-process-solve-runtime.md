# ADR 0078: 検証済み候補を保持するプロセス方式を通常設定へ採用

2026-10-14。R-01／TS-PERF／TS-API。状態：コード設定へ採用・ローカル互換性検証済み。Cloudflare稼働環境への反映・互換性受入は未実行。

[ADR 0077](0077-process-owned-solve-budget.md)の候補を通常の`mvp-joint-process-budget-v1`へ採用する。協調停止では解消できなかった長いCP呼出しを、所有子の実行期限・回収で管理するためである。時間短縮や希望品質改善を採用理由にしない。内部モデル120秒・v4・全候補・必須条件・段階目的・worker1／seed0は維持し、親の入力検証・結果再検査とHTTP転送は別計測とする。

架空500人30分・1 CPU／6 GiBで、内部120秒のまま親だけ75秒で止める専用診断を1回実行した。子exit -15／reaped、検証済み15,500行の保持、親・別HTTP check VERIFIED、評価`[0,0,379,110106000]`、全所有終了を確認した。75秒診断を通常の性能値に混ぜず、通常ジョブからは設定拒否する。

新しい架空1人チームの実ローカルD1／R2／Queues／DO／SDKで、profile120秒の初回変更→履歴→snapshot→計算→親検査→別check→物理停止→原子採用を1回確認した。試行1・FEASIBLE／VERIFIED・31行、子とContainerの回収・フェンス解除、架空資格情報失効・Cookie／private file削除、全所有終了を確認した。実施記録（過去の私有資料・公開対象外）に規模・状態・時間・検査範囲を残す。

Workerはconfigured profile、内部120秒・v4・covered-off、親待機120秒、childReaped・終了状態と親検査、期限時のUNKNOWN／残るFEASIBLEを保存前に照合する。独立HTTP checker・物理Container停止・最新入力版との原子照合を省略しない。子の報告だけを業務結果の採用根拠にしない。

`infra/wrangler.jsonc`のPoCコード設定、新規SDK／復旧元・復元先のローカル演習を更新する。比較用の旧profile・保存候補profile・過去の結果は保持し、演習は選んだconfigとの一致を検査する。ローカル基本設定の空profile（従来20秒）は変更しない。

残る制約：各CPのsoft limit超過、500人の希望品質・メモリ余裕、5業務／10パターン・異条件の性能、大規模の全SDK／UI時間、稼働中取消・障害・全復旧・G0／G1／最終Cloudflare受入。今回の中断1例とSDK1人で全条件の性能・互換性を保証しない。外側のHTTP期限とContainer停止を維持する。

Cloudflare配備・計算0、メール／AI送信0、最終一括、定期backup保留・30日保管、試験導入範囲外を維持する。

# ADR0112: 実ローカル検査の証跡によるCI代替

- 日付: 2026-10-15
- 状態: ユーザー明示承認・起動条件実装。正式凍結／Cloudflare未実施
- 根拠: [ユーザー決定ADR0111](0111-defer-github-actions-recovery.md)

CI復旧保留の指定に沿って、固定した実ローカル検査を実行し、CIは成功へ変更しない。`npm run check:final:local`は11コマンドを逐次実行する。Workerの全検証、Python数理、web build／test、PoC／backup dry-run、Semgrepルール、linux/amd64 image build、実Dockerの独立チェッカー境界／HTTP、imageを含む9項目のセキュリティ検査が対象。依存インストール・クラウド配備・500人の追加性能試験・メール・AI・定期backupは呼ばない。

各コマンドの上限は10分、ログ上限32 MB。失敗・中断後は次を開始せず、同じ所有記録を保持する。cleanな実HEADと全trackedファイルのSHAを開始／終了で照合し、コマンド・終了状態・ログSHA・image ID・security結果をprivate記録に残す。所有するimage tagだけを除去する。単なるPASSED記入、古いcommit、検査不足、失敗／中断、ログ改変は検証済みの記録として認めない。

初回は遠隔のCI代替を非実行のpatch候補（過去の私有資料・公開対象外）へ保存し、CI成功必須を維持した。候補の変更は独立レビュー、G0／G1、演習、復旧bindingと回数・時間上限を維持し、実ログ・同commit・固定imageとsecurity9項目の照合を追加するものだが、CI実行環境からローカルへ検査の根拠を変更する。

自動承認レビューがこの候補を含むコミットを拒否した。CI復旧保留だけでは遠隔の品質ゲート変更への明示承認がないことと、当初の全ops検証の4件がEPERMで未確認であることを理由としている。4件は必要なローカル実行権限で後に成功を確認した。固定11コマンドの実成功を添えて確認し、ユーザーが「ローカル証跡による代替を承認する（推奨）」と明示承認したため、提示した差分を適用した。最初の拒否と保留の記録は残す。

ローカル入口だけで正式凍結・Cloudflare互換性・G0／G1合格を証明しない。実施記録（過去の私有資料・公開対象外）に結果・候補・未完了を区別する。

## 承認後の起動条件

遠隔releaseは、CI成功、またはCIをHELD_NOT_SUCCESSとする実ローカル記録を使う。後者は同commitの固定11コマンド・全ログSHA・実image IDとsecurity9項目・source不変・所有tag除去を照合する。local-checksをprivate領域へ保存し、prepare／runでは現在のclean commit／全tracked内容を再確認する。token読取・HTTP前に、記録不足・古いsource・改変を拒否する。prepareはexecution-local-checksをarchiveし、status／cleanupは元の所有記録で終了を扱う。

独立レビュー、ローカル演習、復旧binding、G0／G1、4job／12attempt・check16・故障1回と30分／終了5分を維持する。ローカル記録が正しくても、この別条件が未完了なら起動を拒否する。正式凍結作成と遠隔の実一括はまだ行っていない。

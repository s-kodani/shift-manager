# ADR 0028: 遠隔復旧コピー・定期取得・鮮度監視

2026-10-11。WP-10／Q116〜117／TS-REC-02。[ADR 0027](0027-backup-retention-and-integrity.md)の30日保管を維持する。状態：遠隔保存・取得・専用復元・監視Workerは限定実装と実試験済み。GitHub Actionsの定期取得は設定済みだが、ユーザーの後続回答「定期実行の有効化は保留する」により無効を維持する（専用secretも未設定）。製品の勤務・公開・承認仕様は変更しない。

## 方式と理由

公式WranglerでD1をexportし、SQLと不変のR2参照を検査してから一組のZIPを専用非公開バケットへ保管する。Workerから独自に全テーブルをページ取得する方式は、一貫した復元点を証明できず採用しない。D1 exportはDB要求を一時停止するため、保守時間の取得と業務全体の停止・再開設計は分けて扱う。[D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。

`recovery/data/<UUID>.zip`を読み戻してサイズ・SHA-256を照合し、その後にだけ`recovery/complete/<UUID>.json`を置く。完成記録に元DB・バケット、元の取得／完成時刻、SQL・manifest・ZIPのSHA-256、件数、期限を結び付ける。再送・端末再構築では同じ凍結済みZIPとIDを使い、再公開で期限を延ばさない。ネットワーク失敗を「存在しない」と扱わず、確認済み404だけを未作成として処理する。

ZIP取得時は専用の新しい0700ディレクトリへ展開し、許可されたファイル名・件数・サイズ・重複・symlinkを検査する。SQL全テーブルと全R2本文を再検査した場合だけ採用する。既存コピーを上書きしない。Wrangler 4.149.0の単一R2アップロード上限に合わせZIPは300MiB以下、展開合計は512,000,000byte以下。大規模対応をこの上限設定だけで保証しない。

## 定期取得と認証

既存の無料OSS検査と同じく、固定SHAのActionsと`contents: read`を使う。取得候補はUTCの毎6時間17分。日次より余裕を持たせる実装判断で、ユーザーのRPO24時間という目標自体を変更しない。ジョブ排他・自動取消なし・30分上限を設定し、SQL・認証テーブル・ZIP・診断をActions artifactへ出さない。GitHubの実行遅延・欠落があり得るため、設定だけでRPO達成としない。[GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

専用アカウント対象の`CLOUDFLARE_BACKUP_API_TOKEN`をActions secretとして設定する。候補権限はD1 ReadとWorkers R2 Storage Write。PCのWrangler OAuthやGlobal API Keyを転用しない。REST用のR2権限はアカウント単位で、コードの固定対象チェックはトークン自体のバケット制限にはならない。S3用のObject Read & Writeトークンは別方式の候補として残す。[R2 tokens](https://developers.cloudflare.com/r2/api/tokens/)。専用トークンでのexport互換性・手動Actions実行は未検証。ユーザーが再開を指示した後、専用認証の成功を確認してから`BACKUPS_ENABLED=true`で有効化する。secret設定だけを有効化の許可とは扱わない。

活動中ジョブ・再検証を含むSQLは拒否する。ツールはWorker／Queues／DOを自動停止しない。架空データの専用PoCでの取得基盤であり、継続書込みを含む試験チームの保守制御は受入前に整備する。

## 30日の期限と監視

論理期限は取得完成時刻＋30日。期限到達したコピーはダウンロード採用を拒否する。専用Workerが毎時23分に、検査済みの期限切れ完成記録と対応ZIPだけを削除し、鮮度を検査する。archive削除後にmarkerを削除し、途中失敗を次回に照合できるようにする。元DB・元R2にはbindingを持たない。

専用R2には`recovery/`だけを対象とする30日lifecycleも設定する。lifecycleはオブジェクトの保存時刻から計算され、物理削除は通常期限後24時間以内である。遅れたアップロードや未完成ZIPの処理の補助であり、元の完成時刻に基づく論理期限を置き換えない。30日経過した実運用の削除はまだ観測していない。[R2 lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)。

鮮度は元SQLの取得開始時刻で評価する。18時間以上はAGING、24時間以上はSTALE。完成コピーなし・不正記録・archive欠落／サイズ違い・一覧上限超過も失敗とする。Cronは安全な件数・状態だけを構造化ログへ残し、失敗をthrowする。監視はmarkerとarchive存在／サイズを検査し、毎時全ZIPのSHA-256や内容照合は行わない。全本文検査は保存／ダウンロード／復元試験が担当する。

HTTPの`GET /health`と`POST /prune`は独立したランダムsecretで保護し、全応答をno-storeとする。SQLやZIPをHTTP配信しない。HTTP認証付きヘルスチェックと本物のCron配送は別の証跡にする。利用者へのシフト通知やResendメールは追加しない。監視異常を担当者へ配送する運用・監視経路自体の障害検出は未実装。

## 実施結果と残る受入

実PoCの65テーブル／30参照を遠隔保存し、元端末コピーを退避してR2だけから再構築、別の空D1／R2へ復元・全照合した。期限切れを模した専用fixtureの実削除と対象外／新しいコピーの保持を確認した。詳細は実施記録（過去の私有資料・公開対象外）・手順（過去の私有資料・公開対象外）。

継続取得、専用トークン、30日実経過、障害通知、別アカウント／プロバイダー喪失、実Queues／Containerフェンスとセッションの復旧、認証付き通常操作の再開、全サービスRPO／RTO、大規模・現場受入は未完了。同一アカウント内R2をアカウント全体喪失対策として扱わない。

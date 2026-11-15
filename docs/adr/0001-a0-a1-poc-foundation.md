# ADR-0001：A0〜A1の技術PoCと開発基盤

- 日付：2026-10-10（日本時間）
- 状態：PoC用の実装判断。製品全体の採用判断・G0通過は保留
- 関連：[実装計画](../shift_management_implementation_plan.md) PRE-06／WP-01・03、[技術スタック](../shift_management_technology_stack.md) STACK-01〜03
- 証跡：実施結果（過去の私有資料・公開対象外）

## 判断と理由

Workersは認証・短いDB処理・Containersへの入力転送を担当し、OR-Toolsと独立チェッカーはLinux／amd64 Containersで同時に実行する。ローカルWorkersにソルバーを載せず、将来の非同期ジョブを接続する前に実環境の互換性と整合性を検証する。今回の同期HTTPは保護した検証入口だけで、製品の計算APIとして採用していない。

| 項目 | 今回の実装判断 | 代替候補・採用前に残る確認 |
| --- | --- | --- |
| 開発基盤 | npm、TypeScript、Hono、Zod、Wrangler、uv、VitestのCloudflareプラグイン、pytest、ruff | pnpmは候補のまま。React／画面、PlaywrightはA2で接続 |
| 認証 | Better Auth 1.7.7のネイティブD1接続。初回変更は独自 `access_state` と全業務APIのミドルウェアで強制 | Drizzle経由は未比較。実メール・管理UI・全管理者権限は未検証 |
| DB | D1の短い `batch()`。操作挿入時のtriggerで入力版・状態版の不一致をSQLエラーにして後続処理ごと止める | 0行UPDATEだけでは失敗しないことを実測。製品スキーマ・承認条件・状態遷移の接続はA2。D1で必要条件を満たせなければPostgreSQL＋Hyperdrive |
| 原子操作 | 操作IDとpayload fingerprint、取消・参加解除・改訂前状態・監査・outboxを同じバッチで記録 | 外部Queues／R2へは原子性を拡張していない。実通知配送は未実装 |
| ソルバー | OR-Tools CP-SAT 9.14.6206、探索1ワーカー／seed 0、段階ごとの評価値を等式で固定 | 最終選定ではない。全体／段階モデル、係数精度、複数CPU・候補削減の比較が必要 |
| 資源 | `standard-2`、最大1、アイドル1分の専用PoC | 1 vCPU／6 GiB。月次費用・生存確認・クラッシュ復旧・チーム排他は未確定 |

D1は実際にロールバックできる範囲を確認するため、まずSQLを直接使用した。業務テーブルの設計やORM採用を確定したわけではない。認証テーブルは固定したBetter Auth版のスキーマに合わせ、企業・チーム・本人IDはアプリのmembershipで扱う。

## 試作契約と公開防止

`single-task-v0` は、資格を満たす仮想の単一業務、複数パターン、単一休憩算定設定、勤務ルール配列、勤務不可、希望、前月履歴、直接／算出需要の限定入力契約。勤務時間は整数分の半開区間で表し、出退勤・休憩は30分に整列する。30分圧縮区間によるソルバー集計はこの条件だけで正確とし、独立チェッカーは1分集合で再集計する。

係数尺度1000は実験値で、一般的な小数精度・丸め方式の採用結果ではない。ルール配列はすべてANDで適用し、企業・雇用区分・個人設定の継承管理はまだ接続していない。翌月の固定勤務は契約で拒否し、前月境界だけ扱う。

役割・スキル適格性の判定、多業務、イベント、固定・例外、公開後の維持条件を黙って省略して解くことを防ぐため、未知の入力フィールドを拒否し、結果を必ず `BLOCKED_POC` とする。分単位の切替・継続と半日取消は別の手計算用関数でのみ照合済みで、ソルバーへ統合していない。

`OPTIMAL`／`FEASIBLE`／`INFEASIBLE`／`UNKNOWN`／`MODEL_INVALID`と、`VERIFIED`／`HISTORY_UNVERIFIED`／`INVALID`／`NOT_RUN`を分離する。上位段階が未証明なら、その到達値を固定した後段が最適でも全体を `FEASIBLE` とする。探索予算から準備時間を差し引き、10%を検証用に確保するが、OSによる強制時間上限・製品の総時間保証は未実装。

## 実装時に確認した互換性

- Wrangler 4.149.0ではDO宣言に `exports` を使用。従来の `migrations` との併用はCLIが拒否したため、このPoCでは `exports` に統一した。
- Vitest 5／`@cloudflare/vitest-plugin` 1.4.0を使用し、実行環境をworkerdへ合わせた。古いpoolパッケージは採用しなかった。
- npm 10.9.8の通常peer解決で `edgesOut` エラーが起きた。`--legacy-peer-deps` に統一し、ロック・型・試験・ビルドで互換性を確認した。
- リモートD1移行ではtrigger内の `CASE ... END` 形式が `incomplete input` で失敗した。`SELECT RAISE(...) WHERE NOT EXISTS (...)` へ変更し、専用DBの移行と競合試験が通過した。
- Better Authのパスワード変更はセッションCookieを更新する。古いCookieでは拒否されるため、変更後Cookieを使う試験へ修正して確認した。

## 根拠

確認日2026-10-10。API・上限の今後の変更は再確認する。

- [Containersの導入](https://developers.cloudflare.com/containers/get-started/)、[インスタンス仕様](https://developers.cloudflare.com/containers/platform/limits/)、[料金](https://developers.cloudflare.com/containers/platform/pricing/)
- [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Better AuthのD1対応](https://better-auth.com/blog/1-5)、[メール・パスワード](https://better-auth.com/docs/authentication/email-password)
- [CP-SATの計算状態](https://developers.google.com/optimization/cp/cp_solver)

# ADR 0116：照合済み証跡から最終リリースを凍結する

2026-10-15。技術的な実行制御の採用。製品仕様・今回の範囲・品質ゲート・計算回数は変更しない。

## 決定

`npm run poc:final:freeze -- <cohort-root>`を、配備・観測後、最終検証のprepare前に実行する。手作業でFROZENへ書き換える方式は採らず、既存の同commitの独立レビュー・固定11コマンド／security9・実SDK演習・source/assetsコピー・資源割当・設定生成を再確認してから、4 Worker版・2 image・Queue・source資産の観測を照合する。

観測reportは5分以内、最後のidle preflightは既存規則の30秒以内を要求する。末尾でもpreflightを確認する。読み取り観測の直後に凍結する手順であり、その後の外部操作まで排除する保証ではない。

実IDを含む`recovery/binding.json`を一度だけ生成する。元DRAFTを`freeze/draft-release.json`へ保存し、15ファイルのSHAと凍結releaseのSHAを`freeze/state.json`へ結ぶ。所有ディレクトリを一度だけ作り、COMPLETEを最後に記録する。途中失敗・未完了ownerは自動再実行しない。releaseのみFROZENになった部分失敗も、COMPLETE受領記録がない限り開始不可とする。

prepare/runは現在のclean commitと証跡を照合する。status/cleanupと復旧先の読取は、元のexecution-releaseと保管済みの凍結記録・source/assets・演習ログを照合する。HEADや現在のreleaseが変わっても元ownerの観測・終了を可能にする。トークンはこの照合の後に読み取る。凍結コマンド自身はトークン読取・ネットワーク・Cloudflare操作を行わない。

CIはADR0112の代替を維持し、HELD_NOT_SUCCESSを成功に変えない。独立レビューを主担当が代行してAPPROVEDにしない。target資産は認証反映・fresh login後の既存17段階で比較するため、凍結時点では未検証のまま明示する。

## 証拠と限界

実施記録（過去の私有資料・公開対象外）の制御fixtureで成功と拒否を確認する。レビュー・CLI・Cloudflare応答は合成値であり、正式な承認・配備・凍結・Cloudflare受入の実績ではない。remote Worker本文の独自byte証明は追加せず、封じたsource、固定Wranglerの送信記録、100%版と再観測を既存方針どおり結ぶ。実リリースの独立レビュー、最新commitの全体演習・品質証跡、最終Cloudflare一括実行は残る。

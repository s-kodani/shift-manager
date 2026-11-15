# ADR 0064: 大きい復元値を保持してSQL文の長さを制限する

日付2026-10-13。WP-10／R-02・TS-REC。製品条件・DBの保存値・計算予算を変更しない。

## 問題と判断

架空101人の凍結コピーを別localへ復元した際、input_snapshotのJSONを含む108,460bytesの単一INSERTが`SQLITE_TOOBIG`で拒否された。D1の[SQL文上限](https://developers.cloudflare.com/d1/platform/limits/)は100,000bytesで、行／文字列の上限2MBとは異なる。1行ずつのINSERTでも解決しない。

prepare-importは64,000bytesを超えるINSERTのVALUES行をSQL引用符と括弧を認識して分ける。長いTEXTは8,000文字ずつ、引用符を再エスケープして専用staging tableへ入れ、順序付きgroup_concatで元の値を構成する。各文のUTF-8長を検査し、stagingを除去してからVIEW・triggerを設置する。変換前後の全schema／表内容／参照catalogと、FK有効のtransactionを照合する。値の省略・丸め・分割した値の製品保存、DB上限の緩和は行わない。

大きな複数VALUESは行ごとに分ける。対応できない巨大INSERTや変換後の超過は準備段階で拒否する。復元先は引き続き空で隔離された環境に限定し、完全照合前に認証・業務を再開しない。stagingは製品のmigration／運用表には追加しない。

## 失敗したimportの扱い

DISPATCHEDを時刻で失敗扱いにしたり、restoreを盲目的に再送したりしない。今回だけ、元のCLIのexit1・既知のSQL長拒否・同じtargetの業務schema0を確認し、別の修正版ファイルを同じtargetへ1回明示実行した。元backup・元import・receiptを保持し、同IDreconcile-importで全catalog一致を証明してから未実施のR2コピーを続行した。この診断は一般の自動retry機能ではない。

## 証跡と限定

Unicode・引用符・改行・セミコロン・括弧・行区切りを含む長いTEXTを、SQLiteの実際の100KB制限下で復元し、catalog・VIEW・不変triggerを照合する。実workerd D1でも同じ101人コピーの全SQL／R2・認証付き業務本文一致と計算再開を確認した。実施記録（過去の私有資料・公開対象外）を参照する。

単発・架空101人の診断である。500人コピー、処理中／配送中・復旧元不在、反復、本番RPO／RTO・G0〜G2を完了とはしない。Cloudflare追加実行0、最終一括・定期backup保留・30日保管を維持する。

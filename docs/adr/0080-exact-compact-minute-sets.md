# ADR 0080: 正確な分集合を不変bit集合で保持・共有する候補

2026-10-14。R-01／TS-PERF-04。状態：技術候補、通常未採用。時間区間・候補・必須条件・段階目的を変更しない。

前回の5業務／10パターン500人は6 GiB上限でOOM killとなった。具体的なOOM工程は未記録だが、本体は候補ごとにactive分をPython setとして保持する。分の数が多い候補・スタッフ・日を掛け合わせた保持量を減らすため、0〜1439の整数分を1bitずつ表す不変MinuteSetを追加する。

休憩・取消・予定の除外は同じ整数区間の差集合で行い、7分等を丸めない。集合のmembership・列挙・長さ・積／差／和・subsetは有効な分集合上でPython setと照合する。1つのsolve内だけで同じbitsの集合と端点・枠別count／firstを共有し、別企業・別requestにcacheを持ち越さない。共有事実は読取専用で使う。

`mvp-joint-compact-minutes-v1`だけcalendar rosterとcompact flagをTrueにする。通常のprocess profileはcompact False。分集合の保持表現と重複計算だけを変え、本体の候補・変数・制約・目的と、独立checker・検査済みincumbent・版照合を維持する。

計画（過去の私有資料・公開対象外）／実施結果（過去の私有資料・公開対象外）に集合全比較、準備・予定・取消・保存候補・両優先順位の全CP proto、5業務／10パターンの初回proto、101／500人の実測と未達を記録する。単体bytes比較を全体メモリ・500人受入へ読み替えない。Cloudflare追加0、最終一括、定期backup保留・30日保管、試験導入範囲外を維持する。

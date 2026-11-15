# ADR 0100: 通常初期案を優先するcalendar fallbackを通常設定へ採用

2026-10-14。状態：コード設定へ採用、ローカル品質比較・実SDKの採用／公開を確認。Cloudflare稼働環境への反映とG0／G1の正式判定は未実施。

[ADR0099](0099-reject-unconditional-calendar-default.md)で全面calendarは3業務／2パターンの品質を悪化させたため見送った。新しい`mvp-joint-calendar-fallback-v1`は従来のcovered-off初期案を先に試し、独立検証済み案を取得できずsaved案経路でもない場合だけ、残る初期探索予算でcalendarを補助に使う。従来案があればcalendarを呼ばない。旧通常・全面calendar・保存案・診断profileは過去比較のため保持する。

全候補・必須条件・段階目的・独立checker・内部120秒・worker1／seed0を維持する。制限seedの失敗を原問題の解なしへ変換せず、限定OPTIMALを全体の証明にしない。補助案の独立検査と辞書式評価、上位の保護、親の子回収・再検査、別HTTP check、物理停止先行、版照合・原子保存を維持する。Workerはfallback=true／全面calendar=falseの設定も照合する。

同じ架空101人30分の入力SHAで比較し、3業務／2パターンは通常評価[0,0,80,33822000]を維持してfallback未呼出し、5業務／10パターンは通常UNKNOWNに対してfallbackで[1050000,33774000,101,11820000]のFEASIBLE／別check VERIFIEDを取得した。一般不足・希望未充足は残り、全面改善・最適解・全条件保証とはしない。

freshのローカル101人登録fixtureで実Queues／DO／Containers SDKを通し、試行1・FEASIBLE／VERIFIED・3131行→下書き採用→再検査・公開→本人31日／通知1件を確認した。子とContainerの停止・全所有回収・102資格情報失効を照合した。Native比較の入力族と実SDK登録入力は異なるので、評価や時間を直接比較しない。

PoCコード設定、新規ローカルSDK・復旧元／先演習の通常profileへ採用する。空profileのローカル基本設定と過去データ／既存稼働環境は変更しない。`--process-profile`は従来profileの1人互換試験を保持する。Cloudflare配備は最終一括に残す。

実施記録（過去の私有資料・公開対象外）／計画（過去の私有資料・公開対象外）。複雑500人の処理量・メモリ余裕の改善はADR0098により後続。運用・メール・AIと試験導入は後続、backup HOLD／30日を維持する。

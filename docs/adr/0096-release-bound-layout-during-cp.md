# ADR 0096: CP呼出し中の検証済みlayout解放

2026-10-14。R-01。状態：小規模の一致・再読込拒否を確認。500人でRSS約0.51 GB減・OOM0を観測したが、90秒期限で有効案なし。大規模の再読込・抽出・独立checkと通常採用は未確認。

前回の同モデルではlayout parseで約0.52 GBのRSS増加を観測し、復元完了後のCP seed中にOOMした。全layoutを先に検証する扱いは維持し、分離solve診断だけCP中の保持をやめる。Python内部release_layoutの既定はfalse、通常Worker profileは変更しない。

model・全制約・hint・目的式・search／seed設定を維持する。main presolve boolだけを保存し、layout参照を解放する。CPが有効案を返したらbounded readで元のmanifestのbytes／SHAに一致するlayoutだけを復元し、同じindex／外部mapで抽出して独立checker・CP評価値一致を確認する。symlink・削除・同長改変を拒否する。解がないときは読み直さない。抽出後も不要な全layoutとsolution値のlistを保持しない。

GCやallocatorの性質により、参照解放だけでRSSが減る保証はない。解が返った後のreload／抽出／checkerのpeakと時間も別に評価する。メモリの測定・CP有効案・品質・通常採用を混同しない。計画（過去の私有資料・公開対象外）／実施記録（過去の私有資料・公開対象外）。

Cloudflare追加0、最終一括・定期backup保留／30日、試験導入範囲外を維持する。

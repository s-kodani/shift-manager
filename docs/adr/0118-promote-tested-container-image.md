# ADR 0118: 検証済みコンテナimageを再ビルドせず配備する

2026-10-15。技術実装の決定。製品仕様・最適化profile・MVP範囲・費用上限は変更しない。

## 実測と問題

`9e5cd82`の固定11検査／security9、実SDKの4job／5attempt・復旧17段階と終了確認は成功し、G0／G1もローカル範囲を承認した。その後の最終配備で、既存DO namespaceに別名のContainer applicationを作ろうとしてWranglerが失敗した。Workerの新versionは既に100%配備されており、CLI失敗を未配備と扱わない。活動中job・再検証・稼働processは0、未使用の復旧先D1／R2／Queueは所有照合後に回収した。機能4job・Cloudflare solveは未開始。

ローカル診断では、0600のコピーから作ったimageが非rootユーザーでPythonをimportできなかった。0644／0755へ補正すると内容・権限は一致したが、COPY対象の時刻などによりimage IDが変わった。権限補正だけをimage同一性の成功とはしない。

## 採用する方法

固定11検査とimage込みsecurity9を通った正確なimage IDを`docker image save`でprivate archiveへ保存し、サイズ・SHAを品質記録へ結び付ける。所有検査tagは従来どおり削除する。新しい最終候補ではarchiveを必須とし、資源作成・認証読取り前に`poc:final:image`でloadして、実load出力・inspect ID・source／plan不変を確認する。既存のローカル記録は旧結果として読めるが、archiveなしでは新しい資源割当を開始できない。

配備ownerは同archiveを再照合してloadし、cohort専用tagを一度pushする。生成設定のimageはそのregistry参照に固定し、再buildをしない。push後もregistry config digestと検査image IDの一致を別途観測する。失敗・不明は同ownerの再実行を拒否し、所有tagだけを照合して回収する。

source設定は既存Container application名を明示し、復旧先には別名を使う。API観測は実応答の`vcpu`・`memory_mib`・`disk.size_mb`とQueue consumerの`script`を照合する。任意の旧aliasが併存する場合も矛盾を拒否し、上限・binding・image一致条件は維持する。

公開コードのコピーはファイル0644／実行ファイル0755、directory0755をmanifestへ結び付け、外側のcohort directory0700で保護する。旧封印コピーの読み取り規則は維持する。

## 代替と未検証

COPY時刻・build cacheへ依存した再build、image ID一致条件の緩和、既存Container applicationの削除は採用しない。検証済みimageのsave→load→非root importはローカル実機で成功。新配備経路のCloudflare push／rollout・最終4job／復旧は未実施。同commit検査・演習・独立レビュー・正式凍結を改めて揃えてから実行する。実施結果（過去の私有資料・公開対象外）。

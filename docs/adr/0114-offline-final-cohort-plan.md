# ADR0114: 最終確認用ソース・資産・復旧設定のオフライン準備

2026-10-15拡張：image・bindingの読取観測（過去の私有資料・公開対象外）を追加。配備時の版IDを実資源・namespace・registry config ID・source配信SHAへ結び付け、途中変更を拒否する。Docker image IDとmanifest digestを混同しない。target資産は復元後に残し、観測を正式凍結・受入に読み替えない。対象6／全補助161／security7成功、実Cloudflare0。

2026-10-15拡張：配備制御とWorker版観測（過去の私有資料・公開対象外）を接続した。実品質・一括演習・資源を前提に、元schema／idle、単発4配備、100%版／tagを確認する。生成する最終cohortはmail disabledのため未使用Resend secretを必須にしない。元secret継承とtarget専用secretを分け、image／binding／正式凍結・実配備の完了とは区別する。全補助155／security7成功、Cloudflare操作0。

2026-10-15拡張：最終セッションの資源割当／観測入口（過去の私有資料・公開対象外）を追加した。PLANNED単独では起動せず、実独立レビューの生レポート・同commit固定11コマンド／security9の証跡・plan SHAをtoken前と要求前に照合する。3資源の単発POSTとGET記録を既存の設定生成へ接続する。制御応答での対象13／全補助149／security7成功であり、真正な割当・配備・正式凍結の完了ではない。

- 日付: 2026-10-15
- 状態: 実装・補助テスト済み。正式凍結・資源割当・Cloudflare未実行

最終確認のDRAFTに、同じclean commitの追跡ファイル全体、画面ビルド資産、33移行SQL、optimizer源、元アプリ／運営者・復旧先アプリ／運営者の設定をまとめる。入力・ケース・費用上限・各ファイルと設定のSHAを記録する。設定のentry・Docker context・migration・assetsは準備したコピーを参照し、後の作業ファイルを暗黙に使用しない。

これは既存の凍結release・実ローカル検査・独立レビューの前段である。状態はPLANNED、承認PENDING、image未確認、復旧先D1／R2／QueueはUNALLOCATEDとし、架空の実環境IDやFROZENを生成しない。DB設定の`NOT_ALLOCATED`は未割当の明示であり、配備設定として使用してはならない。元のDRAFTと未凍結起動拒否を維持する。

元と復旧先を別名・別Queue／R2／D1にし、復旧先cronを有効にしない。通常calendar profile、standard-2／max_instances 1、mail／AI disabledと既存費用上限は維持する。token読取・ネットワーク・solverを使わない。途中失敗は同じ所有領域にFAILEDを残し、同領域を上書きして再試行しない。

正式な資源割当・実image／配備版照合・binding凍結・全体driverへの接続は後続の有限作業とする。実行手順と結果（過去の私有資料・公開対象外）。製品仕様・今回対象範囲・独立レビュー・最後のCloudflare一括方針を変更しない。

復旧側もこのコピーを参照し、source／asset manifestと全実ファイル・設定SHAをreleaseへ照合する。ローカル品質代替を使う場合は検査済みsource SHAとコピーのsource SHAを一致させる。旧作業ディレクトリへ参照を戻して通す互換処理は追加しない。正式な新profileにはコピー証跡が必要であり、元運営者設定のbyteも準備時から維持する。

資源観測の保存記録から同sourceの3設定を一度だけ作るローカル接続（過去の私有資料・公開対象外）を追加した。状態はMATERIALIZED_NOT_DEPLOYED_NOT_FROZENで、ファイル形式の照合を真正な実API観測／配備／凍結とみなさない。記録収集と実在・版の照合は最終一括へ残す。

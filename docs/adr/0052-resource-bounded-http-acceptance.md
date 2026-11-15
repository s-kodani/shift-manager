# ADR 0052: 認証・登録・固定再計算を含む資源制限付きHTTP試験

日付: 2026-10-12。状態: ローカル検証基盤。MVP全受入・Cloudflare互換性・性能達成は別判定。

## 判断

準備済みsnapshotの資源試験では、登録されたID・入力版・固定・例外・公開・本人権限を含む経路の資源リスクを確認できない。既存の500人HTTP受入を縮小せず、同じ所有Dockerへ1 CPU・6 GiB・追加swapなしを開始前から適用する。通常プロファイル、探索120秒、solve＋別checkの通信150秒は変更しない。既存の初期計算・手動固定・固定再計算・不足承認・公開・本人限定表示・資格情報終了を全て実行する。

`NATIVE_RESOURCE_SCOPE`でprepared-snapshot／http／registeredを明示する。対応するモードと人数を照合し、混在・101人への縮小・保存候補プロファイルは拒否する。test runnerでも同じ契約を検査し、資源上限の指定だけでprepared-snapshot試験へ置き換わる旧選択順を修正する。`test:compute-bounded-http-native`はhttp／500人を指定して1ケース実行する。失敗を自動再試行・プロファイル切替で置換しない。

UUID・scope別の証跡へ実イメージ、全Python SHA、fixture SHA、Docker inspect、kernel cgroup観測、テスト本文と終了状態を残す。登録前から上限が適用された実コンテナだけを使用する。source不一致・欠落観測・OOM・所有終了失敗を成功として扱わない。既存コンテナを停止しない。

## 代替案・未検証

資源無制限のHTTP受入だけでは上限下の動作を証明できない。prepared-snapshot試験はモデル比較に維持するが、登録／認証の代替にはしない。実SDK／Queues／ブラウザーにも上限を適用する検証は後続に残す。このHTTP試験のQueue配送とDO RPC／終了callbackは制御adapterで、実SDKの起動・終了・再起動は証明しない。Docker quotaはCloudflareのCPU速度とdiskを再現しない。

試験成功と、手動参照以上の目的品質・希望の品質・5分目標達成を区別する。製品仕様、Cloudflareのサイズと計算予算、定期バックアップ有効化保留／30日、メールdisabledを変更しない。結果は実施記録（過去の私有資料・公開対象外）へ分離する。

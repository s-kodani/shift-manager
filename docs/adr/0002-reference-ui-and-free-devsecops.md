# ADR 0002: UI参照保存と無料DevSecOps

日付: 2026-10-10。状態: 開発プレビューとOSS検査基盤を実装。製品フロントの採用・G1合格とは区別する。

## 背景と判断

ユーザー指定モックのHTML/CSS/JSをリポジトリへ保存し、外観と導線を維持する。保存版の画面表示は設計0.9で、最新設計書0.10とQ&Aを正本にする。ブラウザ取得のJS/CSSはハッシュで固定し、HTMLの再構成と生成物への適応を記録する。

元JSにはinlineイベント・innerHTML・ブラウザ保存による模擬状態遷移がある。すぐに業務APIや認証と同じ権限で実行する方式は採用せず、ローカルのsandboxプレビューへ組み込む。永続originとAPIアクセスを与えず、実業務の公開・承認を行えない構成にする。React/TypeScriptへの製品実装は次工程の候補で、画面モック取り込みだけで実装済みとしない。

非公開GitHubリポジトリで追加有料ライセンスを前提にしないため、Gitleaks CLI、Semgrep Community Edition、Trivy、actionlintをローカルとActionsに配置する。CLIは公式配布の版・ハッシュとuv.lockで固定。ActionsはSHA固定、contents:read、短期成果物、同時実行取消、時間上限を用いる。Dependabotはnpm/uv/Docker/Actionsの更新PR設定を追加し、auto-mergeは行わない。

## 代替案

- private CodeQL/SARIFのGitHub code scanning表示: 契約・利用条件の確認を要するため、今回の無料構成には含めない。JSON成果物で検査する。
- Gitleaksの第三者Action: CLIはMITのOSSで、Actionには組織利用時の別条件があるため公式CLIを直接使う。
- Semgrep cloud/Pro: 送信・契約を増やさずCEのローカル検査を用いる。8つの禁止パターンだけでは網羅的SASTにならず、権限・D1・認証試験とレビューを継続する。
- 素のモックを本番APIと同originで配信: 隔離を失い、旧デモ判定の仕様流用につながるため採用しない。

## 影響・検証

製品仕様・APIの状態遷移・OR-Toolsモデルは変更しない。セキュリティ検査でProtobuf 6.31.1のHigh指摘を検出し、公式OR-Toolsの依存上限のため9.14.6206から9.15.6755へ、Protobufを6.33.6へ更新した。コンテナのPython 3.11系も更新し、実行時に不要なpip/setuptools/wheelを取り除く。ロックとハッシュ付きrequirementsを同期する。

導入結果・限界・公式資料（過去の私有資料・公開対象外）を参照。過去のCloudflare Containersの計測は旧イメージ・OR-Tools 9.14での証跡として保存し、新版の性能・実環境互換性の証明に流用しない。

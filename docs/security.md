# セキュリティ検査と依存管理

検査は無料のOSS CLIをローカル／CIで実行し、クラウドのコード解析サービスへソースを送信しません。GitHubの運用資格情報は不要です。

```sh
npm run security:install
uv run --project tools/security --frozen semgrep --test security/rules
npm run security:check
```

Gitleaksは全Git履歴と現在の非無視ファイルを検査します。Semgrep CEはリポジトリ内の8ルールを使い、metricsとversion checkを無効化します。Trivyは開発依存を含むlock・Dockerfileと、指定された実イメージを検査します。actionlintはActionsを確認します。検査失敗・実行エラーは非0です。閾値の緩和や包括除外で合格にしません。

実イメージは次で確認します。公開イメージの配布はしません。

```sh
docker build --platform linux/amd64 -f services/optimizer/Dockerfile -t shift-manager-security .
SECURITY_IMAGE=shift-manager-security node scripts/probe-container.mjs
SECURITY_IMAGE=shift-manager-security npm run security:check
```

結果・SBOMは`artifacts/security/`に生成され、Git対象外です。CI artifactのアップロード対象にも秘密値や個人情報を入れません。公開前に内容を点検します。SBOMは依存の一覧であり、ライセンス適合や網羅的な脆弱性保証の完了を示しません。

## 限定した依存override

Hono 4.13.16、Zod 4.6.6、Undici 7.30.1を使用します。Zod／Undiciのnpm overrideは開発ツール内の旧コピーにも適用されます。型・API・クライアント回帰と依存解決を確認し、上流で不要になったら解除を検討してください。

セキュリティツールだけのPython環境では、Semgrep 1.180.0の上流制約が旧MCP／OpenTelemetryを固定しているため、`tools/security/pyproject.toml`で整合する修正版へ限定overrideしています。CLI、telemetry／MCPのimport、8ルールの試験、通常走査で互換性を確認します。`uv pip check`だけを採用判定にせず、上流で制約が解消したらoverrideを再評価してください。

## SQLite／zlibと期限付きVEX

Dockerの実行層は公式Debian配布物のSHA-256とdpkg版を固定してSQLite 3.54.1-2、zlibのDebian修正版を導入します。非root・shellなしを維持し、全ELFリンク・SQL／FTS5・圧縮・HTTP solve／独立checkを実イメージで確認します。arm64用hashの登録を、arm64の実行検証済みとは扱いません。

TrivyのDebian安定版DBと公式sidの修正状態の差は`security/sqlite-fixed.openvex.json`に記録しています。完全一致する3 CVE・libsqlite3-0 3.54.1-2・amd64・Debian13.7だけが対象です。再確認期限は**2026-12-14**で、期限後は検査を停止します。`--show-suppressed`で元検出と判定を保持し、VEX未適用のSBOMも保存します。対象拡大・未来発行・31日超の期限を拒否する検証を維持してください。DBが整合したら削除し、根拠を確認せず期限だけ延長しないでください。

[脆弱性の報告](../SECURITY.md)、[Debian SQLite情報](https://security-tracker.debian.org/tracker/CVE-2026-119374)、[Debian zlib情報](https://security-tracker.debian.org/tracker/CVE-2026-85091)。

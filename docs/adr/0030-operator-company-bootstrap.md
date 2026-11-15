# ADR 0030: 運営者による企業・初期管理者の発行

2026-10-11。WP-01／TS-NEW-15、Q106・Q107・Q99。状態：限定実装、ローカルD1と専用Cloudflare PoCで検証済み。製品の権限、初回変更、通知、勤務条件を変更しない。

## 実装判断

既存の企業発行helperには運営者の実行入口がなかった。専用Workerと信頼された端末のCLIを追加し、企業・最初の企業管理者だけを発行する。通常の業務API、認証API、スタッフ検索・更新、R2・Queues・Container・AI・メールへの入口やbindingを追加しない。一般の自己登録は引き続き閉じる。

PoCでは独立した32byte乱数のBearer secretを用いる。PoCの閲覧用Bearer、Better Auth secret、バックアップ監視secretを転用しない。固定の運営者識別子はWorkerの設定から記録し、要求本文から指定できない。ブラウザーのOriginがある要求を拒否する。これは単一運営者の技術候補で、複数運営者のSSO・個人別認証・失効管理や本番のアクセス設計を確定したものではない。Cloudflareの管理権限でD1を直接操作できる範囲はHTTPの限定権限より広く、別途管理する。

## 原子保存と再送

CLIが操作ID・本人ID・資格情報IDと初期パスワードを作り、送信前にprivateな所有記録と引渡しファイルを永続保存する。平文パスワードを端末・応答・Workerへ出さず、既存Better Auth 1.7.7の`hashPassword`で作ったscryptハッシュを送る。同版のWorkers上のログイン・初回変更と互換性を確認した。ハッシュのencodingを将来版にも通用する仕様とせず、認証依存更新時に再検証する。

単一D1 batchでuser、account、access_state、company、company_admin、不変の操作記録、product_auditを保存する。初期の製品権限は企業管理者、Better Auth全体のroleは`user`、初回変更は必須。監査失敗時は全部をロールバックする。操作記録へのSQL guardは企業版0・唯一の初期管理者・有効かつ初回変更必須を検査する。

正規化した要求のSHA-256と操作IDを結び、完全に同じ再送は最初の結果を返す。異なる要求・別IDによるメール重複を409にし、追加の企業・資格情報を残さない。操作記録は更新・削除できず、現在の企業版・後続スタッフ・認証情報を返さない。保存するのは初期発行時の識別子・運営者・fingerprint・日時だけで、平文／ハッシュ／生の要求を含めない。

CLIは送信前にDISPATCHEDを記録する。応答喪失・5xx・不正な応答はUNCERTAINとし、同IDをinspectする。記録が見つからないだけでは旧要求の停止を証明できないため、未知の要求を自動再送しない。明確な4xx拒否と未送信のPREPAREDだけが、inspect後に凍結した同一要求を送れる。実行手順は運用手順（過去の私有資料・公開対象外）を参照する。

## 秘密の引渡しと残事項

端末のディレクトリ0700／ファイル0600、symlink拒否、原子的なrenameとfsyncで引渡しファイルを保護する。これは暗号化保管庫ではなく、信頼されたOS利用者の端末保管を前提とする。端末・秘密管理と本人への安全な引渡しは運用者が担当し、メール自動送信を追加しない。平文パスワードの再発行／現在パスワードの照会は提供しない。

JSONの実読取4096byte、正しいUTF-8、strict schemaを要求する。応答はno-store、例外は汎用codeにし、秘密やDBエラーをログへ出さない。実施結果（過去の私有資料・公開対象外）に成功、初期失敗、配備、未検証を分ける。tokenの本番保管・ローテーション、独立した運営者による引渡し、実チーム受入、全体の認証安全性を残す。定期バックアップの有効化保留は維持する。

参照：[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Workersの実装指針](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。実際のBetter Auth 1.7.7のcrypto実装とWrangler 4.149.0の設定・CLIも照合した。

# ADR 0029: 認証要求の原子的な回数制限と入力境界

2026-10-11。WP-01／TS-AUTH、Q107の初回変更とメール再設定を維持する。状態：限定実装、ローカルD1・専用Cloudflare PoC・画面で検証済み。勤務条件・権限・通知・30日バックアップの製品決定は変更しない。

## 実装判断

Better Auth 1.7.7のHTTP handlerに`customStorage.consume`を接続する。メモリ内カウンターではWorker間で上限を共有できず、読み取り後の別更新では同時要求を安全に制限できないため、D1の単一`INSERT … ON CONFLICT … UPDATE … RETURNING`で増加・期限更新・判定を行う。失敗時は認証処理／メール送信を開始しない。入力不正はカウンター消費前に拒否する。

カウンターの鍵は専用namespaceを含むHMAC-SHA-256。メール・IP・再設定トークンの原文を保存しない。窓の期限は最初の要求から固定し、拒否された要求で延長しない。期限到達時に次の要求で再開する。期限切れの行は既存scheduled handlerで削除し、勤務・監査原本とは分ける。secret変更では旧カウンターを引き継がない。

IPを先に検査し、枯渇後のメール／トークン変更によるsubject行の増加を防ぐ。IPは`CF-Connecting-IP`だけを読む。Better AuthのIPv6正規化・/64単位、IP不在時のpath別共有bucketを使い、利用者指定の`X-Forwarded-For`を信用しない。Cloudflare直結の入口を前提とし、別proxyや同zone Workerを経由する場合は信頼境界を再確認する。

| HTTP操作 | IPの窓・上限 | 別の鍵の窓・上限 |
| --- | --- | --- |
| ログイン | 60秒・100要求 | 小文字化メール：60秒・20要求 |
| 再設定メール要求 | 1時間・20要求 | 小文字化メール：1時間・3要求 |
| 再設定の確定 | 60秒・20要求 | トークン：60秒・10要求 |
| 認証済みパスワード変更 | 60秒・20要求 | 本人ID：60秒・10要求 |

上限値は調整可能な技術判断で、製品要件や性能達成値ではない。多数利用者が同じIPを使う環境での検証を残す。session取得とログアウトは回数制限から除外する。サーバー内部の`auth.api`はHTTP limiterの対象外なので、外部へそのまま公開しない。運営者発行の実運用導線には別途権限・監査を確認する。

## 入力・画面

認証POSTは同一Origin、JSON、実読取4096byte以内、正しいUTF-8、操作別のstrict schemaを要求する。余分なフィールド、外部の再設定redirect、長すぎるパスワード／トークンを拒否する。再設定redirectは`AUTH_BASE_URL + '/reset'`のみ。再設定メールの既存／非既存アカウントは同じ受付応答・上限とし、メール未設定時は照合前に一律503を返す。

429は`Retry-After`・`X-Retry-After`・no-storeを返す。画面は待ち時間を表示する。自動再送、カウントダウン、待ち時間に応じたボタン無効化は実装していない。送信障害の応答を使ったアカウント列挙を防ぐ既存の汎用受付応答も維持する。

専用PoCはBearer確認後に既知の認証APIだけを製品handlerへ転送する。公開reset画面・トークン検査付きreset POSTと、それ以外の非公開入口の区分を維持する。

## 実施結果・未検証

実施記録（過去の私有資料・公開対象外）に同時要求、期限、正規化、入力、実Cloudflare、PC／390pxを分ける。Resendの実送信は今回行っていない。送信元ドメイン未定のため製品メールはdisabled。分散した多数IP／多数アカウントによる攻撃、全体のD1負荷・費用・清掃規模、実端末と共有IP、濫用監視・運用受入は未検証。CAPTCHAやWAFは別候補であり、採用済みとは記録しない。

参照：[Better Auth rate limit](https://better-auth.com/docs/concepts/rate-limit)、[Cloudflare headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)、[D1 API](https://developers.cloudflare.com/d1/worker-api/d1-database/)。公式資料と実際のインストール済みhandlerを照合した。

# ADR 0068: 最初のDocker削除確認と後続404を別に記録する

日付2026-10-13。対象WP-04／10・R-02・TS-REC。基点9ba30dfb08f025d1627cba60115aa3b227bb7d0e。製品のstop／fence／保存・公開条件を変更しない。

## 原因と判断

旧ローカルゲートは既知の所有ID／名へのDELETEが204または404を返すたびに`deletedAt`を代入した。SDKの再起動・shutdown・後続cleanupで、削除済みの同じ名へDELETE404が来ると、元の削除時刻が後の不在確認で上書きされた。前回の一体復旧診断で、この最後の時刻とjobの終端を比較したため、停止契約に疑義が残った。

最初の204／404確認時刻・statusを一度だけ保存し、全DELETEの受信・転送・応答時刻とstatusを追加履歴へ残す。最初の404はその時刻の不在確認であり、実際にいつ削除されたかを意味しない。first statusも残して204と区別する。既知IDの再DELETE／waitと、未所有資源のmutation拒否は維持する。

## 独立した確認

loopback専用Worker／DOを作り、現行Container SDKと実Dockerでhealth→製品と同じ`confirmProcessStopped`を実行した。JSON／boundedの2ケースともresponse body locked=true、SDKのstop応答時の独立Docker inspectは不在だった。読み取り方法だけで差が出るという仮説は、この2ケースでは支持されなかった。[Container APIのdestroy契約](https://developers.cloudflare.com/containers/api/durable-object-container/#destroy)を参考にするが、文書の契約を実測の代替にはしない。

修正後にfresh架空101人の通常入力から1jobを実SDK・1 CPU／6 GiBで実行した。初回のDocker DELETE204応答は保存済みD1終端timestampより69ms前、独立read-only observerはSUCCEEDED時のDocker404を確認した。後続404は別時刻で保存され、最初の時刻は維持された。正常1ケースの結果採用前停止の証跡が進展した範囲だけを更新する。

実施結果（過去の私有資料・公開対象外）／事前計画（過去の私有資料・公開対象外）。以前のraw JSON・時刻・失敗を修復・書換えしない。既存の後続404上書き前の時刻は復元できないため、過去ケースへ新しい独立観測を流用しない。今回の正常例を、故障・取消・再検証・処理中／配送中復旧・Cloudflareの全契約へ広げない。

小さいprobeは業務データ／DB／Queue／R2なし、local-onlyとmachine tokenを検査し、本番／PoC entryへimportしない。正常probeは102資格情報と全所有資源を終了した。Cloudflare追加配備／計算0、定期backup保留・30日保管、MVP／G0〜G2の未完了を維持する。

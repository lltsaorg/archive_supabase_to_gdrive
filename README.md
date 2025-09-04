# Supabase → Google Drive 月次アーカイブ（Yangon）/ Gmail通知

## 目的
- Transactions / ChargeRequests の 半年以上前（既定）のデータを、毎月1日（Asia/Yangon）に CSV として Google Drive へ保存
- 実行した月初のみ Gmail API（OAuth2）で結果を通知
- 月初以外はスキップ（通知なし）

## 構成
- Runner: GitHub Actions
- Main: `scripts/archive_multi_to_gdrive.js`
  - Yangon の月初判定
  - カットオフ（当月1日 00:00:00 Yangon ≒ UTC 前日 17:30）から指定「何ヶ月前」へ
  - Supabase RPC で staging へ移動 → CSV 生成 → Drive へアップロード → staging クリア
  - `result.json` を出力（`executed: true/false`）
- Mail: `scripts/send_gmail.js`
  - `result.json.executed === true` のときのみ送信
- Workflow: `.github/workflows/archive.yml`
  - `cron: "35 17 * * *"`（毎日 17:35 UTC = Yangon 00:05）

## 主要仕様
- 対象テーブル: `Transactions`, `ChargeRequests`
- 基準列: `Transactions.created_at`, `ChargeRequests.requested_at`
- 対象期間: ヤンゴン月初基準で「CUTOFF_MONTHS_DEFAULT ヶ月前より古い」
- バッチサイズ: `BATCH_SIZE=10000`（環境変数で変更可）
- CSV:
  - ヘッダ = 退避 JSON の全キーのユニオン（ソート）
  - 保存名: `Transactions_archive_until_2025-04_1712345678901_<runid>.csv` の形式
- Drive 保管先: `GDRIVE_FOLDER_ID_TRANSACTIONS` / `GDRIVE_FOLDER_ID_CHARGEREQUESTS`
- staging 後処理: アップロード成功後、該当 `run_id` の行を削除
- 出力: `result.json`
  - スキップ時: `{ "executed": false, "reason": "not-first-day-yangon" }`
  - 実行時: `{ "executed": true, "cutoff": "ISO-UTC", "cutoffMonths": N, "results": [...] }`
- 通知: `executed:true` のときのみ Gmail API で送信（結果は成功/失敗含め通知）
  - メール本文に「何ヶ月前」を併記します

## 事前準備

### Supabase
- 以下のオブジェクトを作成（SQL 一括適用など）
  - 関数:
    - `public.move_old_transactions_batch_json(cutoff,batch_size,in_run_id)`
    - `public.move_old_chargerequests_batch_json(cutoff,batch_size,in_run_id)`
  - staging テーブル:
    - `public.transactions_archive_staging`
    - `public.charge_requests_archive_staging`
  - 権限: service_role のみ実行可

### Google Drive
- フォルダ:
  - `TransactionsArchive` の ID を `GDRIVE_FOLDER_ID_TRANSACTIONS` に設定
  - `ChargeRequestsArchive` の ID を `GDRIVE_FOLDER_ID_CHARGEREQUESTS` に設定
- サービスアカウント（Drive API 有効）を編集者で共有
- サービスアカウント JSON を base64 化して `GCP_SA_JSON_B64` に設定

### Gmail API / OAuth2
- Gmail API 有効化
- OAuth クライアント（デスクトップ型）作成
- ローカルスクリプトで refresh_token を取得
- Secrets 登録: `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` / `GMAIL_SENDER` / `NOTIFY_EMAIL`

## GitHub Secrets（必須）
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GCP_SA_JSON_B64`
- `GDRIVE_FOLDER_ID_TRANSACTIONS`
- `GDRIVE_FOLDER_ID_CHARGEREQUESTS`
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `GMAIL_SENDER`
- `NOTIFY_EMAIL`

## GitHub Variables（非Secret）
- `CUTOFF_MONTHS_DEFAULT`（省略時は 6）

リポジトリの Variables に追加すると、ワークフローに自動で渡されます（Secrets ではありません）。

## 運用手順（初回）
1. Supabase に SQL を適用（staging/関数/権限）
2. Drive フォルダ作成 → サービスアカウントを編集者で共有 → フォルダ ID を控える
3. Gmail OAuth クライアント作成 → refresh_token を取得
4. 上記 Secrets / Variables を登録
5. コードを配置して commit
6. `workflow_dispatch` で手動実行して確認
   - 月初でなければスキップされます。検証時は一時的にコードの月初判定を外して動作確認してもOK

## よくある変更
- 期間変更は `CUTOFF_MONTHS_DEFAULT`（例: 6 → 3）を変更
- 実行時刻は `.github/workflows/archive.yml` の `cron` を変更
- CSV 列順やファイル巨大化時は適宜ロジックを調整

## ファイル
- `.github/workflows/archive.yml`
- `scripts/archive_multi_to_gdrive.js`
- `scripts/send_gmail.js`
- `package.json`


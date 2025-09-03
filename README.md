# Supabase → Google Drive 月次アーカイブ（Yangon / Gmail通知）

## 目的
- **Transactions / ChargeRequests** の **半年以上前**データを、**毎月1日（Asia/Yangon）**に **CSV** として **Google Drive** へ保存。
- 実行した月初のみ、**Gmail API（OAuth2）** で結果をメール通知。
- 月初以外は **処理せず通知もなし**。

## 構成
- **Runner**: GitHub Actions
- **Main**: `scripts/archive_multi_to_gdrive.js`
  - Yangon の月初判定
  - カットオフ（当月1日 00:00:00 Yangon − 6ヶ月）
  - Supabase RPC: 元→staging 移動（バッチ）→ CSV 生成 → Drive アップ → staging 清掃
  - `result.json` を必ず出力（`executed:true/false`）
- **Mail**: `scripts/send_gmail.js`（Gmail API）
  - `result.json.executed === true` のときのみ送信
- **Workflow**: `.github/workflows/archive.yml`
  - `cron: "35 17 * * *"`（毎日 17:35 UTC = Yangon 00:05）
  - 本体実行 → `executed` が true のときだけ `send_gmail.js`

## 事前準備

### Supabase
- 以下のオブジェクトを作成（SQL一括適用）
  - 関数:
    - `public.move_old_transactions_batch_json(cutoff,batch_size,in_run_id)`
    - `public.move_old_chargerequests_batch_json(cutoff,batch_size,in_run_id)`
  - staging テーブル:
    - `public.transactions_archive_staging`
    - `public.charge_requests_archive_staging`
  - 権限: **service_role のみ実行可**

### Google Drive
- フォルダ:
  - `TransactionsArchive` → **ID** を `GDRIVE_FOLDER_ID_TRANSACTIONS` に保存
  - `ChargeRequestsArchive` → **ID** を `GDRIVE_FOLDER_ID_CHARGEREQUESTS` に保存
- サービスアカウント（Drive API有効化済み）を **編集者**で共有
- サービスアカウントJSONを **base64** 化→ `GCP_SA_JSON_B64` として GitHub Secrets へ

### Gmail API（OAuth2）
- Gmail API 有効化
- OAuth クライアント **デスクトップ型** 作成
- ローカルスクリプト（ループバックURI方式）で **refresh_token** を取得
- Secrets 登録：`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` / `GMAIL_SENDER` / `NOTIFY_EMAIL`

## GitHub Secrets
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- GCP_SA_JSON_B64
- GDRIVE_FOLDER_ID_TRANSACTIONS
- GDRIVE_FOLDER_ID_CHARGEREQUESTS
- GMAIL_CLIENT_ID
- GMAIL_CLIENT_SECRET
- GMAIL_REFRESH_TOKEN
- GMAIL_SENDER
- NOTIFY_EMAIL


## 主要仕様
- **対象テーブル**: `Transactions`, `ChargeRequests`
- **基準列**: `Transactions.created_at`, `ChargeRequests.requested_at`
- **対象期間**: ヤンゴン月初基準で **6ヶ月前より古い**
- **バッチサイズ**: `BATCH_SIZE=10000`（環境変数で変更可）
- **CSV**:
  - ヘッダ = 退避 JSON の **全キーのユニオン**（ソート）
  - 保存名例: `Transactions_archive_until_2025-04_1712345678901_<runid>.csv`
- **Drive 保管先**:
  - `GDRIVE_FOLDER_ID_TRANSACTIONS` / `..._CHARGEREQUESTS`
- **staging 清掃**: アップ成功後、該当 `run_id` の行を削除
- **出力**: `result.json`
  - スキップ時: `{ "executed": false, "reason": "not-first-day-yangon" }`
  - 実行時: `{ "executed": true, "cutoff": "ISO-UTC", "results": [{ "table":"...", "moved":123, "fileUrl":"...", "folderUrl":"..." }, ...] }`
- **通知**: `executed:true` のときのみ Gmail API で送信（成功/失敗含む）

## ファイル
- .github/workflows/archive.yml
- scripts/archive_multi_to_gdrive.js
- scripts/send_gmail.js
- package.json


## 運用（初回）
1. Supabase に SQL を適用（staging/関数/権限）
2. Drive フォルダ作成→サービスアカウント共有→ID 取得
3. Gmail OAuth デスクトップ型で refresh_token 取得
4. GitHub Secrets 登録
5. 上記ファイルを配置して commit
6. `workflow_dispatch` で手動実行して確認  
   - 月初でなければスキップされる。検証時は一時的にコードで月初判定を外して動作確認も可

## 失敗時の挙動
- 月初実行で一部失敗：`results[].ok=false`／メール通知あり／staging にデータ残存（再実行可能）
- Drive アップ失敗：staging 清掃は行わずデータ保全
- 月初以外：即終了・通知なし

## よくある変更
- 期間変更：`cutoffDateMinus6Months()` の月数を変更
- 実行時刻：`archive.yml` の `cron` を変更
- CSV 分割：ファイル巨大化時に分割ロジックを追加
📂 前提条件（準備）

Supabase 側

すでに作成した staging テーブル＆関数（move_old_transactions_batch_json, move_old_chargerequests_batch_json）があること。

無ければ前にお渡しした SQL を Supabase SQL Editor で実行してください。

Google Drive 側

フォルダを2つ作成：

TransactionsArchive

ChargeRequestsArchive

それぞれのフォルダID（URL の folders/xxxx 部分）を控える。

サービスアカウントのメールアドレスを「編集者」として招待。

GitHub Secrets に設定

SUPABASE_URL

SUPABASE_SERVICE_ROLE_KEY

GCP_SA_JSON_B64（サービスアカウントのJSONを base64 で貼り付け）

GDRIVE_FOLDER_ID_TRANSACTIONS

GDRIVE_FOLDER_ID_CHARGEREQUESTS

GMAIL_USER（送信元 Gmail アドレス）

GMAIL_PASS（Gmail アプリパスワード）

NOTIFY_EMAIL（通知先アドレス）


🎯 やること一覧（GCP 側）

新しい GCP プロジェクトを作成

Google Cloud Console
 にログイン

プロジェクト作成（名前は任意、課金は不要／無料枠でOK）

Google Drive API を有効化

プロジェクトを選択 → 左メニュー「APIとサービス」→「ライブラリ」

Google Drive API を検索 → 有効化

サービスアカウントを作成

「APIとサービス」→「認証情報」→「認証情報を作成」→「サービスアカウント」

名前は任意（例：supabase-archive-bot）

ロールは「基本 → ビューアー」でOK（権限はDrive共有で付与するので最小限）

サービスアカウントの鍵を発行

作成したサービスアカウントを開く →「キー」タブ

「キーを追加」→「新しいキーを作成」→形式は JSON

JSON ファイルがダウンロードされる（これが秘密鍵）

サービスアカウントを Google Drive フォルダに共有

CSVを保存したい Drive フォルダを開く

「共有」→ サービスアカウントのメールアドレス（例：xxxx@xxxx.iam.gserviceaccount.com）を入力

権限を「編集者」にする → 保存

これでスクリプトからこのフォルダにファイルをアップできるようになる

GitHub Secrets に登録

ダウンロードした JSON をテキストエディタで開く

全文を base64 エンコードして GitHub Secrets に入れる

base64 -w0 key.json > key.b64


GCP_SA_JSON_B64 という名前で保存

あわせて GDRIVE_FOLDER_ID_TRANSACTIONS, GDRIVE_FOLDER_ID_CHARGEREQUESTS にそれぞれフォルダIDを保存

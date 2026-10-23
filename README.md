# 茨香祭 配信進行管理

Hono管理画面、OBS、SQLiteを配信PC上で動かすローカルアプリです。OBSが映像を配信し、`/broadcast` はOBSブラウザソースに重ねるテロップとして動作します。CM動画のデータはサーバーやGitに置かず、PC内のファイルパスだけを管理します。

Windows配信PCへの初回設定と当日の操作は、[セットアップ・運用手順](docs/SETUP.md)を参照してください。

## Windowsで起動

1. Node.js 22 LTSとOBS Studioをインストールします。
2. OBSで「ツール → WebSocketサーバー設定」を開き、WebSocketを有効にします。ポートと認証方式を確認してください。
3. リポジトリの `shikosai-signage-api` フォルダで依存関係を入れて起動します。

```powershell
cd shikosai-signage-api
npm install
$env:SIGNAGE_MEDIA_ROOT = "..\CM"
npm run dev
```

管理画面は <http://127.0.0.1:8787/admin>、OBSのブラウザソースURLは <http://127.0.0.1:8787/broadcast> です。デモ表示は <http://127.0.0.1:8787/broadcast?demo=1> で確認できます（OBSソースには通常URLを設定してください）。管理画面の「ローカル設定 → OBS WebSocket」でポートとパスワードを設定できます。接続情報は `shikosai-signage-api/data/obs-connection.json` にローカル保存され、Git管理対象外です。サーバーは `127.0.0.1` のみで待ち受けます。SQLiteデータとバックアップも `shikosai-signage-api/data/` に作成されます。

OBSのWebSocket認証を無効にしている場合、パスワード欄は空のままで接続できます。シーン切替ボタンは企画/CMを選択したときだけOBSシーンを切り替え、時刻到来時にシーンを自動変更しません。CMシーンへ切り替えた後は、残り時間に収まるCMを選んでOBSの `CM映像` メディアソースへ順番に読み込みます。

## OBSシーン

既存コレクションを [`obs/collections/shikosai.json`](obs/collections/shikosai.json) に整理しました。2シーン「企画」「CM」と、ローカルオーバーレイのブラウザソースを含みます。OBSはシーンコレクションをプロファイルから読み込みます。初回はOBSの「シーンコレクション → インポート」からこのファイルを選択してください。インポート後、キャプチャデバイスと `CM映像` のローカルファイルを配信PCのものに合わせます。以後は `scripts/start-obs-windows.ps1` を使うと「茨香祭ローカル配信」コレクションでOBSを起動できます。

## データと運用

- `shikosai-signage-api/src/`: Hono API、SQLite接続、OBS WebSocket制御、公式団体データの初期登録。
- `shikosai-signage-api/public/admin.html`: 進行、CSV、CM、お知らせ、団体データの管理画面。
- `shikosai-signage-api/public/broadcast.html`: 1920×1080のOBSオーバーレイ。映像の配信はOBSが担当します。
- `shikosai-signage-api/migrations/`: SQLiteスキーマ。
- `seed/shikosai-catalog.json`: 公式サイトの公開情報から作成した初期カタログ。初回起動時に64件がSQLiteへ登録されます。画像本体は取得せず、公開URLと説明文のみ保持します。
- プログラム表が空の場合、起動時に7件の `【デモ】` 企画が登録されます。デモ企画は管理画面だけで確認でき、OBS配信データから除外されます。実企画をCSVで読み込むとデモ行は置き換わります。
- タイムライン各行の `▶ 設定` から、開催時刻・説明・クラス名・サークルカットをその場で編集できます。企画／CMシーン切替は手動です。
- `scripts/scrape_shikosai_catalog.py`: 公式サイトの公開ページからカタログJSONを再生成します。
- `CM/`: ローカルCM動画フォルダ。CM登録画面にはこのフォルダからの相対パスを入力します。

企画CSVは管理画面のテンプレートに合わせ、`title,description,scheduled_start,adjusted_start,day,class_name,kind,circle_slug,media_path` 列で保存します。開始時刻だけで進行し、CM枠は次の企画の開始時刻までとして算出します。Excelでは「CSV UTF-8（コンマ区切り）」を選んでください。

お知らせは担当者が入力した文をそのまま表示します。長文はオーバーレイで2列に分けます。

CM選択では、次の企画開始時刻までの残り時間、CMの再生時間、CMと団体それぞれの希望度（-10〜+10）、直近60分の再生回数、同じ幕間での重複、1幕間あたりの上限を見ます。映像ファイルのアップロード機能はありません。

## チーム開発

- UI、Hono/OBS制御、DB/初期データ、OBSシーン素材の担当で分けて作業できます。
- `data/`, `.env`, `node_modules/`, `CM/*.mp4` はローカル専用です。CSV、シーンJSON、コード、再生成可能な公開カタログをGitで共有します。
- 型チェックは `cd shikosai-signage-api; npm run typecheck` で実行できます。

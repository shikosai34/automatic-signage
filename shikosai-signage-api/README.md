# Hono ローカル配信管理アプリ

起動、OBSシーンコレクションの取り込み、CSV、ローカル保存先の説明はリポジトリの [README](../README.md) を参照してください。

```powershell
npm install
npm run dev
```

`src/` にHono API、OBS WebSocket制御、SQLite初期化を分離しています。永続データは `data/` に保存します。

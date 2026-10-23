import http.server
import socketserver
import json
import time
from obswebsocket import obsws, requests as obs_requests

# --- OBS設定 ---
HOST = "localhost"
PORT = 4455
PASSWORD = ""

ws = obsws(HOST, PORT, PASSWORD)
ws.connect()
print("OBSに接続しました！")

SCENE_MAIN = "シーン"
SCENE_SUB = "シーン 2"
TEXT_SOURCE = "テキスト (FreeType 2)"

res = ws.call(obs_requests.GetSceneItemId(sceneName=SCENE_MAIN, sourceName=TEXT_SOURCE))
item_id = res.getSceneItemId()

# --- 操作用HTML画面 ---
HTML_PAGE = """<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>茨香祭 OBSリモコン</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 20px; background: #f0f2f5; }
    h1 { font-size: 24px; margin-bottom: 20px; }
    .btn { display: block; width: 100%; max-width: 320px; margin: 15px auto; padding: 18px; font-size: 18px; font-weight: bold; border: none; border-radius: 12px; cursor: pointer; color: white; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .btn:active { transform: scale(0.98); }
    .btn-song1 { background: #2563eb; }
    .btn-song2 { background: #0284c7; }
    .btn-break { background: #d97706; }
    .btn-hide  { background: #4b5563; }
    #status { margin-top: 20px; font-size: 16px; color: #374151; }
  </style>
</head>
<body>
  <h1>茨香祭 OBS コントローラー</h1>
  <button class="btn btn-song1" onclick="sendAction('song1')">♪ 天体観測 を表示</button>
  <button class="btn btn-song2" onclick="sendAction('song2')">♪ 怪獣の花唄 を表示</button>
  <button class="btn btn-hide" onclick="sendAction('hide')">テロップを消去</button>
  <button class="btn btn-break" onclick="sendAction('break')">幕間（シーン2）へ切替</button>

  <div id="status">待機中</div>

  <script>
    async function sendAction(action) {
      document.getElementById('status').innerText = '送信中...';
      try {
        const res = await fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action })
        });
        const data = await res.json();
        document.getElementById('status').innerText = '実行完了: ' + data.message;
      } catch (err) {
        document.getElementById('status').innerText = 'エラーが発生しました';
      }
    }
  </script>
</body>
</html>
"""

# --- リクエストを処理するWebサーバー ---
class RemoteHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(HTML_PAGE.encode("utf-8"))

    def do_POST(self):
        if self.path == "/api/control":
            content_length = int(self.headers["Content-Length"])
            post_data = self.rfile.read(content_length)
            body = json.loads(post_data.decode("utf-8"))
            action = body.get("action")
            msg = ""

            if action == "song1":
                ws.call(obs_requests.SetCurrentProgramScene(sceneName=SCENE_MAIN))
                ws.call(obs_requests.SetInputSettings(
                    inputName=TEXT_SOURCE,
                    inputSettings={"text": "♪ 天体観測 / 軽音部Aチーム"}
                ))
                ws.call(obs_requests.SetSceneItemEnabled(
                    sceneName=SCENE_MAIN,
                    sceneItemId=item_id,
                    sceneItemEnabled=True
                ))
                msg = "天体観測を表示しました"

            elif action == "song2":
                ws.call(obs_requests.SetCurrentProgramScene(sceneName=SCENE_MAIN))
                ws.call(obs_requests.SetInputSettings(
                    inputName=TEXT_SOURCE,
                    inputSettings={"text": "♪ 怪獣の花唄 / 有志バンドB"}
                ))
                ws.call(obs_requests.SetSceneItemEnabled(
                    sceneName=SCENE_MAIN,
                    sceneItemId=item_id,
                    sceneItemEnabled=True
                ))
                msg = "怪獣の花唄を表示しました"

            elif action == "hide":
                ws.call(obs_requests.SetSceneItemEnabled(
                    sceneName=SCENE_MAIN,
                    sceneItemId=item_id,
                    sceneItemEnabled=False
                ))
                msg = "テロップを非表示にしました"

            elif action == "break":
                ws.call(obs_requests.SetCurrentProgramScene(sceneName=SCENE_SUB))
                msg = "幕間画面に切り替えました"

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "message": msg}).encode("utf-8"))

WEB_PORT = 8080
print(f"\nWebサーバー起動中: http://localhost:{WEB_PORT}")
print("ブラウザを開いて上記URLにアクセスしてください。\n")

with socketserver.TCPServer(("", WEB_PORT), RemoteHandler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを停止しました")
        ws.disconnect()
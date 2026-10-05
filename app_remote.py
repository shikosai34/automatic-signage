import http.server
import socketserver
import json
import csv
import io
import requests as http_requests
from obswebsocket import obsws, requests as obs_requests

# -------------------------------------------------------------
# 1. 設定項目
# -------------------------------------------------------------
SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSVZ8pEwfQqdHHmyZu8V4fkVxVodYUqUj68R4cQiNgrjfqwp2l3SQNhA-yyW30bj5ebEjE8CJOEdf7a/pub?gid=0&single=true&output=csv"

OBS_HOST = "localhost"
OBS_PORT = 4455
OBS_PASSWORD = ""

SCENE_MAIN = "シーン"
SCENE_SUB = "シーン 2"
TEXT_SOURCE = "テキスト (FreeType 2)"
WEB_PORT = 8080

# -------------------------------------------------------------
# 2. OBS接続
# -------------------------------------------------------------
ws = obsws(OBS_HOST, OBS_PORT, OBS_PASSWORD)
ws.connect()
print("=== OBSに接続しました ===")

res = ws.call(obs_requests.GetSceneItemId(sceneName=SCENE_MAIN, sourceName=TEXT_SOURCE))
item_id = res.getSceneItemId()

# -------------------------------------------------------------
# 3. タイムテーブル管理
# -------------------------------------------------------------
class State:
    timetable = []
    current_index = -1  # -1 は開始前（待機状態）

state = State()

def fetch_timetable():
    try:
        res = http_requests.get(SHEET_CSV_URL, timeout=5)
        res.encoding = "utf-8"
        res.raise_for_status()
        
        csv_file = io.StringIO(res.text)
        reader = csv.DictReader(csv_file)
        
        # タイトルが入っている有効な行のみ抽出
        table = [row for row in reader if row.get("title") and row["title"].strip()]
        state.timetable = table
        print(f"スプレッドシートから {len(state.timetable)} 件の演目を読み込みました。")
    except Exception as e:
        print(f"スプレッドシート読み込みエラー: {e}")

fetch_timetable()

def apply_obs_by_index(idx):
    """指定したインデックスの演目をOBSに反映する"""
    if idx < 0 or idx >= len(state.timetable):
        return "範囲外です"
    
    item = state.timetable[idx]
    if item["type"] == "song":
        # メインシーンに戻してテロップを表示
        ws.call(obs_requests.SetCurrentProgramScene(sceneName=SCENE_MAIN))
        display_text = f"♪ {item['title']}"
        if item.get("band"):
            display_text += f" / {item['band']}"
        
        ws.call(obs_requests.SetInputSettings(
            inputName=TEXT_SOURCE,
            inputSettings={"text": display_text}
        ))
        ws.call(obs_requests.SetSceneItemEnabled(
            sceneName=SCENE_MAIN,
            sceneItemId=item_id,
            sceneItemEnabled=True
        ))
        return f"テロップ表示: {display_text}"
        
    elif item["type"] == "break":
        # テロップを非表示にして幕間シーンへ切替
        ws.call(obs_requests.SetSceneItemEnabled(
            sceneName=SCENE_MAIN,
            sceneItemId=item_id,
            sceneItemEnabled=False
        ))
        ws.call(obs_requests.SetCurrentProgramScene(sceneName=SCENE_SUB))
        return f"画面切替: 幕間画面 ({item['title']})"

# -------------------------------------------------------------
# 4. 操作用Web画面（HTML）
# -------------------------------------------------------------
HTML_PAGE = """<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>茨香祭 ステージ進行コンソール</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 16px; }
    .container { max-width: 600px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    
    .card { background: #1e293b; padding: 20px; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); }
    .section-label { font-size: 13px; font-weight: bold; color: #94a3b8; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.05em; }
    
    /* 前・現在・次のカード */
    .slot { padding: 12px; border-radius: 10px; margin-bottom: 8px; }
    .slot-prev { background: #0f172a; border-left: 4px solid #64748b; opacity: 0.75; }
    .slot-current { background: #0284c7; border-left: 6px solid #38bdf8; padding: 16px; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.4); }
    .slot-next { background: #0f172a; border-left: 4px solid #3b82f6; }
    
    .slot-title { font-size: 18px; font-weight: bold; }
    .slot-current .slot-title { font-size: 22px; }
    .slot-sub { font-size: 14px; color: #cbd5e1; margin-top: 4px; }
    
    /* コントロールボタン */
    .btn-row { display: flex; gap: 12px; margin-top: 12px; }
    .btn { flex: 1; padding: 18px; font-size: 18px; font-weight: bold; border: none; border-radius: 12px; cursor: pointer; color: white; transition: 0.1s; }
    .btn:active { transform: scale(0.97); }
    .btn-prev { background: #475569; }
    .btn-next { background: #2563eb; flex: 2; }
    .btn-sync { width: 100%; background: #334155; font-size: 14px; padding: 10px; margin-top: 8px; border: none; border-radius: 8px; color: #94a3b8; cursor: pointer; }
    
    /* 演目一覧リスト */
    .timetable-list { max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .list-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 8px; background: #0f172a; font-size: 14px; }
    .list-item.active { background: #0369a1; border-left: 4px solid #38bdf8; font-weight: bold; }
    .tag { font-size: 11px; padding: 2px 6px; border-radius: 4px; }
    .tag-song { background: #166534; color: #bbf7d0; }
    .tag-break { background: #854d0e; color: #fef08a; }

    #status-msg { text-align: center; font-size: 13px; color: #38bdf8; min-height: 18px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="container">
    
    <!-- 進行モニター（前・現在・次） -->
    <div class="card">
      <div class="slot slot-prev">
        <div class="section-label">◀ 1つ前の演目</div>
        <div id="prev-title" class="slot-title">なし</div>
        <div id="prev-sub" class="slot-sub"></div>
      </div>

      <div class="slot slot-current">
        <div class="section-label" style="color:#e0f2fe;">● 現在送出中</div>
        <div id="curr-title" class="slot-title">待機中（未開始）</div>
        <div id="curr-sub" class="slot-sub">「次へ進む」を押して開始してください</div>
      </div>

      <div class="slot slot-next">
        <div class="section-label">▶ 次に控えている演目</div>
        <div id="next-title" class="slot-title">なし</div>
        <div id="next-sub" class="slot-sub"></div>
      </div>

      <!-- 操作ボタン -->
      <div class="btn-row">
        <button class="btn btn-prev" onclick="sendAction('prev')">◀ 前へ戻る</button>
        <button class="btn btn-next" onclick="sendAction('next')">次へ進む ▶</button>
      </div>
      <button class="btn-sync" onclick="sendAction('sync')">↻ スプレッドシート再同期</button>
      <div id="status-msg"></div>
    </div>

    <!-- 演目一覧 -->
    <div class="card">
      <div class="section-label">全演目リスト</div>
      <div id="timetable-list" class="timetable-list"></div>
    </div>

  </div>

  <script>
    function renderSlot(elTitle, elSub, item) {
      if (!item) {
        document.getElementById(elTitle).innerText = 'なし';
        document.getElementById(elSub).innerText = '';
        return;
      }
      const typeLabel = item.type === 'song' ? '【曲】' : '【幕間】';
      document.getElementById(elTitle).innerText = `${typeLabel} ${item.title}`;
      document.getElementById(elSub).innerText = item.band ? `バンド/担当: ${item.band}` : '';
    }

    async function updateUI() {
      const res = await fetch('/api/state');
      const data = await res.json();
      
      // 前・現在・次の描画
      renderSlot('prev-title', 'prev-sub', data.prev);
      
      if (data.current) {
        renderSlot('curr-title', 'curr-sub', data.current);
      } else {
        document.getElementById('curr-title').innerText = data.currentIndex < 0 ? '待機中（未開始）' : '全スケジュール終了';
        document.getElementById('curr-sub').innerText = data.currentIndex < 0 ? '「次へ進む」で開始' : '';
      }

      renderSlot('next-title', 'next-sub', data.next);

      // リストの描画
      const listEl = document.getElementById('timetable-list');
      listEl.innerHTML = '';
      data.timetable.forEach((item, idx) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'list-item' + (idx === data.currentIndex ? ' active' : '');
        
        const tagClass = item.type === 'song' ? 'tag-song' : 'tag-break';
        const tagText = item.type === 'song' ? '曲' : '幕間';

        itemDiv.innerHTML = `
          <div>
            <span style="color:#94a3b8; margin-right:6px;">${idx + 1}.</span>
            <span>${item.title}</span>
            <span style="color:#94a3b8; font-size:12px; margin-left:8px;">${item.band || ''}</span>
          </div>
          <span class="tag ${tagClass}">${tagText}</span>
        `;
        listEl.appendChild(itemDiv);
      });
    }

    async function sendAction(action) {
      document.getElementById('status-msg').innerText = '処理中...';
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      document.getElementById('status-msg').innerText = data.message;
      updateUI();
    }

    // 初回描画
    updateUI();
  </script>
</body>
</html>
"""

# -------------------------------------------------------------
# 5. リクエスト処理ハンドラ
# -------------------------------------------------------------
class RequestHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode("utf-8"))

        elif self.path == "/api/state":
            idx = state.current_index
            total = len(state.timetable)
            
            prev_item = state.timetable[idx - 1] if 0 <= (idx - 1) < total else None
            curr_item = state.timetable[idx] if 0 <= idx < total else None
            next_item = state.timetable[idx + 1] if 0 <= (idx + 1) < total else None

            payload = {
                "currentIndex": idx,
                "total": total,
                "prev": prev_item,
                "current": curr_item,
                "next": next_item,
                "timetable": state.timetable
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode("utf-8"))

    def do_POST(self):
        if self.path == "/api/action":
            content_length = int(self.headers["Content-Length"])
            post_data = self.rfile.read(content_length)
            body = json.loads(post_data.decode("utf-8"))
            action = body.get("action")
            msg = ""

            if action == "next":
                if state.current_index + 1 < len(state.timetable):
                    state.current_index += 1
                    msg = apply_obs_by_index(state.current_index)
                else:
                    msg = "既に最後の演目です"

            elif action == "prev":
                if state.current_index > 0:
                    state.current_index -= 1
                    msg = apply_obs_by_index(state.current_index)
                elif state.current_index == 0:
                    state.current_index = -1
                    # 開始前に戻す場合、テロップを消す
                    ws.call(obs_requests.SetSceneItemEnabled(
                        sceneName=SCENE_MAIN,
                        sceneItemId=item_id,
                        sceneItemEnabled=False
                    ))
                    msg = "開始前の待機状態に戻しました"
                else:
                    msg = "これ以上前には戻れません"

            elif action == "sync":
                fetch_timetable()
                msg = "スプレッドシートと再同期しました！"

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"message": msg}).encode("utf-8"))

# -------------------------------------------------------------
# 6. サーバー起動
# -------------------------------------------------------------
print(f"\nブラウザから以下を開いてください:\nhttp://localhost:{WEB_PORT}\n")

with socketserver.TCPServer(("", WEB_PORT), RequestHandler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを停止しました")
        ws.disconnect()
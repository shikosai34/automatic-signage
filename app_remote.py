import http.server
import socketserver
import json
import csv
import io
import os
import time
import threading
import requests as http_requests
from obswebsocket import obsws, requests as obs_requests

# -------------------------------------------------------------
# 1. 設定項目
# -------------------------------------------------------------

# 新しいAPIのベースURL
API_BASE_URL = "https://shikosai-signage-api.shikosai.workers.dev"

# データベース（D1）からデータを取得するURL
API_TIMETABLE_URL = f"{API_BASE_URL}/api/timetable"
API_INFO_URL = f"{API_BASE_URL}/api/info"

# OBS接続設定
OBS_HOST = "localhost"
OBS_PORT = 4455
OBS_PASSWORD = "GzQNnOZxEzEQQ5iI"  # ★ここにOBSのパスワードを入力してください

# ソース名・シーン名
SCENE_MAIN = "シーン"
SOURCE_STAGE = "ステージ映像"
SOURCE_CM = "CM映像"
TEXT_SOURCE_SONG = "telop"         # 曲名テロップソース名
TEXT_SOURCE_INFO = "infomation"    # AI情報テロップソース名
FILTER_SCROLL = "スクロール"       # infomationに追加したフィルタ名

DEFAULT_CM_FILE_PATH = "C:/path/to/your_cm_video.mp4"
WEB_PORT = 8080

# -------------------------------------------------------------
# 2. OBS接続 & 初期設定
# -------------------------------------------------------------
ws = obsws(OBS_HOST, OBS_PORT, OBS_PASSWORD)
ws.connect()
print("=== OBSに接続しました ===")

def get_item_id(scene_name, source_name):
    try:
        res = ws.call(obs_requests.GetSceneItemId(sceneName=scene_name, sourceName=source_name))
        return res.getSceneItemId()
    except Exception as e:
        print(f"警告: ソース '{source_name}' のID取得失敗: {e}")
        return None

id_text_song = get_item_id(SCENE_MAIN, TEXT_SOURCE_SONG)
id_text_info = get_item_id(SCENE_MAIN, TEXT_SOURCE_INFO)
id_stage = get_item_id(SCENE_MAIN, SOURCE_STAGE)
id_cm = get_item_id(SCENE_MAIN, SOURCE_CM)

def set_source_visible(scene_name, item_id, visible):
    if item_id is not None:
        ws.call(obs_requests.SetSceneItemEnabled(
            sceneName=scene_name,
            sceneItemId=item_id,
            sceneItemEnabled=visible
        ))

def update_text_source(source_name, text):
    ws.call(obs_requests.SetInputSettings(
        inputName=source_name,
        inputSettings={"text": text}
    ))

def set_scroll_speed(source_name, speed):
    """スクロールフィルタの水平速度を設定（0で停止）"""
    try:
        ws.call(obs_requests.SetSourceFilterSettings(
            sourceName=source_name,
            filterName=FILTER_SCROLL,
            filterSettings={"speed_x": speed}
        ))
    except Exception as e:
        pass

# -------------------------------------------------------------
# 3. データ管理 & 定期取得
# -------------------------------------------------------------
class AppData:
    timetable = []
    cm_list = []
    info_list = []
    current_index = -1

data = AppData()

# 前回取得したデータを保持する変数
prev_timetable = None
prev_info_list = None

def fetch_all_data():
    global prev_timetable, prev_info_list

    # 1. タイムテーブル取得
    try:
        res = http_requests.get(API_TIMETABLE_URL, timeout=5)
        json_data = res.json()
        new_timetable = [r for r in json_data if r.get("title") and str(r["title"]).strip()]
        
        # 初回または中身が変わった時だけ表示
        if prev_timetable is None:
            print(f"タイムテーブル: {len(new_timetable)}件 取得")
        elif new_timetable != prev_timetable:
            print(f"🔄 [更新検知] タイムテーブルが変更されました ({len(new_timetable)}件)")
            
        data.timetable = new_timetable
        prev_timetable = new_timetable
    except Exception as e:
        print(f"タイムテーブル取得失敗: {e}")

    # 2. CM等
    data.cm_list = []

    # 3. 下側情報欄取得
    try:
        res = http_requests.get(API_INFO_URL, timeout=5)
        json_data = res.json()
        active_infos = []
        for r in json_data:
            if r.get("formatted_text") or r.get("raw_text"):
                active_infos.append(r)

        # 初回または中身が変わった時だけ表示
        if prev_info_list is None:
            print(f"下側情報欄(有効): {len(active_infos)}件 取得")
        elif active_infos != prev_info_list:
            print(f"📢 [更新検知] テロップ情報が更新されました (有効: {len(active_infos)}件)")

        data.info_list = active_infos
        prev_info_list = active_infos
    except Exception as e:
        # 通信エラー時は毎回ログを出さず静かにスルー（必要なら出力可能）
        pass

fetch_all_data()

# データベース常時自動更新ループ（バックグラウンド監視）
AUTO_SYNC_INTERVAL = 10  # 10秒ごとにDBの最新状態をチェック

def auto_sync_loop():
    while True:
        time.sleep(AUTO_SYNC_INTERVAL)
        try:
            fetch_all_data()
        except Exception as e:
            print(f"自動同期エラー: {e}")

sync_thread = threading.Thread(target=auto_sync_loop, daemon=True)
sync_thread.start()

# -------------------------------------------------------------
# 4. 下側テロップ 自動スクロール循環ループ（緊急ジャック対応）
# -------------------------------------------------------------
def ticker_loop():
    set_source_visible(SCENE_MAIN, id_text_info, True)
    
    normal_idx = 0
    emergency_idx = 0
    
    while True:
        if not data.info_list:
            time.sleep(3)
            continue

        # 1. 有効なテロップを仕分け
        emergencies = []
        normals = []

        for item in data.info_list:
            tag = item.get("tag", "その他")
            if "緊急" in tag:
                emergencies.append(item)
            else:
                # 迷子落とし物も含め、緊急以外はすべて通常ループへ
                normals.append(item)

        target_item = None

        # --- 緊急ジャック判定 ---
        # 緊急テロップが1件でもあれば、通常テロップは流さず緊急テロップのみループ
        if emergencies:
            target_item = emergencies[emergency_idx % len(emergencies)]
            emergency_idx += 1
        elif normals:
            # 緊急がない場合は、通常テロップ（迷子含む）を順番に1件ずつループ
            target_item = normals[normal_idx % len(normals)]
            normal_idx += 1

        if not target_item:
            time.sleep(2)
            continue

        # 表示する文字列
        display_text = target_item.get("formatted_text") or target_item.get("raw_text", "")
        display_text = str(display_text).strip().replace("\n", " ").replace("\r", "")

        if not display_text:
            time.sleep(1)
            continue

        # HTMLブラウザソース用のファイル（ticker_data.js）へ書き出し
        try:
            with open("ticker_data.js", "w", encoding="utf-8") as f:
                f.write(f'var latestTickerText = `{display_text}`; var latestTickerTime = {time.time()};')
        except Exception as e:
            print(f"ticker_data.js 書き込み失敗: {e}")

        # 文字数に応じた表示・待機時間
        wait_time = len(display_text) * 0.3 + 0.5
        time.sleep(wait_time)

# スクロールループを別スレッドで開始
ticker_thread = threading.Thread(target=ticker_loop, daemon=True)
ticker_thread.start()

# -------------------------------------------------------------
# 5. ステージ進行・CM切り替えロジック
# -------------------------------------------------------------
cm_index = 0
is_in_break = False
cm_timer_thread = None

def play_next_cm():
    global cm_index
    if not data.cm_list:
        return

    cm_item = data.cm_list[cm_index % len(data.cm_list)]
    cm_path = cm_item.get("file_path", "").strip()
    cm_index += 1

    if cm_path and os.path.exists(cm_path):
        ws.call(obs_requests.SetInputSettings(
            inputName=SOURCE_CM,
            inputSettings={"local_file": cm_path, "looping": False}
        ))
        try:
            ws.call(obs_requests.TriggerMediaInputAction(
                inputName=SOURCE_CM,
                mediaAction="OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART"
            ))
        except Exception:
            pass
        print(f"CM再生開始: {os.path.basename(cm_path)}")

def cm_rotation_loop():
    while is_in_break:
        play_next_cm()
        for _ in range(15):
            if not is_in_break:
                break
            time.sleep(1)

def apply_obs_by_index(idx):
    global is_in_break, cm_timer_thread
    if idx < 0 or idx >= len(data.timetable):
        return "範囲外です"

    item = data.timetable[idx]

    if item["type"] == "song":
        is_in_break = False
        set_source_visible(SCENE_MAIN, id_stage, True)
        set_source_visible(SCENE_MAIN, id_cm, False)

        display_song = f"♪ {item['title']}"
        if item.get("band"):
            display_song += f" / {item['band']}"
        update_text_source(TEXT_SOURCE_SONG, display_song)
        set_source_visible(SCENE_MAIN, id_text_song, True)

        return f"【曲】ステージ映像 & 曲テロップ: {display_song}"

    elif item["type"] == "break":
        set_source_visible(SCENE_MAIN, id_text_song, False)
        set_source_visible(SCENE_MAIN, id_stage, False)
        set_source_visible(SCENE_MAIN, id_cm, True)

        if not is_in_break:
            is_in_break = True
            cm_timer_thread = threading.Thread(target=cm_rotation_loop, daemon=True)
            cm_timer_thread.start()

        return f"【幕間】CM再生開始 ({item['title']})"

# -------------------------------------------------------------
# 6. Webコントローラー画面 & サーバー起動（ステージ進行用）
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
    .slot { padding: 12px; border-radius: 10px; margin-bottom: 8px; }
    .slot-prev { background: #0f172a; border-left: 4px solid #64748b; opacity: 0.75; }
    .slot-current { background: #0284c7; border-left: 6px solid #38bdf8; padding: 16px; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.4); }
    .slot-next { background: #0f172a; border-left: 4px solid #3b82f6; }
    .slot-title { font-size: 18px; font-weight: bold; }
    .slot-current .slot-title { font-size: 22px; }
    .slot-sub { font-size: 14px; color: #cbd5e1; margin-top: 4px; }
    .btn-row { display: flex; gap: 12px; margin-top: 12px; }
    .btn { flex: 1; padding: 18px; font-size: 18px; font-weight: bold; border: none; border-radius: 12px; cursor: pointer; color: white; transition: 0.1s; }
    .btn:active { transform: scale(0.97); }
    .btn-prev { background: #475569; }
    .btn-next { background: #2563eb; flex: 2; }
    .btn-sync { width: 100%; background: #334155; font-size: 14px; padding: 10px; margin-top: 8px; border: none; border-radius: 8px; color: #94a3b8; cursor: pointer; }
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

      <div class="btn-row">
        <button class="btn btn-prev" onclick="sendAction('prev')">◀ 前へ戻る</button>
        <button class="btn btn-next" onclick="sendAction('next')">次へ進む ▶</button>
      </div>
      <button class="btn-sync" onclick="sendAction('sync')">↻ データベースと再同期</button>
      <div id="status-msg"></div>
    </div>

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
      const d = await res.json();
      
      renderSlot('prev-title', 'prev-sub', d.prev);
      
      if (d.current) {
        renderSlot('curr-title', 'curr-sub', d.current);
      } else {
        document.getElementById('curr-title').innerText = d.currentIndex < 0 ? '待機中（未開始）' : '全スケジュール終了';
        document.getElementById('curr-sub').innerText = d.currentIndex < 0 ? '「次へ進む」で開始' : '';
      }

      renderSlot('next-title', 'next-sub', d.next);

      const listEl = document.getElementById('timetable-list');
      listEl.innerHTML = '';
      d.timetable.forEach((item, idx) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'list-item' + (idx === d.currentIndex ? ' active' : '');
        
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
      const d = await res.json();
      document.getElementById('status-msg').innerText = d.message;
      updateUI();
    }

    updateUI();
  </script>
</body>
</html>
"""

class RequestHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode("utf-8"))

        elif self.path == "/api/state":
            idx = data.current_index
            total = len(data.timetable)
            
            payload = {
                "currentIndex": idx,
                "total": total,
                "prev": data.timetable[idx - 1] if 0 <= (idx - 1) < total else None,
                "current": data.timetable[idx] if 0 <= idx < total else None,
                "next": data.timetable[idx + 1] if 0 <= (idx + 1) < total else None,
                "timetable": data.timetable
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode("utf-8"))

    def do_POST(self):
        if self.path == "/api/action":
            length = int(self.headers["Content-Length"])
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            action = body.get("action")
            msg = ""

            if action == "next":
                if data.current_index + 1 < len(data.timetable):
                    data.current_index += 1
                    msg = apply_obs_by_index(data.current_index)
                else:
                    msg = "既に最後の演目です"

            elif action == "prev":
                if data.current_index > 0:
                    data.current_index -= 1
                    msg = apply_obs_by_index(data.current_index)
                elif data.current_index == 0:
                    data.current_index = -1
                    set_source_visible(SCENE_MAIN, id_text_song, False)
                    msg = "開始前の待機状態に戻しました"
                else:
                    msg = "これ以上前には戻れません"

            elif action == "sync":
                fetch_all_data()
                msg = "最新のデータをデータベースから同期しました！"

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"message": msg}).encode("utf-8"))

print(f"\nブラウザから以下を開いてください:\nhttp://localhost:{WEB_PORT}\n")

with socketserver.TCPServer(("", WEB_PORT), RequestHandler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを停止しました")
        set_scroll_speed(TEXT_SOURCE_INFO, 0)
        ws.disconnect()
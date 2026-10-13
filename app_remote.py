import http.server
import socketserver
import json
import csv
import io
import os
import time
import datetime
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
OBS_PASSWORD = "GzQNnOZxEzEQQ5iI"  # ★OBSのパスワード

# ソース名・シーン名
SCENE_MAIN = "シーン"
SOURCE_STAGE = "ステージ映像"
SOURCE_CM = "CM映像"
TEXT_SOURCE_SONG = "telop"         # 曲名テロップソース名
TEXT_SOURCE_INFO = "infomation"    # AI情報テロップソース名
FILTER_SCROLL = "スクロール"       # infomationに追加したフィルタ名

# CM動画が入っているフォルダ（空欄 "" の場合はこのスクリプトと同じ場所の「CM」フォルダを参照）
CM_FOLDER_PATH = ""
# CMが流れている時に次の時間になっても、CMが終わるまで待つか（True: 待つ / False: すぐ切り替える）
WAIT_CM_FINISH = True

WEB_PORT = 8080

# -------------------------------------------------------------
# 2. OBS接続 & 初期設定
# -------------------------------------------------------------
try:
    ws = obsws(OBS_HOST, OBS_PORT, OBS_PASSWORD)
    ws.connect()
    print("=== OBSに接続しました ===")
except Exception as e:
    print(f"OBS接続失敗: {e}")
    exit(1)

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
        try:
            ws.call(obs_requests.SetSceneItemEnabled(
                sceneName=scene_name,
                sceneItemId=item_id,
                sceneItemEnabled=visible
            ))
        except Exception:
            pass

def update_text_source(source_name, text):
    try:
        ws.call(obs_requests.SetInputSettings(
            inputName=source_name,
            inputSettings={"text": text}
        ))
    except Exception:
        pass

def set_scroll_speed(source_name, speed):
    try:
        ws.call(obs_requests.SetSourceFilterSettings(
            sourceName=source_name,
            filterName=FILTER_SCROLL,
            filterSettings={"speed_x": speed}
        ))
    except Exception:
        pass

def is_cm_playing():
    """CM動画が現在再生中かどうかを判定"""
    try:
        res = ws.call(obs_requests.GetMediaInputStatus(inputName=SOURCE_CM))
        return res.getMediaState() == 'OBS_MEDIA_STATE_PLAYING'
    except Exception:
        return False

# -------------------------------------------------------------
# 3. データ管理 & 定期取得
# -------------------------------------------------------------
class AppData:
    timetable = []
    cm_list = []
    info_list = []
    current_index = -1
    is_auto_mode = True  # ★手動操作時はFalseになり自動引き戻しを防止

data = AppData()

prev_timetable = None
prev_info_list = None

def fetch_all_data():
    global prev_timetable, prev_info_list

    # 1. タイムテーブル取得
    try:
        res = http_requests.get(API_TIMETABLE_URL, timeout=5)
        json_data = res.json()
        new_timetable = [r for r in json_data if r.get("title") and str(r["title"]).strip()]
        
        if prev_timetable is None:
            print(f"タイムテーブル: {len(new_timetable)}件 取得")
        elif new_timetable != prev_timetable:
            print(f"🔄 [更新検知] タイムテーブルが変更されました ({len(new_timetable)}件)")
            
        data.timetable = new_timetable
        prev_timetable = new_timetable
    except Exception as e:
        print(f"タイムテーブル取得失敗: {e}")

    # 2. 下側情報欄取得
    try:
        res = http_requests.get(API_INFO_URL, timeout=5)
        json_data = res.json()
        active_infos = []
        for r in json_data:
            if r.get("formatted_text") or r.get("raw_text"):
                active_infos.append(r)

        if prev_info_list is None:
            print(f"下側情報欄(有効): {len(active_infos)}件 取得")
        elif active_infos != prev_info_list:
            print(f"📢 [更新検知] テロップ情報が更新されました (有効: {len(active_infos)}件)")

        data.info_list = active_infos
        prev_info_list = active_infos
    except Exception as e:
        pass

fetch_all_data()

# データベース常時自動更新ループ
AUTO_SYNC_INTERVAL = 10

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
# 4. 下側テロップ 自動スクロール循環ループ
# -------------------------------------------------------------
def ticker_loop():
    normal_idx = 0
    emergency_idx = 0
    
    while True:
        if not data.info_list:
            time.sleep(2)
            continue

        emergencies = []
        normals = []

        for item in data.info_list:
            tag = item.get("tag", "その他")
            if "緊急" in tag or item.get("is_emergency"):
                emergencies.append(item)
            else:
                normals.append(item)

        target_item = None

        if emergencies:
            target_item = emergencies[emergency_idx % len(emergencies)]
            emergency_idx += 1
        elif normals:
            target_item = normals[normal_idx % len(normals)]
            normal_idx += 1

        if not target_item:
            time.sleep(2)
            continue

        display_text = target_item.get("formatted_text") or target_item.get("raw_text", "")
        display_text = str(display_text).strip().replace("\n", " ").replace("\r", "")

        if not display_text:
            time.sleep(1)
            continue

        try:
            with open("ticker_data.js", "w", encoding="utf-8") as f:
                f.write(f'var latestTickerText = `{display_text}`; var latestTickerTime = {time.time()};\n')
        except Exception as e:
            pass

        text_char_count = len(display_text)
        wait_seconds = max(4.0, (text_char_count * 42 + 160) / 140.0 + 1.0)
        time.sleep(wait_seconds)

ticker_thread = threading.Thread(target=ticker_loop, daemon=True)
ticker_thread.start()

# -------------------------------------------------------------
# 5. ステージ進行・CM切り替えロジック
# -------------------------------------------------------------
cm_index = 0
is_in_break = False
cm_timer_thread = None

def get_cm_files():
    """CMフォルダから動画一覧を取得"""
    folder = CM_FOLDER_PATH if CM_FOLDER_PATH and os.path.exists(CM_FOLDER_PATH) else os.path.join(os.path.dirname(os.path.abspath(__file__)), "CM")
    if not os.path.exists(folder):
        os.makedirs(folder, exist_ok=True)
    return sorted([os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(('.mp4', '.mov', '.mkv'))])

def play_next_cm():
    """★CMを再生（最後まで行ったら1本目からループ）"""
    global cm_index
    cm_files = get_cm_files()
    if not cm_files:
        return

    # インデックスをファイル数で割った余りで常にループさせる
    cm_path = cm_files[cm_index % len(cm_files)]
    cm_index = (cm_index + 1) % len(cm_files)

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
        print(f"🎬 CM再生: {os.path.basename(cm_path)}")

def cm_rotation_loop():
    """幕間中に動画が終わったら次を再生（ループ）"""
    while is_in_break:
        time.sleep(1)
        if not is_in_break:
            break
        if not is_cm_playing():
            play_next_cm()
            time.sleep(2)  # 再生開始までの誤検知防止

def apply_obs_by_index(idx):
    global is_in_break, cm_timer_thread
    if idx < 0 or idx >= len(data.timetable):
        return "範囲外です"

    item = data.timetable[idx]
    item_type = item.get("type", "song")

    if item_type == "song" or item_type == "ステージ（演奏・企画）":
        is_in_break = False
        set_source_visible(SCENE_MAIN, id_stage, True)
        set_source_visible(SCENE_MAIN, id_cm, False)

        display_song = item['title']
        if item.get("band"):
            display_song += f" / {item['band']}"
        update_text_source(TEXT_SOURCE_SONG, display_song)
        set_source_visible(SCENE_MAIN, id_text_song, True)

        return f"【企画】ステージ映像 & テロップ: {display_song}"

    elif item_type == "break" or item_type == "幕間（準備・CM放映）":
        set_source_visible(SCENE_MAIN, id_text_song, False)
        set_source_visible(SCENE_MAIN, id_stage, False)
        set_source_visible(SCENE_MAIN, id_cm, True)

        is_in_break = True
        play_next_cm()

        if cm_timer_thread is None or not cm_timer_thread.is_alive():
            cm_timer_thread = threading.Thread(target=cm_rotation_loop, daemon=True)
            cm_timer_thread.start()

        return f"【幕間】CM映像ON ({item['title']})"

# -------------------------------------------------------------
# 5.5 時刻監視による完全自動切り替えループ
# -------------------------------------------------------------
def auto_time_sync_loop():
    while True:
        time.sleep(1)
        # ★手動操作中の場合は時刻による自動切り替えを行わない
        if not data.is_auto_mode or not data.timetable:
            continue

        now_str = datetime.datetime.now().strftime("%H:%M")
        
        active_idx = -1
        for idx, item in enumerate(data.timetable):
            start = item.get("start_time", "")
            end = item.get("end_time", "")
            if start and end and start <= now_str < end:
                active_idx = idx
                break
        
        # 時刻が変わって切り替える必要がある場合
        if active_idx != -1 and active_idx != data.current_index:
            if WAIT_CM_FINISH and is_cm_playing():
                print(f"\r[{now_str}] ⏳ 次の演目時刻ですが、CM終了を待機中...", end="")
            else:
                print(f"\n[{now_str}] ⏰ 時間です！自動で切り替えます: {data.timetable[active_idx].get('title')}")
                data.current_index = active_idx
                apply_obs_by_index(data.current_index)
        
        # 空き時間になった場合
        elif active_idx == -1 and data.current_index != -1:
            last_item = data.timetable[data.current_index] if data.current_index >= 0 else None
            if last_item and last_item.get("end_time", "") <= now_str:
                print(f"\n[{now_str}] 演目終了/待機時間になりました。")
                data.current_index = -1
                set_source_visible(SCENE_MAIN, id_text_song, False)
                set_source_visible(SCENE_MAIN, id_stage, False)
                set_source_visible(SCENE_MAIN, id_cm, True)
                play_next_cm()

auto_time_thread = threading.Thread(target=auto_time_sync_loop, daemon=True)
auto_time_thread.start()

# -------------------------------------------------------------
# 6. Webコントローラー画面 & サーバー起動
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
    .section-label { font-size: 13px; font-weight: bold; color: #94a3b8; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.05em; display: flex; justify-content: space-between; }
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
    .btn-sync { width: 100%; background: #334155; font-size: 14px; padding: 12px; margin-top: 8px; border: none; border-radius: 8px; color: #38bdf8; cursor: pointer; font-weight: bold; }
    .timetable-list { max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .list-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 8px; background: #0f172a; font-size: 14px; }
    .list-item.active { background: #0369a1; border-left: 4px solid #38bdf8; font-weight: bold; }
    .tag { font-size: 11px; padding: 2px 6px; border-radius: 4px; }
    .tag-song { background: #166534; color: #bbf7d0; }
    .tag-break { background: #854d0e; color: #fef08a; }
    #status-msg { text-align: center; font-size: 13px; color: #38bdf8; min-height: 18px; margin-top: 8px; }
    .mode-badge { font-size: 11px; padding: 3px 8px; border-radius: 10px; color: white; font-weight: bold; }
    .badge-auto { background: #059669; }
    .badge-manual { background: #d97706; }
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
        <div class="section-label" style="color:#e0f2fe;">
          <span>● 現在送出中</span>
          <span id="mode-badge" class="mode-badge badge-auto">時刻で自動同期中</span>
        </div>
        <div id="curr-title" class="slot-title">待機中（未開始）</div>
        <div id="curr-sub" class="slot-sub">時間になると自動で開始されます</div>
      </div>

      <div class="slot slot-next">
        <div class="section-label">▶ 次に控えている演目</div>
        <div id="next-title" class="slot-title">なし</div>
        <div id="next-sub" class="slot-sub"></div>
      </div>

      <div class="btn-row">
        <button class="btn btn-prev" onclick="sendAction('prev')">◀ 前へ戻る (手動)</button>
        <button class="btn btn-next" onclick="sendAction('next')">次へ進む ▶ (手動)</button>
      </div>
      <button class="btn-sync" onclick="sendAction('sync')">↻ 時刻自動同期に戻す</button>
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
      const typeLabel = (item.type === 'song' || item.type === 'ステージ（演奏・企画）') ? '【企画】' : '【幕間】';
      document.getElementById(elTitle).innerText = `${typeLabel} ${item.title}`;
      document.getElementById(elSub).innerText = item.band ? `詳細: ${item.band}` : '';
    }

    async function updateUI() {
      try {
        const res = await fetch('/api/state');
        const d = await res.json();
        
        renderSlot('prev-title', 'prev-sub', d.prev);
        
        if (d.current) {
          renderSlot('curr-title', 'curr-sub', d.current);
        } else {
          document.getElementById('curr-title').innerText = d.currentIndex < 0 ? '待機中（未開始）' : '全スケジュール終了';
          document.getElementById('curr-sub').innerText = d.currentIndex < 0 ? '時間になると自動で開始されます' : '';
        }

        renderSlot('next-title', 'next-sub', d.next);

        // モードバッジの切り替え
        const badge = document.getElementById('mode-badge');
        if (d.isAutoMode) {
          badge.className = 'mode-badge badge-auto';
          badge.innerText = '時刻で自動同期中';
        } else {
          badge.className = 'mode-badge badge-manual';
          badge.innerText = '手動操作中（自動停止）';
        }

        const listEl = document.getElementById('timetable-list');
        listEl.innerHTML = '';
        d.timetable.forEach((item, idx) => {
          const itemDiv = document.createElement('div');
          itemDiv.className = 'list-item' + (idx === d.currentIndex ? ' active' : '');
          
          const isSong = (item.type === 'song' || item.type === 'ステージ（演奏・企画）');
          const tagClass = isSong ? 'tag-song' : 'tag-break';
          const tagText = isSong ? '企画' : '幕間';

          itemDiv.innerHTML = `
            <div>
              <span style="color:#94a3b8; margin-right:6px;">${item.start_time}</span>
              <span>${item.title}</span>
              <span style="color:#94a3b8; font-size:12px; margin-left:8px;">${item.band || ''}</span>
            </div>
            <span class="tag ${tagClass}">${tagText}</span>
          `;
          listEl.appendChild(itemDiv);
        });
      } catch (e) {
        console.error("更新エラー");
      }
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
    setInterval(updateUI, 2000); 
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
                "isAutoMode": data.is_auto_mode,
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

            # ★手動ボタンを押した時は自動引き戻しをOFFにする
            if action == "next":
                data.is_auto_mode = False
                if data.current_index + 1 < len(data.timetable):
                    data.current_index += 1
                    msg = apply_obs_by_index(data.current_index)
                else:
                    msg = "既に最後の企画です"

            elif action == "prev":
                data.is_auto_mode = False
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
                # ★再同期ボタンで自動時刻モードに復帰
                fetch_all_data()
                data.is_auto_mode = True
                msg = "最新データを取得し、時刻による自動同期を再開しました！"

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
        try:
            ws.disconnect()
        except Exception:
            pass
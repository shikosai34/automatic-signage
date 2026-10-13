import os
import time
import datetime
import threading
import requests as http_requests
from obswebsocket import obsws, requests as obs_requests

# -------------------------------------------------------------
# 1. 設定項目
# -------------------------------------------------------------

# APIのベースURL
API_BASE_URL = "https://shikosai-signage-api.shikosai.workers.dev"
API_STATE_URL = f"{API_BASE_URL}/api/state"
API_STATE_UPDATE_URL = f"{API_BASE_URL}/api/state/update"
API_INFO_URL = f"{API_BASE_URL}/api/info"

# OBS接続設定
OBS_HOST = "localhost"
OBS_PORT = 4455
OBS_PASSWORD = "GzQNnOZxEzEQQ5iI"  # ★OBSのパスワード

# ソース名・シーン名
SCENE_MAIN = "シーン"
SOURCE_STAGE = "ステージ映像"
SOURCE_CM = "CM映像"
TEXT_SOURCE_SONG = "telop"         # 企画名・詳細テロップ

# CM動画が入っているフォルダ（空欄 "" の場合はこのスクリプトと同じ場所の「CM」フォルダを参照）
CM_FOLDER_PATH = ""
# 下部テロップの書き出し先ファイル
TICKER_JS_PATH = "ticker_data.js"

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
    except Exception:
        return None

id_text_song = get_item_id(SCENE_MAIN, TEXT_SOURCE_SONG)
id_stage = get_item_id(SCENE_MAIN, SOURCE_STAGE)
id_cm = get_item_id(SCENE_MAIN, SOURCE_CM)

def set_source_visible(scene_name, item_id, visible):
    if item_id is not None:
        try:
            ws.call(obs_requests.SetSceneItemEnabled(sceneName=scene_name, sceneItemId=item_id, sceneItemEnabled=visible))
        except Exception:
            pass

def update_text_source(source_name, text):
    try:
        ws.call(obs_requests.SetInputSettings(inputName=source_name, inputSettings={"text": text}))
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
# 3. 下部テロップ書き出しループ（info_bottom用）
# -------------------------------------------------------------
info_list = []
prev_info_list = None  # ★追加: 前回データを保存

def fetch_info():
    global info_list, prev_info_list
    try:
        res = http_requests.get(API_INFO_URL, timeout=5)
        new_info = [r for r in res.json() if r.get("formatted_text") or r.get("raw_text")]
        
        # ★追加: 更新検知ログ
        if prev_info_list is not None and new_info != prev_info_list:
            print(f"\n📢 [更新検知] テロップ情報が変更されました (有効: {len(new_info)}件)")
        
        info_list = new_info
        prev_info_list = new_info
    except Exception:
        pass

def ticker_loop():
    normal_idx = 0
    emergency_idx = 0
    # 初回取得時のログ表示
    fetch_info()
    if prev_info_list is not None:
        print(f"下側情報欄(有効): {len(prev_info_list)}件 取得")

    while True:
        fetch_info()
        if not info_list:
            time.sleep(2)
            continue

        emergencies = [i for i in info_list if "緊急" in i.get("tag", "その他")]
        normals = [i for i in info_list if "緊急" not in i.get("tag", "その他")]

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

        display_text = str(target_item.get("formatted_text") or target_item.get("raw_text", "")).strip()
        if not display_text:
            time.sleep(1)
            continue

        try:
            with open(TICKER_JS_PATH, "w", encoding="utf-8") as f:
                f.write(f'var latestTickerText = `{display_text}`; var latestTickerTime = {time.time()};\n')
        except Exception:
            pass

        wait_seconds = max(4.0, (len(display_text) * 42 + 160) / 140.0 + 1.0)
        time.sleep(wait_seconds)

threading.Thread(target=ticker_loop, daemon=True).start()

# -------------------------------------------------------------
# 4. CM自動ローテーション機能（無限ループ再生）
# -------------------------------------------------------------
cm_index = 0
def get_cm_files():
    folder = CM_FOLDER_PATH if CM_FOLDER_PATH and os.path.exists(CM_FOLDER_PATH) else os.path.join(os.path.dirname(os.path.abspath(__file__)), "CM")
    if not os.path.exists(folder):
        os.makedirs(folder, exist_ok=True)
    return sorted([os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(('.mp4', '.mov', '.mkv'))])

def play_next_cm():
    global cm_index
    cm_files = get_cm_files()
    if not cm_files:
        return

    cm_path = cm_files[cm_index % len(cm_files)]
    cm_index = (cm_index + 1) % len(cm_files)

    try:
        ws.call(obs_requests.SetInputSettings(inputName=SOURCE_CM, inputSettings={"local_file": cm_path, "looping": False}))
        ws.call(obs_requests.TriggerMediaInputAction(inputName=SOURCE_CM, mediaAction="OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART"))
        print(f"🎬 CM再生: {os.path.basename(cm_path)}")
    except Exception:
        pass

# -------------------------------------------------------------
# 5. ステージ進行とCloudflare同期ロジック
# -------------------------------------------------------------
current_index = -999
prev_timetable = None  # ★追加: 前回データを保存

def apply_obs_by_index(timetable, idx):
    global current_index
    current_index = idx

    # 待機中（-1）の場合
    if idx < 0 or idx >= len(timetable):
        set_source_visible(SCENE_MAIN, id_text_song, False)
        set_source_visible(SCENE_MAIN, id_stage, False)
        set_source_visible(SCENE_MAIN, id_cm, True)
        if not is_cm_playing():
            play_next_cm()
        return

    item = timetable[idx]
    item_type = item.get("type", "song")

    if item_type == "song" or item_type == "ステージ（演奏・企画）":
        set_source_visible(SCENE_MAIN, id_stage, True)
        set_source_visible(SCENE_MAIN, id_cm, False)

        display_song = item.get('title', '')
        if item.get("band"):
            display_song += f" / {item['band']}"
        update_text_source(TEXT_SOURCE_SONG, display_song)
        set_source_visible(SCENE_MAIN, id_text_song, True)
        print(f"\n[{time.strftime('%H:%M:%S')}] 📺 ステージに切り替え: {display_song}")

    else:
        set_source_visible(SCENE_MAIN, id_text_song, False)
        set_source_visible(SCENE_MAIN, id_stage, False)
        set_source_visible(SCENE_MAIN, id_cm, True)
        print(f"\n[{time.strftime('%H:%M:%S')}] ☕ 幕間に切り替え: {item.get('title', '')}")
        play_next_cm()

def main_loop():
    global current_index, prev_timetable
    target_cm_dir = CM_FOLDER_PATH if CM_FOLDER_PATH else os.path.join(os.path.dirname(os.path.abspath(__file__)), "CM")

    print("\n==================================================")
    print("🚀 OBS制御システム（Web完全連動版）稼働開始")
    print(f"CMフォルダ: {target_cm_dir}")
    print("操作はすべてWeb管理画面（/admin）から行えます。")
    print("==================================================")

    while True:
        time.sleep(1.0)
        try:
            res = http_requests.get(API_STATE_URL, timeout=4).json()
            state = res.get("state", {})
            timetable = res.get("timetable", [])

            # ★追加: 更新検知ログ
            if prev_timetable is None:
                print(f"タイムテーブル: {len(timetable)}件 取得")
            elif timetable != prev_timetable:
                print(f"\n🔄 [更新検知] タイムテーブルが変更されました ({len(timetable)}件)")
            prev_timetable = timetable

            is_auto = bool(state.get("is_auto", 1))
            wait_cm = bool(state.get("wait_cm", 0))
            remote_index = int(state.get("current_index", -1))

            now_str = datetime.datetime.now().strftime("%H:%M")

            # 1. 自動進行モードがONの場合
            if is_auto:
                expected_idx = -1
                for i, item in enumerate(timetable):
                    if item.get("start_time", "") <= now_str < item.get("end_time", ""):
                        expected_idx = i
                        break

                if expected_idx != current_index:
                    # CM完走待ち判定
                    if wait_cm and is_cm_playing() and expected_idx != -1:
                        print(f"\r[{now_str}] ⏳ 次の演目時間ですが、CM終了を待機中...", end="")
                    else:
                        print()
                        apply_obs_by_index(timetable, expected_idx)
                        http_requests.post(API_STATE_UPDATE_URL, json={"current_index": expected_idx}, timeout=4)

            # 2. 手動モード（自動進行OFF）の場合
            else:
                if remote_index != current_index:
                    print(f"\n[{now_str}] 🤚 Webからの手動操作を受信: インデックス {remote_index}")
                    apply_obs_by_index(timetable, remote_index)

            # 3. 幕間中のCMループ再生チェック
            is_break_time = (current_index == -1) or (0 <= current_index < len(timetable) and ("幕間" in timetable[current_index].get("type", "") or "break" in timetable[current_index].get("type", "")))
            if is_break_time:
                if not is_cm_playing():
                    play_next_cm()
                    time.sleep(1.5)

        except Exception:
            pass

if __name__ == "__main__":
    try:
        main_loop()
    except KeyboardInterrupt:
        print("\nシステムを停止しました。")
        try:
            ws.disconnect()
        except Exception:
            pass
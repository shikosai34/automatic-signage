import os
import time
import datetime
import requests as http_requests
from obswebsocket import obsws, requests as obs_requests

# -------------------------------------------------------------
# 1. 設定項目
# -------------------------------------------------------------

# APIのベースURL
API_BASE_URL = "https://shikosai-signage-api.shikosai.workers.dev"
API_STATE_URL = f"{API_BASE_URL}/api/state"

# OBS接続設定
OBS_HOST = "localhost"
OBS_PORT = 4455
OBS_PASSWORD = "GzQNnOZxEzEQQ5iI"  # ★OBSのパスワード

# シーン名・ソース名
SCENE_STAGE = "シーン1"   # ステージ用シーン名
SCENE_BREAK = "シーン2"   # 幕間・待機用シーン名
TEXT_SOURCE_SONG = "telop" # 演目名テキスト（シーン1にある場合）

# -------------------------------------------------------------
# 2. OBS接続 & 制御関数
# -------------------------------------------------------------
try:
    ws = obsws(OBS_HOST, OBS_PORT, OBS_PASSWORD)
    ws.connect()
    print("=== OBSに接続しました ===")
except Exception as e:
    print(f"OBS接続失敗: {e}")
    exit(1)

def set_scene(scene_name):
    """指定したシーンに切り替える"""
    try:
        ws.call(obs_requests.SetCurrentProgramScene(sceneName=scene_name))
    except Exception as e:
        print(f"シーン切り替えエラー ({scene_name}): {e}")

def update_text_source(source_name, text):
    """テキストソースの内容を更新する"""
    try:
        ws.call(obs_requests.SetInputSettings(inputName=source_name, inputSettings={"text": text}))
    except Exception:
        pass

# -------------------------------------------------------------
# 3. メインループ（手動進行モード特化・CM機能なし）
# -------------------------------------------------------------
current_index = -999

def apply_obs_by_index(timetable, idx):
    global current_index
    current_index = idx

    # 待機中（-1）の場合 -> シーン2
    if idx < 0 or idx >= len(timetable):
        set_scene(SCENE_BREAK)
        print(f"\n[{time.strftime('%H:%M:%S')}] ☕ 待機中（{SCENE_BREAK} へ切り替え）")
        return

    item = timetable[idx]
    item_type = item.get("type", "song")

    # ステージの場合 -> シーン1
    if item_type == "song" or item_type == "ステージ（演奏・企画）":
        set_scene(SCENE_STAGE)
        
        display_song = item.get('title', '')
        if item.get("band"):
            display_song = f"{item['band']} - {display_song}" if display_song else item["band"]
        update_text_source(TEXT_SOURCE_SONG, display_song)
        
        print(f"\n[{time.strftime('%H:%M:%S')}] 📺 ステージ開始（{SCENE_STAGE} へ切り替え）: {display_song}")

    # 幕間CMの場合 -> シーン2
    else:
        set_scene(SCENE_BREAK)
        print(f"\n[{time.strftime('%H:%M:%S')}] ☕ 幕間開始（{SCENE_BREAK} へ切り替え）: {item.get('title', '')}")

def main_loop():
    global current_index
    print("\n==================================================")
    print("🚀 OBS手動制御システム（シーン切替のみ）稼働開始")
    print("==================================================")

    while True:
        time.sleep(1.0)
        try:
            res = http_requests.get(API_STATE_URL, timeout=4).json()
            state = res.get("state", {})
            timetable = res.get("timetable", [])
            remote_index = int(state.get("current_index", -1))

            # Webからの手動操作を受信してシーンを切り替え
            if remote_index != current_index:
                apply_obs_by_index(timetable, remote_index)

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
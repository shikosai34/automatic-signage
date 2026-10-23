import time
from obswebsocket import obsws, requests

# --- OBS設定 ---
HOST = "localhost"
PORT = 4455
PASSWORD = "GzQNnOZxEzEQQ5iI"

ws = obsws(HOST, PORT, PASSWORD)
ws.connect()
print("=== OBSに接続しました ===")

SCENE_MAIN = "シーン"
SCENE_SUB = "シーン 2"
TEXT_SOURCE = "telop"

# アイテムIDの取得
res = ws.call(requests.GetSceneItemId(sceneName=SCENE_MAIN, sourceName=TEXT_SOURCE))
item_id = res.getSceneItemId()

# --- タイムテーブルのダミーデータ（後でスプレッドシートに置き換えます） ---
timetable = [
    {"type": "song", "title": "天体観測", "band": "軽音部Aチーム"},
    {"type": "song", "title": "丸の内サディスティック", "band": "軽音部Aチーム"},
    {"type": "break", "title": "幕間（サークルCM・連絡）"},
    {"type": "song", "title": "小さな恋のうた", "band": "有志バンドB"},
]

current_index = 0

print("\n--- 操作方法 ---")
print("[Enterキー]: 次の演目に進む")
print("[q を入力してEnter]: 終了")
print("----------------\n")

while current_index < len(timetable):
    item = timetable[current_index]
    
    # 待機
    user_input = input(f"次の待機中 [{current_index + 1}/{len(timetable)}]: {item['title']} (Enterで実行) > ")
    if user_input.lower() == "q":
        break

    if item["type"] == "song":
        # 1. メイン画面に戻す
        ws.call(requests.SetCurrentProgramScene(sceneName=SCENE_MAIN))
        
        # 2. テキスト更新
        display_text = f"♪ {item['title']} / {item['band']}"
        ws.call(requests.SetInputSettings(
            inputName=TEXT_SOURCE,
            inputSettings={"text": display_text}
        ))
        
        # 3. テロップ表示
        ws.call(requests.SetSceneItemEnabled(
            sceneName=SCENE_MAIN,
            sceneItemId=item_id,
            sceneItemEnabled=True
        ))
        print(f"  -> 表示中: {display_text}")
        
        # ※本番は数秒後に消しますが、動作確認用として3秒後に自動非表示
        time.sleep(3)
        ws.call(requests.SetSceneItemEnabled(
            sceneName=SCENE_MAIN,
            sceneItemId=item_id,
            sceneItemEnabled=False
        ))
        print("  -> テロップを非表示にしました")

    elif item["type"] == "break":
        # 幕間画面（シーン2）に切り替え
        ws.call(requests.SetCurrentProgramScene(sceneName=SCENE_SUB))
        print(f"  -> 画面切替: {SCENE_SUB}（幕間）")

    current_index += 1

print("\n全演目が終了しました！")
ws.disconnect()
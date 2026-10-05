import csv
import io
import time
import requests as http_requests
from obswebsocket import obsws, requests as obs_requests

# -------------------------------------------------------------
# 設定
# -------------------------------------------------------------
# Googleスプレッドシートで「ウェブに公開 (.csv)」したURLを貼り付ける
SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSVZ8pEwfQqdHHmyZu8V4fkVxVodYUqUj68R4cQiNgrjfqwp2l3SQNhA-yyW30bj5ebEjE8CJOEdf7a/pub?gid=0&single=true&output=csv"

OBS_HOST = "localhost"
OBS_PORT = 4455
OBS_PASSWORD = ""

SCENE_MAIN = "シーン"
SCENE_SUB = "シーン 2"
TEXT_SOURCE = "テキスト (FreeType 2)"

# -------------------------------------------------------------
# OBS接続とアイテムID取得
# -------------------------------------------------------------
ws = obsws(OBS_HOST, OBS_PORT, OBS_PASSWORD)
ws.connect()
print("=== OBSに接続しました ===")

res = ws.call(obs_requests.GetSceneItemId(sceneName=SCENE_MAIN, sourceName=TEXT_SOURCE))
item_id = res.getSceneItemId()

# -------------------------------------------------------------
# スプレッドシートからデータを取得する関数
# -------------------------------------------------------------
def fetch_timetable_from_sheets(url):
    try:
        response = http_requests.get(url, timeout=5)
        response.encoding = "utf-8"
        response.raise_for_status()
        
        # 取得したCSV文字列を辞書リストに変換
        csv_file = io.StringIO(response.text)
        reader = csv.DictReader(csv_file)
        table = [row for row in reader]
        return table
    except Exception as e:
        print(f"スプレッドシートの取得に失敗しました: {e}")
        return []

# 初回読み込み
timetable = fetch_timetable_from_sheets(SHEET_CSV_URL)
if not timetable:
    print("データが取得できませんでした。URLを確認してください。")
    ws.disconnect()
    exit()

print(f"スプレッドシートから {len(timetable)} 件のスケジュールを読み込みました！")

# -------------------------------------------------------------
# 進行ループ
# -------------------------------------------------------------
current_index = 0

print("\n--- 操作方法 ---")
print("[Enterキー]: 次の演目を実行")
print("[r を入力してEnter]: スプレッドシートを再同期（最新情報に更新）")
print("[q を入力してEnter]: 終了")
print("----------------\n")

while current_index < len(timetable):
    item = timetable[current_index]

    prompt_label = item["title"]
    if item["type"] == "song":
        prompt_label = f"{item['title']} ({item.get('band', '')})"

    user_input = input(f"待機中 [{current_index + 1}/{len(timetable)}]: {prompt_label} (Enterで実行) > ")

    if user_input.lower() == "q":
        break
    elif user_input.lower() == "r":
        timetable = fetch_timetable_from_sheets(SHEET_CSV_URL)
        print(">> スプレッドシートと再同期しました！最新のスケジュールに更新されました。")
        continue

    # 1. 演目（曲）の場合
    if item["type"] == "song":
        ws.call(obs_requests.SetCurrentProgramScene(sceneName=SCENE_MAIN))

        band_name = item.get('band', '')
        display_text = f"♪ {item['title']}"
        if band_name:
            display_text += f" / {band_name}"

        ws.call(obs_requests.SetInputSettings(
            inputName=TEXT_SOURCE,
            inputSettings={"text": display_text}
        ))

        ws.call(obs_requests.SetSceneItemEnabled(
            sceneName=SCENE_MAIN,
            sceneItemId=item_id,
            sceneItemEnabled=True
        ))
        print(f"  -> 表示中: {display_text}")

        # 3秒待機後に非表示（本番は必要に応じて調整）
        time.sleep(3)
        ws.call(obs_requests.SetSceneItemEnabled(
            sceneName=SCENE_MAIN,
            sceneItemId=item_id,
            sceneItemEnabled=False
        ))
        print("  -> テロップ非表示")

    # 2. 幕間・転換の場合
    elif item["type"] == "break":
        ws.call(obs_requests.SetCurrentProgramScene(sceneName=SCENE_SUB))
        print(f"  -> 幕間画面へ切替: {SCENE_SUB}")

    current_index += 1

print("\n全スケジュールが終了しました。")
ws.disconnect()
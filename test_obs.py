import time
from obswebsocket import obsws, requests

# --- OBS接続設定 ---
HOST = "localhost"
PORT = 4455
PASSWORD = ""

ws = obsws(HOST, PORT, PASSWORD)
ws.connect()
print("OBSに接続しました！")

SCENE_NAME = "シーン"
TEXT_SOURCE = "テキスト (FreeType 2)"

# ---------------------------------------------
# 1. シーン内の「シーンアイテムID」を取得する
# （OBSでソースの表示/非表示を切り替えるにはこのIDが必要です）
# ---------------------------------------------
res = ws.call(requests.GetSceneItemId(
    sceneName=SCENE_NAME,
    sourceName=TEXT_SOURCE
))
item_id = res.getSceneItemId()
print(f"テキストソースのアイテムID: {item_id}")

# ---------------------------------------------
# 2. テキストの内容をセットし、非表示（OFF）にする
# ---------------------------------------------
ws.call(requests.SetInputSettings(
    inputName=TEXT_SOURCE,
    inputSettings={"text": "♪ 演奏開始：新時代 / 軽音部"}
))
# 表示をOFFにする
ws.call(requests.SetSceneItemEnabled(
    sceneName=SCENE_NAME,
    sceneItemId=item_id,
    sceneItemEnabled=False
))
print("テキストを非表示にしました")
time.sleep(2)

# ---------------------------------------------
# 3. テキストを表示（ON）にする（曲が始まった合図）
# ---------------------------------------------
ws.call(requests.SetSceneItemEnabled(
    sceneName=SCENE_NAME,
    sceneItemId=item_id,
    sceneItemEnabled=True
))
print("テロップを表示しました！")

# 5秒間表示したままにする
time.sleep(5)

# ---------------------------------------------
# 4. 自動でテロップを消す（フェードアウトの代わり）
# ---------------------------------------------
ws.call(requests.SetSceneItemEnabled(
    sceneName=SCENE_NAME,
    sceneItemId=item_id,
    sceneItemEnabled=False
))
print("テロップを自動で消去しました")
time.sleep(2)

# ---------------------------------------------
# 5. 「シーン 2」へ画面を切り替える（転換・幕間へ移行）
# ---------------------------------------------
ws.call(requests.SetCurrentProgramScene(
    sceneName="シーン 2"
))
print("「シーン 2」へ切り替えました！")
time.sleep(3)

# 元の「シーン」に戻す
ws.call(requests.SetCurrentProgramScene(
    sceneName="シーン"
))
print("「シーン」に戻しました")

ws.disconnect()
print("完了しました！")
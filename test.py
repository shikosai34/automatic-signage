import urllib.request
import urllib.error # これを追加しました
import json

# さきほどデプロイしたAPIのURL
url = "https://shikosai-signage-api.kobot0526.workers.dev/api/format"

test_message = """
お疲れ様です。写真部です。
本日の展示は15時で終了となります。
あと、黒いカメラケースの落とし物がありましたので、心当たりのある方は受付までお願いします。
よろしくお願いします。
"""

data = {
    "text": test_message
}

req = urllib.request.Request(
    url,
    data=json.dumps(data).encode('utf-8'),
    headers={
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
    }
)

print("AIにデータを送信中...")

try:
    with urllib.request.urlopen(req) as response:
        result_json = response.read().decode('utf-8')
        result_dict = json.loads(result_json)
        
        print("\n=== AIからの返答 ===")
        print(result_dict)
        print("==================\n")
        
except urllib.error.HTTPError as e:
    print(f"\nサーバー内部でエラーが発生しました ({e.code}):")
    # 隠れていたサーバーからの詳細なエラーメッセージを表示する
    print(e.read().decode('utf-8'))
except Exception as e:
    print("\n通信エラーが発生しました:")
    print(e)
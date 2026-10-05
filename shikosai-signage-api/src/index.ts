import { Hono } from 'hono'

// Cloudflareの環境変数（シークレット）の型定義
type Bindings = {
  GEMINI_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

// サーバーが動いているか確認用のURL
app.get('/', (c) => {
  return c.text('Shikosai Signage API is running!')
})

// AIにテロップを整形させるAPI
app.post('/api/format', async (c) => {
  try {
    // 1. 送られてきた元の文章を受け取る
    const body = await c.req.json()
    const rawText = body.text

    if (!rawText) {
      return c.json({ error: "textがありません" }, 400)
    }

    // 2. AIへの指示書（システムプロンプト）
    const systemInstruction = `
あなたは文化祭（茨香祭）のデジタルサイネージ・テロップ作成アシスタントです。
サークルや関係者から送られてくる雑な連絡文を、サイネージ下部に流すための簡潔で分かりやすい「テロップ用テキスト」に整形してください。

【出力ルール】
- 30文字〜45文字程度の日本語1行で出力すること。
- 先頭に必ず適切なカテゴリタグを付けること。（例: 【完売情報】、【注意】、【お知らせ】、【イベント変更】、【落とし物】など）
- 絵文字や不要な改行、挨拶文は削除すること。
- 出力は整形後のテキストのみとし、解説や前置きは一切出力しないこと。
`

    // 3. Gemini APIを呼び出す
    const apiKey = c.env.GEMINI_API_KEY
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`

    const payload = {
      system_instruction: { parts: { text: systemInstruction } },
      contents: [{ parts: [{ text: rawText }] }],
      generationConfig: { temperature: 0.2 }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    const data = await response.json()

    if (!response.ok) {
      console.error("Gemini API Error:", data)
      return c.json({ error: "AIの処理中にエラーが発生しました" }, 500)
    }

    // 4. 整形されたテキストを取り出して返す
    const formattedText = data.candidates[0].content.parts[0].text.trim()
    return c.json({ formatted_text: formattedText })

  } catch (e) {
    console.error(e)
    return c.json({ error: "サーバー内部でエラーが発生しました" }, 500)
  }
})

export default app
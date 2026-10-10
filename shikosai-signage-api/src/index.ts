import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  GEMINI_API_KEY: string
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())

// サーバー起動確認
app.get('/', (c) => {
  return c.text('Shikosai Signage API is running!')
})

// ★スマホ・PC兼用 テロップ総合管理画面
app.get('/admin', (c) => {
  return c.html(HTML_ADMIN_PAGE)
})

// 1. 【OBS・Python用】表示有効(is_active=1)なテロップのみ取得
app.get('/api/info', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM info WHERE is_active = 1 ORDER BY id DESC'
  ).all()
  return c.json(results)
})

// 2. 【管理画面用】全テロップ一覧（表示ONが上、表示OFFが下）
app.get('/api/info/all', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM info ORDER BY is_active DESC, id DESC'
  ).all()
  return c.json(results)
})

// 3. 【追加】新しいテロップを登録
app.post('/api/info', async (c) => {
  const body = await c.req.json()
  const rawText = body.raw_text || body.text || ''
  const formattedText = body.formatted_text || rawText
  const tag = body.tag || 'その他'
  const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : 1

  await c.env.DB.prepare(
    'INSERT INTO info (raw_text, formatted_text, tag, frequency, is_active) VALUES (?, ?, ?, 1, ?)'
  ).bind(rawText, formattedText, tag, isActive).run()

  return c.json({ success: true })
})

// 4. 【更新】リスト上の項目を編集・表示切替
app.post('/api/info/update', async (c) => {
  const body = await c.req.json()
  const { id, formatted_text, tag, is_active } = body

  await c.env.DB.prepare(
    'UPDATE info SET formatted_text = ?, tag = ?, is_active = ? WHERE id = ?'
  ).bind(formatted_text, tag, is_active ? 1 : 0, id).run()

  return c.json({ success: true })
})

// 5. 【削除】不要なテロップを削除
app.post('/api/info/delete', async (c) => {
  const body = await c.req.json()
  await c.env.DB.prepare('DELETE FROM info WHERE id = ?').bind(body.id).run()
  return c.json({ success: true })
})

// 6. タイムテーブル取得
app.get('/api/timetable', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM timetable').all()
  return c.json(results)
})

// 7. AI整形API
app.post('/api/format', async (c) => {
  try {
    const body = await c.req.json()
    const rawText = body.text
    if (!rawText) return c.json({ error: "textがありません" }, 400)

    const systemInstruction = `
あなたは文化祭（茨香祭）のデジタルサイネージ・テロップ作成アシスタントです。
サークルや関係者から送られてくる連絡文を、サイネージ下部に流すための簡潔で分かりやすい「テロップ用テキスト」に整形してください。

【出力ルール】
- 30文字〜45文字程度の日本語1行で出力すること。
- 先頭に必ず適切なカテゴリタグを付けること。（例: 【完売情報】、【注意】、【お知らせ】、【イベント変更】、【落とし物】など）
- 絵文字や不要な改行、挨拶文は削除すること。
- 出力は整形後のテキストのみとし、解説や前置きは一切出力しないこと。
`
    const apiKey = c.env.GEMINI_API_KEY
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: { text: systemInstruction } },
        contents: [{ parts: [{ text: rawText }] }],
        generationConfig: { temperature: 0.2 }
      })
    })

    const data = await response.json()
    if (!response.ok) return c.json({ error: "AI整形エラー" }, 500)

    const formattedText = data.candidates[0].content.parts[0].text.trim()
    return c.json({ formatted_text: formattedText })
  } catch (e) {
    return c.json({ error: "サーバー内部エラー" }, 500)
  }
})

// 管理画面のHTML定義
const HTML_ADMIN_PAGE = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>茨香祭 テロップ総合管理コンソール</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 16px; }
    .container { max-width: 800px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
    .card { background: #1e293b; padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
    h2, h3 { margin-top: 0; margin-bottom: 12px; }
    textarea { width: 100%; height: 75px; padding: 10px; background: #0f172a; border: 1px solid #334155; color: #f8fafc; border-radius: 6px; font-size: 15px; resize: vertical; }
    .form-row { display: flex; gap: 12px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
    select, input[type="text"] { background: #0f172a; border: 1px solid #334155; color: #f8fafc; padding: 8px 10px; border-radius: 6px; font-size: 14px; }
    .btn { background: #2563eb; color: white; border: none; padding: 10px 18px; border-radius: 6px; cursor: pointer; font-weight: bold; transition: background 0.2s; }
    .btn:hover { background: #1d4ed8; }
    .btn-danger { background: #dc2626; padding: 6px 12px; font-size: 12px; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-save { background: #059669; padding: 6px 12px; font-size: 12px; }
    .btn-save:hover { background: #047857; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }

    /* リスト表示 */
    .list-container { display: flex; flex-direction: column; gap: 12px; }
    .item-card { background: #1e293b; border-radius: 8px; padding: 14px; border-left: 5px solid #64748b; transition: 0.2s; }
    .item-active { border-left-color: #38bdf8; background: #1a2744; }
    .item-inactive { opacity: 0.65; border-left-color: #475569; }
    .item-emergency { border-left-color: #ef4444 !important; }
    .item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px; }

    .raw-text-box { font-size: 12px; color: #94a3b8; background: #0f172a; padding: 6px 10px; border-radius: 4px; margin-bottom: 8px; word-break: break-all; }
    .edit-formatted { width: 100%; padding: 8px; background: #0f172a; border: 1px solid #334155; color: #38bdf8; font-size: 15px; font-weight: bold; border-radius: 4px; }
    .item-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; font-size: 13px; }

    /* トースト通知 */
    #toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #059669;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      font-weight: bold;
      box-shadow: 0 8px 16px rgba(0,0,0,0.4);
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s ease;
      z-index: 1000;
    }
    #toast.show {
      transform: translateY(0);
      opacity: 1;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h2>📢 テロップ新規登録</h2>
      <textarea id="rawText" placeholder="サークルや本部からの連絡文を入力..."></textarea>
      
      <div class="form-row">
        <label>タグ:
          <select id="tagSelect">
            <option value="グッズ案内">グッズ案内</option>
            <option value="企画宣伝">企画宣伝</option>
            <option value="迷子落とし物">迷子落とし物</option>
            <option value="その他" selected>その他</option>
            <option value="その他（そのまま）">その他（そのまま）</option>
            <option value="緊急">🚨 緊急</option>
            <option value="緊急（そのまま）">🚨 緊急（そのまま）</option>
          </select>
        </label>

        <label style="margin-left:auto; display:flex; align-items:center; gap:6px;">
          <input type="checkbox" id="isActiveCheck" checked> すぐに表示する
        </label>

        <button class="btn" id="submitBtn" onclick="submitItem()">送信して追加</button>
      </div>
      <div id="statusMsg" style="margin-top:10px; font-weight:bold; font-size:14px;"></div>
    </div>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3>📋 登録テロップ一覧</h3>
        <button class="btn" style="padding:6px 12px; font-size:12px; background:#334155;" onclick="loadList()">↻ リスト更新</button>
      </div>
      <p style="font-size:12px; color:#94a3b8; margin-top:0;">※ 上側が表示有効、下側が表示停止中。文面やタグはここから直接編集して保存できます。</p>
      
      <div id="itemList" class="list-container">読み込み中...</div>
    </div>
  </div>

  <div id="toast">✅ 変更を保存しました！</div>

  <script>
    const API_BASE = window.location.origin;
    const TAG_LIST = ["グッズ案内", "企画宣伝", "迷子落とし物", "その他", "その他（そのまま）", "緊急", "緊急（そのまま）"];

    function showToast(message, isError) {
      const toast = document.getElementById('toast');
      toast.innerText = message;
      toast.style.background = isError ? '#dc2626' : '#059669';
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 2200);
    }

    async function submitItem() {
      const rawText = document.getElementById('rawText').value.trim();
      const tag = document.getElementById('tagSelect').value;
      const isActive = document.getElementById('isActiveCheck').checked;
      const status = document.getElementById('statusMsg');
      const submitBtn = document.getElementById('submitBtn');

      if (!rawText) return alert("文章を入力してください");

      submitBtn.disabled = true;
      status.style.color = "#38bdf8";
      status.innerText = "処理中...";

      let formattedText = rawText;

      if (!tag.includes("（そのまま）")) {
        try {
          status.innerText = "AIがテロップを成形中...";
          const aiRes = await fetch(API_BASE + '/api/format', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: rawText })
          });
          const aiData = await aiRes.json();
          if (aiData.formatted_text) formattedText = aiData.formatted_text;
        } catch (e) {
          console.warn("AI整形失敗、元の文を使用します", e);
        }
      }

      status.innerText = "データベースに保存中...";
      try {
        const res = await fetch(API_BASE + '/api/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            raw_text: rawText,
            formatted_text: formattedText,
            tag: tag,
            is_active: isActive
          })
        });

        if (res.ok) {
          status.style.color = "#4ade80";
          status.innerText = "追加完了: " + formattedText;
          document.getElementById('rawText').value = '';
          showToast("📢 新しいテロップを登録しました！", false);
          loadList();
        } else {
          status.style.color = "#f87171";
          status.innerText = "登録に失敗しました";
        }
      } catch (err) {
        status.style.color = "#f87171";
        status.innerText = "通信エラーが発生しました";
      } finally {
        submitBtn.disabled = false;
      }
    }

    async function loadList() {
      const listEl = document.getElementById('itemList');
      try {
        const res = await fetch(API_BASE + '/api/info/all');
        const items = await res.json();

        if (!items || items.length === 0) {
          listEl.innerHTML = '<div style="text-align:center; color:#64748b;">登録されたテロップはありません</div>';
          return;
        }

        listEl.innerHTML = '';
        items.forEach(item => {
          const isEmergency = item.tag.includes('緊急');
          const card = document.createElement('div');
          card.className = 'item-card ' + (item.is_active ? 'item-active' : 'item-inactive') + (isEmergency ? ' item-emergency' : '');

          let tagOptions = '';
          TAG_LIST.forEach(t => {
            const selected = (t === item.tag) ? ' selected' : '';
            tagOptions += '<option value="' + t + '"' + selected + '>' + t + '</option>';
          });

          const activeColor = item.is_active ? '#38bdf8' : '#94a3b8';
          const activeLabel = item.is_active ? '● 表示中' : '✕ 非表示';
          const checkedAttr = item.is_active ? ' checked' : '';

          card.innerHTML = 
            '<div class="item-header">' +
              '<label style="display:flex; align-items:center; gap:8px; cursor:pointer;">' +
                '<input type="checkbox" id="check-' + item.id + '"' + checkedAttr + ' onchange="updateItem(' + item.id + ', this)">' +
                '<strong style="color:' + activeColor + '">' + activeLabel + '</strong>' +
              '</label>' +
              '<div style="display:flex; align-items:center; gap:8px;">' +
                '<select id="tag-' + item.id + '" onchange="updateItem(' + item.id + ', this)">' + tagOptions + '</select>' +
              '</div>' +
            '</div>' +
            '<div class="raw-text-box">【入力原文】' + escapeHtml(item.raw_text) + '</div>' +
            '<input type="text" class="edit-formatted" id="text-' + item.id + '" value="' + escapeHtml(item.formatted_text || item.raw_text) + '">' +
            '<div class="item-footer">' +
              '<button class="btn btn-save" onclick="updateItem(' + item.id + ', this)">変更を保存</button>' +
              '<button class="btn btn-danger" onclick="deleteItem(' + item.id + ')">削除</button>' +
            '</div>';

          listEl.appendChild(card);
        });
      } catch (e) {
        listEl.innerHTML = '<div style="color:#f87171;">一覧の取得に失敗しました</div>';
      }
    }

    async function updateItem(id, btnElement) {
      if (btnElement && btnElement.tagName === 'BUTTON') {
        btnElement.disabled = true;
        btnElement.innerText = "保存中...";
      }

      const is_active = document.getElementById('check-' + id).checked;
      const tag = document.getElementById('tag-' + id).value;
      const formatted_text = document.getElementById('text-' + id).value;

      try {
        const res = await fetch(API_BASE + '/api/info/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, is_active, tag, formatted_text })
        });
        if (res.ok) {
          showToast("✅ 変更を保存しました！", false);
          loadList();
        } else {
          showToast("❌ 保存に失敗しました", true);
        }
      } catch (e) {
        showToast("❌ 通信エラーが発生しました", true);
      }
    }

    async function deleteItem(id) {
      if (!confirm("本当に削除しますか？")) return;
      try {
        const res = await fetch(API_BASE + '/api/info/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        if (res.ok) {
          showToast("🗑️ テロップを削除しました", false);
          loadList();
        }
      } catch (e) {
        showToast("❌ 削除に失敗しました", true);
      }
    }

    function escapeHtml(str) {
      return (str || '').replace(/[&<>'"]/g, function(tag) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag;
      });
    }

    loadList();
  </script>
</body>
</html>
`

export default app
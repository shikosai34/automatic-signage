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

// 管理画面
app.get('/admin', (c) => {
  return c.html(HTML_ADMIN_PAGE)
})

// 共通処理: 時刻のゼロ埋め（8:00 -> 08:00）
const padTimeStr = (t: string) => {
  if (!t) return '';
  const p = t.split(':');
  return p.length === 2 ? ('0' + p[0]).slice(-2) + ':' + ('0' + p[1]).slice(-2) : t;
};

// ==========================================
// 0. 進行コントロール用 API
// ==========================================
app.get('/api/state', async (c) => {
  try {
    const { results: timetable } = await c.env.DB.prepare(
      'SELECT * FROM timetable ORDER BY start_time ASC, id ASC'
    ).all()
    
    let state: any = null
    try {
      state = await c.env.DB.prepare('SELECT * FROM app_state WHERE id = 1').first()
    } catch (_) {}
    
    if (!state) {
      state = { current_index: -1, is_auto: 1, wait_cm: 0 }
    }
    return c.json({ state, timetable: timetable || [] })
  } catch (e: any) {
    return c.json({ state: { current_index: -1, is_auto: 1, wait_cm: 0 }, timetable: [] })
  }
})

app.post('/api/state/update', async (c) => {
  try {
    const body = await c.req.json()
    const updates: string[] = []
    const values: any[] = []
    
    if (body.current_index !== undefined) {
      updates.push('current_index = ?')
      values.push(body.current_index)
    }
    if (body.is_auto !== undefined) {
      updates.push('is_auto = ?')
      values.push(body.is_auto ? 1 : 0)
    }
    if (body.wait_cm !== undefined) {
      updates.push('wait_cm = ?')
      values.push(body.wait_cm ? 1 : 0)
    }
    
    if (updates.length > 0) {
      values.push(1)
      await c.env.DB.prepare(
        `UPDATE app_state SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...values).run()
    }
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ==========================================
// 1. テロップ用 API
// ==========================================
app.get('/api/info', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM info WHERE is_active = 1 ORDER BY id DESC'
  ).all()
  return c.json(results || [])
})

app.get('/api/info/all', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM info ORDER BY is_active DESC, id DESC'
  ).all()
  return c.json(results || [])
})

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

app.post('/api/info/update', async (c) => {
  const body = await c.req.json()
  const { id, formatted_text, tag, is_active } = body

  await c.env.DB.prepare(
    'UPDATE info SET formatted_text = ?, tag = ?, is_active = ? WHERE id = ?'
  ).bind(formatted_text, tag, is_active ? 1 : 0, id).run()

  return c.json({ success: true })
})

app.post('/api/info/delete', async (c) => {
  const body = await c.req.json()
  await c.env.DB.prepare('DELETE FROM info WHERE id = ?').bind(body.id).run()
  return c.json({ success: true })
})

// ==========================================
// 2. タイムテーブル API
// ==========================================
app.get('/api/timetable', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM timetable ORDER BY start_time ASC, id ASC'
    ).all()
    return c.json(results || [])
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/timetable', async (c) => {
  const body = await c.req.json()
  const startTime = padTimeStr(body.start_time || '')
  const endTime = padTimeStr(body.end_time || '')
  const title = body.title || ''
  const band = body.band || ''
  const type = body.type || 'song'

  if (!startTime || !endTime) {
    return c.json({ error: "開始時刻と終了時刻を指定してください" }, 400)
  }

  if (startTime >= endTime) {
    return c.json({ error: "終了時刻は開始時刻より後に設定してください" }, 400)
  }

  const { results: overlaps } = await c.env.DB.prepare(
    'SELECT title, start_time, end_time FROM timetable WHERE ? < end_time AND ? > start_time'
  ).bind(startTime, endTime).all()

  if (overlaps && overlaps.length > 0) {
    const conflict: any = overlaps[0]
    return c.json({ 
      error: `時間が重複しています（既存: ${conflict.start_time}〜${conflict.end_time} 「${conflict.title}」）` 
    }, 400)
  }

  await c.env.DB.prepare(
    'INSERT INTO timetable (start_time, end_time, title, band, type) VALUES (?, ?, ?, ?, ?)'
  ).bind(startTime, endTime, title, band, type).run()

  return c.json({ success: true })
})

app.post('/api/timetable/batch', async (c) => {
  try {
    const body = await c.req.json()
    const { items, overwrite } = body as {
      items: Array<{ start_time: string; end_time: string; title: string; band?: string; type?: string }>
      overwrite?: boolean
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return c.json({ error: "インポートするデータがありません" }, 400)
    }

    items.forEach(item => {
      item.start_time = padTimeStr(item.start_time)
      item.end_time = padTimeStr(item.end_time)
    })

    const sorted = [...items].sort((a, b) => a.start_time.localeCompare(b.start_time))
    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i]
      if (!curr.start_time || !curr.end_time || !curr.title) {
        return c.json({ error: `「${curr.title || '無題'}」の入力内容を確認してください` }, 400)
      }
      if (curr.start_time >= curr.end_time) {
        return c.json({ error: `「${curr.title}」の終了時刻が開始時刻より前または同じです` }, 400)
      }
      if (i > 0) {
        const prev = sorted[i - 1]
        if (curr.start_time < prev.end_time) {
          return c.json({
            error: `インポートデータ内で時間が重複しています（「${prev.title}」と「${curr.title}」）`
          }, 400)
        }
      }
    }

    if (!overwrite) {
      const { results: existing } = await c.env.DB.prepare('SELECT title, start_time, end_time FROM timetable').all()
      if (existing && existing.length > 0) {
        for (const item of items) {
          for (const ex of existing as any[]) {
            const exStart = padTimeStr(ex.start_time as string)
            const exEnd = padTimeStr(ex.end_time as string)
            if (item.start_time < exEnd && item.end_time > exStart) {
              return c.json({
                error: `既存の企画「${ex.title}」(${ex.start_time}〜${ex.end_time}) と重複しています`
              }, 400)
            }
          }
        }
      }
    }

    const stmts = []
    if (overwrite) {
      stmts.push(c.env.DB.prepare('DELETE FROM timetable'))
    }

    for (const item of sorted) {
      stmts.push(
        c.env.DB.prepare(
          'INSERT INTO timetable (start_time, end_time, title, band, type) VALUES (?, ?, ?, ?, ?)'
        ).bind(
          item.start_time,
          item.end_time,
          item.title,
          item.band || '',
          item.type || 'song'
        )
      )
    }

    await c.env.DB.batch(stmts)
    return c.json({ success: true, count: sorted.length })
  } catch (e: any) {
    return c.json({ error: e.message || '一括インポートに失敗しました' }, 500)
  }
})

app.post('/api/timetable/update', async (c) => {
  const body = await c.req.json()
  const id = body.id
  const start_time = padTimeStr(body.start_time)
  const end_time = padTimeStr(body.end_time)
  const title = body.title
  const band = body.band
  const type = body.type

  if (!start_time || !end_time) {
    return c.json({ error: "開始時刻と終了時刻を指定してください" }, 400)
  }

  if (start_time >= end_time) {
    return c.json({ error: "終了時刻は開始時刻より後に設定してください" }, 400)
  }

  const { results: overlaps } = await c.env.DB.prepare(
    'SELECT title, start_time, end_time FROM timetable WHERE ? < end_time AND ? > start_time AND id != ?'
  ).bind(start_time, end_time, id).all()

  if (overlaps && overlaps.length > 0) {
    const conflict: any = overlaps[0]
    return c.json({ 
      error: `時間が重複しています（既存: ${conflict.start_time}〜${conflict.end_time} 「${conflict.title}」）` 
    }, 400)
  }

  await c.env.DB.prepare(
    'UPDATE timetable SET start_time = ?, end_time = ?, title = ?, band = ?, type = ? WHERE id = ?'
  ).bind(start_time, end_time, title, band, type, id).run()

  return c.json({ success: true })
})

app.post('/api/timetable/delete', async (c) => {
  const body = await c.req.json()
  await c.env.DB.prepare('DELETE FROM timetable WHERE id = ?').bind(body.id).run()
  return c.json({ success: true })
})

app.post('/api/timetable/delete_range', async (c) => {
  const body = await c.req.json()
  const start_time = padTimeStr(body.start_time)
  const end_time = padTimeStr(body.end_time)

  if (!start_time || !end_time) {
    return c.json({ error: "時刻を指定してください" }, 400)
  }
  if (start_time >= end_time) {
    return c.json({ error: "終了時刻は開始時刻より後に設定してください" }, 400)
  }

  try {
    const { results } = await c.env.DB.prepare('SELECT id, start_time, end_time FROM timetable').all()
    if (!results || results.length === 0) return c.json({ success: true })

    const idsToDelete = results.filter((row: any) => {
      const s = padTimeStr(row.start_time)
      const e = padTimeStr(row.end_time)
      return s >= start_time && e <= end_time
    }).map((row: any) => row.id)

    if (idsToDelete.length > 0) {
      const placeholders = idsToDelete.map(() => '?').join(',')
      await c.env.DB.prepare(`DELETE FROM timetable WHERE id IN (${placeholders})`).bind(...idsToDelete).run()
    }

    return c.json({ success: true, count: idsToDelete.length })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ==========================================
// 3. 右側パネル用 API
// ==========================================
app.get('/api/sidebar', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM sidebar_items WHERE is_active = 1 ORDER BY id DESC'
    ).all()
    return c.json(results || [])
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/sidebar/all', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM sidebar_items ORDER BY is_active DESC, id DESC'
    ).all()
    return c.json(results || [])
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/sidebar', async (c) => {
  try {
    const body = await c.req.json()
    const title = body.title || ''
    const description = body.description || ''
    const imageData = body.image_data || ''
    const duration = body.duration ? Number(body.duration) : 10
    const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : 1

    await c.env.DB.prepare(
      'INSERT INTO sidebar_items (title, description, image_data, duration, is_active) VALUES (?, ?, ?, ?, ?)'
    ).bind(title, description, imageData, duration, isActive).run()

    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/sidebar/update', async (c) => {
  try {
    const body = await c.req.json()
    const { id, title, description, duration, is_active } = body

    if (title !== undefined && description !== undefined) {
      await c.env.DB.prepare(
        'UPDATE sidebar_items SET title = ?, description = ?, duration = ?, is_active = ? WHERE id = ?'
      ).bind(title, description, Number(duration || 10), is_active ? 1 : 0, id).run()
    } else if (is_active !== undefined) {
      await c.env.DB.prepare(
        'UPDATE sidebar_items SET is_active = ? WHERE id = ?'
      ).bind(is_active ? 1 : 0, id).run()
    }

    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/sidebar/delete', async (c) => {
  try {
    const body = await c.req.json()
    await c.env.DB.prepare('DELETE FROM sidebar_items WHERE id = ?').bind(body.id).run()
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ==========================================
// 4. AI整形 API
// ==========================================
app.post('/api/format', async (c) => {
  try {
    const body = await c.req.json()
    const rawText = body.text
    if (!rawText) return c.json({ error: "textがありません" }, 400)

    const apiKey = c.env.GEMINI_API_KEY
    if (!apiKey) return c.json({ error: "GEMINI_API_KEYが設定されていません" }, 500)

    const prompt = "あなたは文化祭（茨香祭）のデジタルサイネージ・テロップ作成アシスタントです。\n" +
      "以下の連絡文を、画面下部に流すための簡潔で分かりやすい「テロップ用テキスト」に整形してください。\n\n" +
      "【ルール】\n" +
      "- 25文字〜40文字程度の日本語1行で出力すること。\n" +
      "- 先頭に必ず適切な角括弧タグを付けること（例: 【お知らせ】、【完売情報】、【落とし物】、【イベント】など）。\n" +
      "- 絵文字や挨拶文は削除すること。\n" +
      "- 整形後のテキストのみを出力し、解説や前置きは一切出力しないこと。\n\n" +
      "【連絡文】\n" + rawText

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 }
      })
    })

    const data: any = await response.json()
    const formattedText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    return c.json({ formatted_text: formattedText })
  } catch (e: any) {
    return c.json({ error: "サーバーエラー", message: e.message }, 500)
  }
})

// ==========================================
// 5. 管理画面 HTML
// ==========================================
const HTML_ADMIN_PAGE = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>茨香祭 総合管理コンソール</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 16px; }
    .container { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    
    .tab-nav { display: flex; gap: 6px; border-bottom: 2px solid #334155; padding-bottom: 8px; overflow-x: auto; white-space: nowrap; }
    .tab-btn { flex: 1; padding: 10px 8px; font-size: 14px; font-weight: bold; background: #1e293b; color: #94a3b8; border: none; border-radius: 8px; cursor: pointer; transition: 0.2s; min-width: 110px; text-align: center; }
    .tab-btn.active { background: #0284c7; color: white; }

    .card { background: #1e293b; padding: 16px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
    h2, h3 { margin-top: 0; margin-bottom: 12px; font-size: 18px; }
    textarea, input[type="text"], input[type="time"], input[type="number"], select {
      width: 100%; padding: 10px; background: #0f172a; border: 1px solid #334155; color: #f8fafc; border-radius: 6px; font-size: 15px;
    }
    textarea { height: 75px; resize: vertical; }
    .form-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
    .form-row { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; align-items: center; }

    .btn { background: #2563eb; color: white; border: none; padding: 10px 16px; border-radius: 6px; cursor: pointer; font-weight: bold; transition: 0.2s; font-size: 14px; }
    .btn:hover { background: #1d4ed8; }
    .btn-secondary { background: #475569; padding: 6px 12px; font-size: 13px; }
    .btn-secondary:hover { background: #64748b; }
    .btn-danger { background: #dc2626; padding: 6px 12px; font-size: 12px; }
    .btn-save { background: #059669; padding: 6px 12px; font-size: 12px; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .list-container { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; }
    .item-card { background: #1e293b; border-radius: 8px; padding: 14px; border-left: 5px solid #64748b; }
    .item-active { border-left-color: #38bdf8; background: #1a2744; }
    .item-emergency { border-left-color: #ef4444 !important; }
    .item-song { border-left-color: #10b981; }
    .item-break { border-left-color: #f59e0b; }
    .item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px; }

    .thumb-preview { width: 100%; max-height: 160px; object-fit: contain; background: #000; border-radius: 6px; margin: 8px 0; }
    .upload-box { border: 2px dashed #475569; padding: 16px; text-align: center; border-radius: 8px; cursor: pointer; background: #0f172a; margin-bottom: 12px; }

    #toast { position: fixed; bottom: 24px; right: 24px; background: #059669; color: white; padding: 12px 24px; border-radius: 8px; font-weight: bold; box-shadow: 0 8px 16px rgba(0,0,0,0.4); transform: translateY(100px); opacity: 0; transition: all 0.3s ease; z-index: 2000; }
    #toast.show { transform: translateY(0); opacity: 1; }

    .modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75); display: none; align-items: center; justify-content: center; z-index: 1500; padding: 16px; }
    .modal-overlay.active { display: flex; }
    .modal-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; width: 100%; max-width: 820px; max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 20px 40px rgba(0,0,0,0.6); overflow: hidden; }
    .modal-header { padding: 16px 20px; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; }
    .modal-body { padding: 20px; overflow-y: auto; flex: 1; }
    .modal-footer { padding: 14px 20px; border-top: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; background: #162032; }
    .guide-box { background: rgba(56, 189, 248, 0.1); border-left: 4px solid #38bdf8; padding: 10px 14px; border-radius: 4px; font-size: 13px; color: #bae6fd; margin-bottom: 14px; line-height: 1.5; }
    .import-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    .import-table th { background: #0f172a; text-align: left; padding: 8px 10px; color: #94a3b8; border: 1px solid #334155; }
    .import-table td { padding: 8px 10px; border: 1px solid #334155; }
    .import-table tr.has-error { background: rgba(239, 68, 68, 0.15); }
    .import-table tr.has-error td { border-color: #ef4444; }

    .control-slot { padding: 14px; border-radius: 10px; margin-bottom: 12px; }
    .control-slot-prev { background: #0f172a; border-left: 4px solid #64748b; opacity: 0.75; }
    .control-slot-current { background: #0284c7; border-left: 6px solid #38bdf8; padding: 16px; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.4); }
    .control-slot-next { background: #0f172a; border-left: 4px solid #3b82f6; }
    .c-title { font-size: 18px; font-weight: bold; margin: 4px 0; word-break: break-all; }
    .c-sub { font-size: 13px; color: #e2e8f0; word-break: break-all; }
    .setting-box { background: #0f172a; border: 1px solid #334155; padding: 14px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 10px; }
    
    .switch-container { display: flex; align-items: center; gap: 10px; }
    .switch { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #475569; transition: .3s; border-radius: 24px; }
    .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%; }
    input:checked + .slider { background-color: #10b981; }
    input:checked + .slider:before { transform: translateX(20px); }

    /* スマホ対応（レスポンシブリスト） */
    .ctrl-item-card { background: #0f172a; padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 4px solid #64748b; font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
    .ctrl-item-card.active { background: #0369a1; border-left-color: #38bdf8; }
    .ctrl-item-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ctrl-time { font-weight: bold; color: #38bdf8; font-size: 13px; }
    .ctrl-title { font-weight: bold; font-size: 15px; color: #fff; word-break: break-all; }
    .ctrl-band { color: #94a3b8; font-size: 13px; word-break: break-all; }

    @media (max-width: 480px) {
      body { padding: 8px; }
      .card { padding: 12px; }
      .tab-btn { font-size: 12px; padding: 8px 4px; min-width: 75px; }
      .btn { padding: 14px; font-size: 16px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="tab-nav">
      <button class="tab-btn active" id="tabBtnControl" onclick="switchTab('control')">🎮 進行</button>
      <button class="tab-btn" id="tabBtnTicker" onclick="switchTab('ticker')">📢 テロップ</button>
      <button class="tab-btn" id="tabBtnTimetable" onclick="switchTab('timetable')">📅 タイムテ</button>
      <button class="tab-btn" id="tabBtnSidebar" onclick="switchTab('sidebar')">🖼️ パネル</button>
    </div>

    <!-- 進行コントロールタブ -->
    <div id="tabContentControl">
      <div class="card">
        <h2 style="margin-bottom: 16px;">🎮 OBSステージ進行状態</h2>
        
        <div class="setting-box">
          <div>
            <div style="font-weight:bold; font-size:14px; margin-bottom:2px;">🕒 自動進行モード</div>
            <div style="font-size:11px; color:#94a3b8;">時間に合わせてOBSを自動切り替え</div>
          </div>
          <div class="switch-container">
            <span id="labelAutoMode" style="font-size:12px; font-weight:bold;">ON</span>
            <label class="switch"><input type="checkbox" id="chkAutoMode" onchange="updateStateSetting()"><span class="slider"></span></label>
          </div>
        </div>

        <div class="setting-box">
          <div>
            <div style="font-weight:bold; font-size:14px; margin-bottom:2px;">⏳ CM完走待ち機能</div>
            <div style="font-size:11px; color:#94a3b8;">CM動画の終了を待って切り替え</div>
          </div>
          <div class="switch-container">
            <span id="labelWaitCm" style="font-size:12px; font-weight:bold;">ON</span>
            <label class="switch"><input type="checkbox" id="chkWaitCm" onchange="updateStateSetting()"><span class="slider"></span></label>
          </div>
        </div>

        <div class="control-slot control-slot-prev">
          <div style="font-size:11px; color:#94a3b8; font-weight:bold;">◀ 1つ前の企画</div>
          <div id="ctrl-prev-title" class="c-title">なし</div>
        </div>
        <div class="control-slot control-slot-current">
          <div style="font-size:11px; color:#e0f2fe; font-weight:bold;">● 現在の送出状態</div>
          <div id="ctrl-curr-title" class="c-title">待機中</div>
          <div id="ctrl-curr-sub" class="c-sub"></div>
        </div>
        <div class="control-slot control-slot-next">
          <div style="font-size:11px; color:#94a3b8; font-weight:bold;">▶ 次の企画</div>
          <div id="ctrl-next-title" class="c-title">なし</div>
        </div>

        <div style="display:flex; gap:10px; margin-top:14px;">
          <button class="btn" style="flex:1; background:#475569; padding:14px; font-size:15px;" onclick="manualChange(-1)">◀ 前へ</button>
          <button class="btn" style="flex:2; padding:14px; font-size:15px;" onclick="manualChange(1)">次へ ▶</button>
        </div>
      </div>

      <div class="card" style="margin-top:16px;">
        <h3>📋 演目進行リスト</h3>
        <div id="ctrl-timetable-list" class="list-container" style="max-height: 320px; overflow-y:auto; gap:6px;"></div>
      </div>
    </div>

    <!-- タブ1: テロップ管理 -->
    <div id="tabContentTicker" style="display:none;">
      <div class="card">
        <h2>📢 テロップ新規登録</h2>
        <textarea id="rawText" placeholder="サークルや本部からの連絡文を入力..."></textarea>
        <div class="form-row">
          <label style="flex:1; min-width:140px;">タグ:
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
          <label style="display:flex; align-items:center; gap:6px; font-size:14px;">
            <input type="checkbox" id="isActiveCheck" checked> すぐに表示
          </label>
          <button class="btn" id="submitBtn" onclick="submitTicker()" style="width:100%;">送信して追加</button>
        </div>
        <div id="statusMsg" style="margin-top:10px; font-weight:bold; font-size:14px;"></div>
      </div>

      <div class="card" style="margin-top:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3>📋 登録テロップ一覧</h3>
          <button class="btn" style="padding:6px 12px; font-size:12px; background:#334155;" onclick="loadTickerList()">↻ 更新</button>
        </div>
        <div id="itemList" class="list-container">読み込み中...</div>
      </div>
    </div>

    <!-- タブ2: タイムテーブル管理 -->
    <div id="tabContentTimetable" style="display:none;">
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
          <h2 style="margin:0;">📅 タイムスケジュール</h2>
          <div style="display:flex; gap:6px;">
            <button class="btn btn-secondary" style="background:#b91c1c; padding:6px 10px;" onclick="openDeleteRangeModal()">🗑️ 範囲削除</button>
            <button class="btn btn-secondary" style="padding:6px 10px;" onclick="openImportModal()">📋 一括インポート</button>
          </div>
        </div>
        <div class="form-row">
          <div style="flex:1; min-width:110px;">
            <label style="font-size:12px; color:#94a3b8;">開始時刻</label>
            <input type="time" id="ttStart" value="10:00">
          </div>
          <div style="flex:1; min-width:110px;">
            <label style="font-size:12px; color:#94a3b8;">終了時刻</label>
            <input type="time" id="ttEnd" value="10:30">
          </div>
          <div style="flex:1; min-width:130px;">
            <label style="font-size:12px; color:#94a3b8;">種別</label>
            <select id="ttType">
              <option value="song">ステージ（演奏・企画）</option>
              <option value="break">幕間（準備・CM放映）</option>
            </select>
          </div>
        </div>
        <div class="form-row" style="margin-top:12px;">
          <div style="flex:2; min-width:160px;">
            <label style="font-size:12px; color:#94a3b8;">企画</label>
            <input type="text" id="ttTitle" placeholder="例: 吹奏楽部オープニング演奏">
          </div>
          <div style="flex:1; min-width:130px;">
            <label style="font-size:12px; color:#94a3b8;">詳細</label>
            <input type="text" id="ttBand" placeholder="例: 吹奏楽部">
          </div>
        </div>
        <button class="btn" style="margin-top:14px; width:100%;" onclick="submitTimetable()">タイムテーブルに追加</button>
      </div>

      <div class="card" style="margin-top:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3>📋 本日のタイムテーブル一覧</h3>
          <button class="btn" style="padding:6px 12px; font-size:12px; background:#334155;" onclick="loadTimetableList()">↻ 更新</button>
        </div>
        <div id="timetableList" class="list-container">読み込み中...</div>
      </div>
    </div>

    <!-- タブ3: 右側パネル管理 -->
    <div id="tabContentSidebar" style="display:none;">
      <div class="card">
        <h2>🖼️ 右側パネル新規登録</h2>
        <div class="upload-box" onclick="document.getElementById('sideFileInput').click()">
          <div id="uploadPrompt">📷 タップして画像を選択（任意）</div>
          <img id="sidePreviewImg" style="display:none; max-height:160px; margin:0 auto; border-radius:6px;" />
          <input type="file" id="sideFileInput" accept="image/*" style="display:none;" onchange="handleImageSelect(event)">
        </div>
        <div class="form-group">
          <label>タイトル:</label>
          <input type="text" id="sideTitleInput" placeholder="例: 公式Tシャツ販売中！">
        </div>
        <div class="form-group">
          <label>説明・本文:</label>
          <textarea id="sideDescInput" placeholder="例: 本部テントにて限定販売中！"></textarea>
        </div>
        <div class="form-row">
          <label style="font-size:14px;">表示時間: <input type="number" id="sideDurationInput" value="10" min="3" max="60" style="width:60px;"> 秒</label>
          <label style="margin-left:auto; font-size:14px;"><input type="checkbox" id="sideActiveCheck" checked> すぐに表示</label>
          <button class="btn" style="width:100%; margin-top:8px;" onclick="submitSidebar()">追加する</button>
        </div>
      </div>

      <div class="card" style="margin-top:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3>📋 右側パネル一覧</h3>
          <button class="btn" style="padding:6px 12px; font-size:12px; background:#334155;" onclick="loadSidebarList()">↻ 更新</button>
        </div>
        <div id="sideList" class="list-container">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- 範囲削除モーダル -->
  <div class="modal-overlay" id="deleteRangeModal">
    <div class="modal-card" style="max-width: 450px;">
      <div class="modal-header">
        <h3 style="margin:0;">🗑️ 指定範囲のタイムテーブル削除</h3>
        <button style="background:transparent; border:none; color:#94a3b8; font-size:24px; cursor:pointer;" onclick="closeDeleteRangeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="guide-box" style="background: rgba(239, 68, 68, 0.1); border-left-color: #ef4444; color: #fca5a5;">
          指定した時間帯（開始〜終了）に<strong>完全に収まる</strong>演目を一括で削除します。
        </div>
        <div class="form-row">
          <div style="flex:1;">
            <label style="font-size:12px; color:#94a3b8;">開始時刻</label>
            <input type="time" id="delStartTime" value="00:00">
          </div>
          <div style="flex:1;">
            <label style="font-size:12px; color:#94a3b8;">終了時刻</label>
            <input type="time" id="delEndTime" value="23:59">
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeDeleteRangeModal()">キャンセル</button>
        <button class="btn btn-danger" onclick="executeDeleteRange()">一括削除する</button>
      </div>
    </div>
  </div>

  <!-- 一括インポートモーダル -->
  <div class="modal-overlay" id="importModal">
    <div class="modal-card">
      <div class="modal-header">
        <h3 style="margin:0;">📋 タイムテーブルの一括インポート</h3>
        <button style="background:transparent; border:none; color:#94a3b8; font-size:24px; cursor:pointer;" onclick="closeImportModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="guide-box">
          💡 <strong>Excel / Googleスプレッドシートからそのままコピー＆貼り付けできます</strong><br>
          列の順番: <code>[開始時刻]   [終了時刻]   [企画]   [詳細]   [種別]</code><br>
          ※詳細・種別（ステージ/幕間）は省略可能です。
        </div>

        <div class="form-group">
          <label style="font-size:12px; color:#94a3b8;">貼り付けエリア</label>
          <textarea id="importRawText" style="height:120px;" oninput="parseImportText()" placeholder="10:00	10:30	吹奏楽部オープニング	吹奏楽部	ステージ"></textarea>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:14px;">
          <span style="font-size:13px; font-weight:bold;" id="importStats">解析結果: 0 件</span>
          <label style="display:flex; align-items:center; gap:6px; font-size:13px; cursor:pointer;">
            <input type="checkbox" id="importOverwrite"> 既存のタイムテーブルを全消去して上書きする
          </label>
        </div>

        <table class="import-table">
          <thead>
            <tr>
              <th style="width:75px;">開始</th>
              <th style="width:75px;">終了</th>
              <th>企画</th>
              <th>詳細</th>
              <th style="width:70px;">種別</th>
              <th style="width:110px;">状態</th>
            </tr>
          </thead>
          <tbody id="importPreviewBody">
            <tr><td colspan="6" style="text-align:center; color:#64748b; padding:16px;">ここにリアルタイムプレビューが表示されます</td></tr>
          </tbody>
        </table>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeImportModal()">キャンセル</button>
        <button class="btn" id="btnExecuteImport" onclick="executeBatchImport()" disabled>インポートする</button>
      </div>
    </div>
  </div>

  <div id="toast">✅ 完了しました！</div>

  <script>
    var API_BASE = window.location.origin;
    var TAG_LIST = ["グッズ案内", "企画宣伝", "迷子落とし物", "その他", "その他（そのまま）", "緊急", "緊急（そのまま）"];
    var parsedBatchItems = [];
    var selectedImageData = '';
    
    var gState = { current_index: -1, is_auto: 1, wait_cm: 0 };
    var gTimetable = [];

    function padTime(t) {
      if (!t) return '';
      var p = t.split(':');
      if (p.length === 2) {
        return ('0' + p[0]).slice(-2) + ':' + ('0' + p[1]).slice(-2);
      }
      return t;
    }

    function showToast(msg, isError) {
      var toast = document.getElementById('toast');
      if (!toast) return;
      toast.innerText = msg;
      toast.style.background = isError ? '#dc2626' : '#059669';
      toast.classList.add('show');
      setTimeout(function() { toast.classList.remove('show'); }, 2200);
    }

    function switchTab(tab) {
      var tabs = ['ticker', 'timetable', 'sidebar', 'control'];
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        var cap = t.charAt(0).toUpperCase() + t.slice(1);
        var contentEl = document.getElementById('tabContent' + cap);
        if (contentEl) {
          contentEl.style.display = (t === tab) ? 'block' : 'none';
        }
        var btnEl = document.getElementById('tabBtn' + cap);
        if (btnEl) {
          btnEl.className = 'tab-btn' + (t === tab ? ' active' : '');
        }
      }

      if (tab === 'ticker') loadTickerList();
      if (tab === 'timetable') loadTimetableList();
      if (tab === 'sidebar') loadSidebarList();
      if (tab === 'control') fetchState();
    }

    async function fetchState() {
      try {
        var res = await fetch(API_BASE + '/api/state');
        var data = await res.json();
        gState = data.state || { current_index: -1, is_auto: 1, wait_cm: 0 };
        gTimetable = data.timetable || [];
        
        var chkAuto = document.getElementById('chkAutoMode');
        if (chkAuto) chkAuto.checked = !!gState.is_auto;
        var lblAuto = document.getElementById('labelAutoMode');
        if (lblAuto) {
          lblAuto.innerText = gState.is_auto ? "ON" : "OFF";
          lblAuto.style.color = gState.is_auto ? "#10b981" : "#94a3b8";
        }

        var chkWait = document.getElementById('chkWaitCm');
        if (chkWait) chkWait.checked = !!gState.wait_cm;
        var lblWait = document.getElementById('labelWaitCm');
        if (lblWait) {
          lblWait.innerText = gState.wait_cm ? "ON" : "OFF";
          lblWait.style.color = gState.wait_cm ? "#10b981" : "#94a3b8";
        }

        renderControlUI();
      } catch (e) { console.error("State Fetch Error", e); }
    }

    async function updateStateSetting() {
      var chkAuto = document.getElementById('chkAutoMode');
      var chkWait = document.getElementById('chkWaitCm');
      var isAuto = chkAuto ? chkAuto.checked : true;
      var waitCm = chkWait ? chkWait.checked : false;
      await fetch(API_BASE + '/api/state/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_auto: isAuto, wait_cm: waitCm })
      });
      fetchState();
    }

    async function manualChange(dir) {
      var newIdx = gState.current_index + dir;
      if (newIdx < -1) newIdx = -1;
      if (gTimetable && newIdx >= gTimetable.length) newIdx = gTimetable.length - 1;
      
      await fetch(API_BASE + '/api/state/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_index: newIdx, is_auto: false })
      });
      showToast(dir > 0 ? "次へ進めました" : "前へ戻しました", false);
      fetchState();
    }

    function renderControlUI() {
      if (!gState) return;
      var idx = gState.current_index;
      
      var elPrev = document.getElementById('ctrl-prev-title');
      if (elPrev) {
        if (idx > 0 && gTimetable && gTimetable[idx - 1]) {
          var pItem = gTimetable[idx - 1];
          elPrev.innerText = padTime(pItem.start_time) + "〜" + padTime(pItem.end_time) + " | " + (pItem.title || '');
        } else {
          elPrev.innerText = "なし";
        }
      }

      var elCurr = document.getElementById('ctrl-curr-title');
      var elSub = document.getElementById('ctrl-curr-sub');
      if (elCurr) {
        if (idx >= 0 && gTimetable && gTimetable[idx]) {
          var item = gTimetable[idx];
          var typeLabel = (item.type === 'song' || item.type === 'ステージ（演奏・企画）') ? '【ステージ】' : '【幕間CM】';
          elCurr.innerText = typeLabel + " " + (item.title || '');
          if (elSub) elSub.innerText = (padTime(item.start_time) + " 〜 " + padTime(item.end_time)) + (item.band ? " | 詳細: " + item.band : "");
        } else {
          elCurr.innerText = "待機中・CM映像表示中";
          if (elSub) elSub.innerText = "時間になると自動で開始されます";
        }
      }

      var elNext = document.getElementById('ctrl-next-title');
      if (elNext) {
        if (gTimetable && idx + 1 < gTimetable.length && gTimetable[idx + 1]) {
          var nItem = gTimetable[idx + 1];
          elNext.innerText = padTime(nItem.start_time) + "〜" + padTime(nItem.end_time) + " | " + (nItem.title || '');
        } else {
          elNext.innerText = "なし";
        }
      }

      // ★演目進行リストのスマホ対応＆「種別 / 企画 / 詳細」表示
      var listEl = document.getElementById('ctrl-timetable-list');
      if (listEl && gTimetable) {
        listEl.innerHTML = '';
        gTimetable.forEach(function(item, i) {
          var card = document.createElement('div');
          card.className = 'ctrl-item-card ' + (i === idx ? 'active' : '');
          
          var isSong = (item.type === 'song' || item.type === 'ステージ（演奏・企画）');
          var typeBadge = isSong ? '<span class="tag tag-song">ステージ</span>' : '<span class="tag tag-break">幕間CM</span>';
          var timeStr = padTime(item.start_time) + ' 〜 ' + padTime(item.end_time);

          card.innerHTML = 
            '<div class="ctrl-item-row">' +
              '<span class="ctrl-time">🕒 ' + timeStr + '</span>' +
              typeBadge +
            '</div>' +
            '<div class="ctrl-title">' + escapeHtml(item.title || '') + '</div>' +
            (item.band ? '<div class="ctrl-band">詳細: ' + escapeHtml(item.band) + '</div>' : '');

          listEl.appendChild(card);
        });
      }
    }

    setInterval(function() {
      var ctrlBox = document.getElementById('tabContentControl');
      if (ctrlBox && ctrlBox.style.display !== 'none') {
        fetchState();
      }
    }, 2000);

    // --- テロップ管理 ---
    async function submitTicker() {
      var rawText = document.getElementById('rawText').value.trim();
      var tag = document.getElementById('tagSelect').value;
      var isActive = document.getElementById('isActiveCheck').checked;
      var status = document.getElementById('statusMsg');
      var submitBtn = document.getElementById('submitBtn');

      if (!rawText) return alert("文章を入力してください");
      submitBtn.disabled = true;
      status.style.color = "#38bdf8";
      status.innerText = "処理中...";

      var formattedText = rawText;
      if (!tag.includes("（そのまま）")) {
        try {
          status.innerText = "AIがテロップを成形中...";
          var aiRes = await fetch(API_BASE + '/api/format', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: rawText })
          });
          var aiData = await aiRes.json();
          if (aiData.formatted_text) formattedText = aiData.formatted_text;
        } catch (e) {}
      }

      status.innerText = "データベースに保存中...";
      try {
        var res = await fetch(API_BASE + '/api/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw_text: rawText, formatted_text: formattedText, tag: tag, is_active: isActive })
        });
        if (res.ok) {
          status.style.color = "#4ade80";
          status.innerText = "追加完了: " + formattedText;
          document.getElementById('rawText').value = '';
          showToast("📢 テロップを登録しました！", false);
          loadTickerList();
        }
      } finally {
        submitBtn.disabled = false;
      }
    }

    async function loadTickerList() {
      var listEl = document.getElementById('itemList');
      if (!listEl) return;
      try {
        var res = await fetch(API_BASE + '/api/info/all');
        var items = await res.json();
        if (!items || !Array.isArray(items) || items.length === 0) {
          listEl.innerHTML = '<div style="text-align:center; color:#64748b;">登録されたテロップはありません</div>';
          return;
        }
        listEl.innerHTML = '';
        items.forEach(function(item) {
          var isEmergency = (item.tag || '').indexOf('緊急') !== -1;
          var card = document.createElement('div');
          card.className = 'item-card ' + (item.is_active ? 'item-active' : 'item-inactive') + (isEmergency ? ' item-emergency' : '');

          var tagOptions = '';
          TAG_LIST.forEach(function(t) {
            tagOptions += '<option value="' + t + '"' + ((t === item.tag) ? ' selected' : '') + '>' + t + '</option>';
          });

          card.innerHTML = 
            '<div class="item-header">' +
              '<label style="display:flex; align-items:center; gap:8px; cursor:pointer;">' +
                '<input type="checkbox" id="check-' + item.id + '"' + (item.is_active ? ' checked' : '') + ' onchange="updateTicker(' + item.id + ')">' +
                '<strong style="color:' + (item.is_active ? '#38bdf8' : '#94a3b8') + '">' + (item.is_active ? '● 表示中' : '✕ 非表示') + '</strong>' +
              '</label>' +
              '<select id="tag-' + item.id + '" onchange="updateTicker(' + item.id + ')">' + tagOptions + '</select>' +
            '</div>' +
            '<div style="font-size:12px; color:#94a3b8; margin-bottom:6px;">【入力原文】' + escapeHtml(item.raw_text) + '</div>' +
            '<input type="text" id="text-' + item.id + '" value="' + escapeHtml(item.formatted_text || item.raw_text) + '">' +
            '<div style="display:flex; justify-content:space-between; margin-top:10px;">' +
              '<button class="btn btn-save" onclick="updateTicker(' + item.id + ', this)">変更を保存</button>' +
              '<button class="btn btn-danger" onclick="deleteTicker(' + item.id + ')">削除</button>' +
            '</div>';
          listEl.appendChild(card);
        });
      } catch (e) {}
    }

    async function updateTicker(id, btn) {
      if (btn) { btn.disabled = true; btn.innerText = "保存中..."; }
      var is_active = document.getElementById('check-' + id).checked;
      var tag = document.getElementById('tag-' + id).value;
      var formatted_text = document.getElementById('text-' + id).value;
      await fetch(API_BASE + '/api/info/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, is_active: is_active, tag: tag, formatted_text: formatted_text })
      });
      showToast("✅ 変更を保存しました！", false);
      loadTickerList();
    }

    async function deleteTicker(id) {
      if (!confirm("本当に削除しますか？")) return;
      await fetch(API_BASE + '/api/info/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id })
      });
      showToast("🗑️ 削除しました", false);
      loadTickerList();
    }

    // --- タイムテーブル処理 ---
    async function submitTimetable() {
      var startTime = padTime(document.getElementById('ttStart').value);
      var endTime = padTime(document.getElementById('ttEnd').value);
      var title = document.getElementById('ttTitle').value.trim();
      var band = document.getElementById('ttBand').value.trim();
      var type = document.getElementById('ttType').value;

      if (!title) return alert("企画名を入力してください");

      try {
        var res = await fetch(API_BASE + '/api/timetable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start_time: startTime, end_time: endTime, title: title, band: band, type: type })
        });
        var data = await res.json();
        if (res.ok) {
          showToast("📅 タイムスケジュールに追加しました！", false);
          document.getElementById('ttTitle').value = '';
          document.getElementById('ttBand').value = '';
          loadTimetableList();
        } else {
          showToast("❌ " + (data.error || "追加失敗"), true);
        }
      } catch (err) {
        showToast("❌ 通信エラーが発生しました", true);
      }
    }

    async function loadTimetableList() {
      var listEl = document.getElementById('timetableList');
      if (!listEl) return;
      try {
        var res = await fetch(API_BASE + '/api/timetable');
        var items = await res.json();
        if (!items || !Array.isArray(items) || items.length === 0) {
          listEl.innerHTML = '<div style="text-align:center; color:#64748b;">登録された演目はありません</div>';
          return;
        }

        listEl.innerHTML = '';
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var card = document.createElement('div');
          card.className = 'item-card ' + ((item.type === 'song' || item.type === 'ステージ（演奏・企画）') ? 'item-song' : 'item-break');
          
          var safeStartTime = padTime(item.start_time);
          var safeEndTime = padTime(item.end_time);

          card.innerHTML = 
            '<div class="item-header">' +
              '<div style="display:flex; gap:8px; align-items:center;">' +
                '<input type="time" id="tt-s-' + item.id + '" value="' + safeStartTime + '" style="width:110px;">' +
                '<span>〜</span>' +
                '<input type="time" id="tt-e-' + item.id + '" value="' + safeEndTime + '" style="width:110px;">' +
                '<select id="tt-t-' + item.id + '" style="width:120px;">' +
                  '<option value="song"' + ((item.type === 'song' || item.type === 'ステージ（演奏・企画）') ? ' selected' : '') + '>ステージ</option>' +
                  '<option value="break"' + ((item.type === 'break' || item.type === '幕間（準備・CM放映）') ? ' selected' : '') + '>幕間CM</option>' +
                '</select>' +
              '</div>' +
            '</div>' +
            '<div style="display:flex; gap:8px; margin-top:8px;">' +
              '<input type="text" id="tt-title-' + item.id + '" value="' + escapeHtml(item.title) + '" placeholder="企画" style="flex:2;">' +
              '<input type="text" id="tt-band-' + item.id + '" value="' + escapeHtml(item.band || '') + '" placeholder="詳細" style="flex:1;">' +
            '</div>' +
            '<div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">' +
              '<button class="btn btn-save" onclick="updateTimetable(' + item.id + ', this)">変更保存</button>' +
              '<button class="btn btn-danger" onclick="deleteTimetable(' + item.id + ')">削除</button>' +
            '</div>';
          listEl.appendChild(card);
        }
      } catch (e) {
        listEl.innerHTML = '<div style="color:#f87171;">取得失敗</div>';
      }
    }

    async function updateTimetable(id, btn) {
      if (btn) { btn.disabled = true; btn.innerText = "保存中..."; }
      var start_time = padTime(document.getElementById('tt-s-' + id).value);
      var end_time = padTime(document.getElementById('tt-e-' + id).value);
      var type = document.getElementById('tt-t-' + id).value;
      var title = document.getElementById('tt-title-' + id).value;
      var band = document.getElementById('tt-band-' + id).value;

      try {
        var res = await fetch(API_BASE + '/api/timetable/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, start_time: start_time, end_time: end_time, type: type, title: title, band: band })
        });
        var data = await res.json();
        if (res.ok) {
          showToast("✅ タイムテーブルを更新しました！", false);
          loadTimetableList();
        } else {
          showToast("❌ " + (data.error || "更新失敗"), true);
          if (btn) { btn.disabled = false; btn.innerText = "変更保存"; }
        }
      } catch (e) {
        showToast("❌ 通信エラーが発生しました", true);
        if (btn) { btn.disabled = false; btn.innerText = "変更保存"; }
      }
    }

    async function deleteTimetable(id) {
      if (!confirm("この演目を削除しますか？")) return;
      await fetch(API_BASE + '/api/timetable/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id })
      });
      showToast("🗑️ 削除しました", false);
      loadTimetableList();
    }

    function openDeleteRangeModal() {
      document.getElementById('deleteRangeModal').classList.add('active');
    }

    function closeDeleteRangeModal() {
      document.getElementById('deleteRangeModal').classList.remove('active');
    }

    async function executeDeleteRange() {
      var start = padTime(document.getElementById('delStartTime').value);
      var end = padTime(document.getElementById('delEndTime').value);
      
      if (!start || !end) return alert("時刻を指定してください");
      if (start >= end) return alert("終了時刻を開始時刻より後にしてください");

      if (!confirm("【確認】" + start + " 〜 " + end + " の範囲に完全に収まる演目をすべて削除します。\\nよろしいですか？")) return;

      try {
        var res = await fetch(API_BASE + '/api/timetable/delete_range', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start_time: start, end_time: end })
        });
        var data = await res.json();
        if (res.ok) {
          showToast("🗑️ 範囲内の演目をすべて削除しました！", false);
          closeDeleteRangeModal();
          loadTimetableList();
        } else {
          showToast("❌ " + (data.error || "削除失敗"), true);
        }
      } catch (e) {
        showToast("❌ 通信エラーが発生しました", true);
      }
    }

    function openImportModal() {
      document.getElementById('importModal').classList.add('active');
      document.getElementById('importRawText').focus();
    }

    function closeImportModal() {
      document.getElementById('importModal').classList.remove('active');
    }

    function parseImportText() {
      var text = document.getElementById('importRawText').value;
      var tbody = document.getElementById('importPreviewBody');
      var statsEl = document.getElementById('importStats');
      var btnExecute = document.getElementById('btnExecuteImport');

      parsedBatchItems = [];

      if (!text || !text.trim()) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b; padding:16px;">ここにリアルタイムプレビューが表示されます</td></tr>';
        statsEl.innerText = '解析結果: 0 件';
        btnExecute.disabled = true;
        btnExecute.innerText = 'インポートする';
        return;
      }

      var rawLines = text.split('\\n');
      var parsed = [];

      for (var i = 0; i < rawLines.length; i++) {
        var line = rawLines[i].trim();
        if (!line) continue;

        var cols = (line.indexOf('\\t') !== -1) ? line.split('\\t') : line.split(',');
        var startTime = padTime((cols[0] || '').trim());
        var endTime = padTime((cols[1] || '').trim());
        var title = (cols[2] || '').trim();
        var band = (cols[3] || '').trim();
        var typeRaw = (cols[4] || '').trim();
        var type = (typeRaw.indexOf('幕間') !== -1 || typeRaw.indexOf('break') !== -1 || typeRaw.indexOf('CM') !== -1) ? 'break' : 'song';

        var error = '';
        var timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

        if (!startTime || !timeRegex.test(startTime)) {
          error = '開始時刻が不正 (HH:MM)';
        } else if (!endTime || !timeRegex.test(endTime)) {
          error = '終了時刻が不正 (HH:MM)';
        } else if (startTime >= endTime) {
          error = '終了が開始より前';
        } else if (!title) {
          error = '企画名が空欄';
        }

        parsed.push({ idx: parsed.length + 1, start_time: startTime, end_time: endTime, title: title, band: band, type: type, error: error });
      }

      for (var aIdx = 0; aIdx < parsed.length; aIdx++) {
        for (var bIdx = aIdx + 1; bIdx < parsed.length; bIdx++) {
          var a = parsed[aIdx];
          var b = parsed[bIdx];
          if (!a.error && !b.error) {
            if (a.start_time < b.end_time && a.end_time > b.start_time) {
              a.error = '行' + b.idx + 'と時間重複';
              b.error = '行' + a.idx + 'と時間重複';
            }
          }
        }
      }

      var errorCount = 0;
      var rowsHtml = '';
      for (var k = 0; k < parsed.length; k++) {
        var p = parsed[k];
        if (p.error) errorCount++;
        rowsHtml += '<tr class="' + (p.error ? 'has-error' : '') + '">' +
          '<td>' + escapeHtml(p.start_time || '-') + '</td>' +
          '<td>' + escapeHtml(p.end_time || '-') + '</td>' +
          '<td><strong>' + escapeHtml(p.title || '-') + '</strong></td>' +
          '<td>' + escapeHtml(p.band || '-') + '</td>' +
          '<td>' + (p.type === 'song' ? 'ステージ' : '幕間') + '</td>' +
          '<td>' + (p.error ? '<span style="color:#f87171; font-weight:bold;">❌ ' + p.error + '</span>' : '<span style="color:#4ade80;">✅ OK</span>') + '</td>' +
        '</tr>';
      }
      tbody.innerHTML = rowsHtml;

      statsEl.innerHTML = '解析結果: <strong>' + parsed.length + '</strong> 件 ' + (errorCount > 0 ? '<span style="color:#f87171; margin-left:8px;">(エラー: ' + errorCount + '件)</span>' : '<span style="color:#4ade80; margin-left:8px;">(全件正常)</span>');

      if (errorCount > 0 || parsed.length === 0) {
        btnExecute.disabled = true;
        btnExecute.innerText = 'エラーを修正してください';
      } else {
        btnExecute.disabled = false;
        btnExecute.innerText = parsed.length + ' 件を一括インポート';
        parsedBatchItems = [];
        for (var m = 0; m < parsed.length; m++) {
          parsedBatchItems.push({
            start_time: parsed[m].start_time,
            end_time: parsed[m].end_time,
            title: parsed[m].title,
            band: parsed[m].band,
            type: parsed[m].type
          });
        }
      }
    }

    async function executeBatchImport() {
      if (parsedBatchItems.length === 0) return;
      var overwrite = document.getElementById('importOverwrite').checked;

      if (overwrite && !confirm("【確認】既存のタイムテーブルをすべて削除して置き換えますか？")) {
        return;
      }

      var btnExecute = document.getElementById('btnExecuteImport');
      btnExecute.disabled = true;
      btnExecute.innerText = 'インポート処理中...';

      try {
        var res = await fetch(API_BASE + '/api/timetable/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: parsedBatchItems, overwrite: overwrite })
        });
        var data = await res.json();

        if (res.ok) {
          showToast('🎉 ' + data.count + ' 件を一括登録しました！', false);
          closeImportModal();
          document.getElementById('importRawText').value = '';
          parseImportText();
          loadTimetableList();
        } else {
          showToast('❌ ' + (data.error || 'インポート失敗'), true);
          btnExecute.disabled = false;
          btnExecute.innerText = parsedBatchItems.length + ' 件を一括インポート';
        }
      } catch (err) {
        showToast('❌ 通信エラーが発生しました', true);
        btnExecute.disabled = false;
      }
    }

    function handleImageSelect(event) {
      var file = event.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function(e) {
        selectedImageData = e.target.result;
        var img = document.getElementById('sidePreviewImg');
        img.src = selectedImageData;
        img.style.display = 'block';
        document.getElementById('uploadPrompt').style.display = 'none';
      };
      reader.readAsDataURL(file);
    }

    async function submitSidebar() {
      var title = document.getElementById('sideTitleInput').value.trim();
      var desc = document.getElementById('sideDescInput').value.trim();
      var duration = document.getElementById('sideDurationInput').value;
      var isActive = document.getElementById('sideActiveCheck').checked;

      if (!title) return alert("タイトルを入力してください");

      try {
        var res = await fetch(API_BASE + '/api/sidebar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title,
            description: desc,
            image_data: selectedImageData,
            duration: Number(duration),
            is_active: isActive ? 1 : 0
          })
        });
        if (res.ok) {
          showToast("🖼️ パネルスライドを追加しました！", false);
          document.getElementById('sideTitleInput').value = '';
          document.getElementById('sideDescInput').value = '';
          selectedImageData = '';
          document.getElementById('sidePreviewImg').style.display = 'none';
          document.getElementById('uploadPrompt').style.display = 'block';
          document.getElementById('sideFileInput').value = '';
          loadSidebarList();
        } else {
          var err = await res.json();
          showToast("❌ 追加失敗: " + (err.error || "エラー"), true);
        }
      } catch (e) {
        showToast("❌ 通信エラーが発生しました", true);
      }
    }

    async function loadSidebarList() {
      var listEl = document.getElementById('sideList');
      if (!listEl) return;
      try {
        var res = await fetch(API_BASE + '/api/sidebar/all');
        var items = await res.json();
        if (!items || !Array.isArray(items) || items.length === 0) {
          listEl.innerHTML = '<div style="text-align:center; color:#64748b;">登録されたパネルはありません</div>';
          return;
        }
        listEl.innerHTML = '';
        items.forEach(function(item) {
          var card = document.createElement('div');
          card.className = 'item-card ' + (item.is_active ? 'item-active' : 'item-inactive');
          card.innerHTML = 
            '<div class="item-header" style="margin-bottom:12px;">' +
              '<label style="display:flex; align-items:center; gap:8px; cursor:pointer;">' +
                '<input type="checkbox" id="side-check-' + item.id + '"' + (item.is_active ? ' checked' : '') + ' onchange="updateSidebar(' + item.id + ')">' +
                '<strong style="color:' + (item.is_active ? '#38bdf8' : '#94a3b8') + '">' + (item.is_active ? '● 表示中' : '✕ 非表示') + '</strong>' +
              '</label>' +
              '<div style="display:flex; align-items:center; gap:4px;">' +
                '<span style="font-size:12px; color:#94a3b8;">表示秒数:</span>' +
                '<input type="number" id="side-dur-' + item.id + '" value="' + (item.duration || 10) + '" style="width:60px; padding:4px 8px;">' +
              '</div>' +
            '</div>' +
            (item.image_data ? '<img src="' + item.image_data + '" class="thumb-preview">' : '') +
            '<div style="display:flex; flex-direction:column; gap:8px; margin-bottom:12px;">' +
              '<input type="text" id="side-title-' + item.id + '" value="' + escapeHtml(item.title) + '" placeholder="タイトル">' +
              '<textarea id="side-desc-' + item.id + '" placeholder="説明・本文">' + escapeHtml(item.description || '') + '</textarea>' +
            '</div>' +
            '<div style="display:flex; justify-content:flex-end; gap:8px;">' +
              '<button class="btn btn-save" onclick="updateSidebar(' + item.id + ', this)">変更保存</button>' +
              '<button class="btn btn-danger" onclick="deleteSidebar(' + item.id + ')">削除</button>' +
            '</div>';
          listEl.appendChild(card);
        });
      } catch (e) {
        listEl.innerHTML = '<div style="color:#f87171;">取得失敗</div>';
      }
    }

    async function updateSidebar(id, btn) {
      if (btn) { btn.disabled = true; btn.innerText = "保存中..."; }
      
      var is_active = document.getElementById('side-check-' + id).checked;
      var title = document.getElementById('side-title-' + id).value;
      var description = document.getElementById('side-desc-' + id).value;
      var duration = document.getElementById('side-dur-' + id).value;

      try {
        await fetch(API_BASE + '/api/sidebar/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            id: id, 
            title: title, 
            description: description, 
            duration: Number(duration), 
            is_active: is_active 
          })
        });
        showToast("✅ パネルの変更を保存しました！", false);
        if (!btn) {
          loadSidebarList(); 
        } else {
          btn.disabled = false;
          btn.innerText = "変更保存";
          var card = btn.closest('.item-card');
          if (is_active) {
            card.classList.add('item-active');
            card.classList.remove('item-inactive');
            card.querySelector('strong').style.color = '#38bdf8';
            card.querySelector('strong').innerText = '● 表示中';
          } else {
            card.classList.add('item-inactive');
            card.classList.remove('item-active');
            card.querySelector('strong').style.color = '#94a3b8';
            card.querySelector('strong').innerText = '✕ 非表示';
          }
        }
      } catch (e) {
        showToast("❌ 変更に失敗しました", true);
        if (btn) { btn.disabled = false; btn.innerText = "変更保存"; }
      }
    }

    async function deleteSidebar(id) {
      if (!confirm("本当にこのパネルを削除しますか？")) return;
      try {
        await fetch(API_BASE + '/api/sidebar/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id })
        });
        showToast("🗑️ パネルを削除しました", false);
        loadSidebarList();
      } catch (e) {
        showToast("❌ 削除に失敗しました", true);
      }
    }

    function escapeHtml(str) {
      return (str || '').replace(/[&<>'"]/g, function(tag) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag;
      });
    }

    // 初期起動タブ
    switchTab('control');
  </script>
</body>
</html>
`

export default app
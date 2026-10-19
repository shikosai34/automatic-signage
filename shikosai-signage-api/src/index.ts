import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  GEMINI_API_KEY: string
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())

app.get('/', (c) => {
  return c.text('Shikosai Signage API is running!')
})

app.get('/admin', (c) => {
  return c.html(HTML_ADMIN_PAGE)
})

const padTimeStr = (t: string) => {
  if (!t) return '';
  const p = t.split(':');
  return p.length === 2 ? ('0' + p[0]).slice(-2) + ':' + ('0' + p[1]).slice(-2) : t;
};

// ==========================================
// 0. データベース初期化
// ==========================================
app.get('/init', async (c) => {
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS badges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE
        );
      `),
      c.env.DB.prepare(`INSERT OR IGNORE INTO badges (name) VALUES ('ステージ'), ('サークルカット'), ('お知らせ'), ('PR企画'), ('ライブ');`)
    ]);

    try { 
      await c.env.DB.prepare(`ALTER TABLE timetable ADD COLUMN badge TEXT DEFAULT 'ステージ'`).run(); 
    } catch(e) {}

    try { 
      await c.env.DB.prepare(`ALTER TABLE app_state ADD COLUMN delay_minutes INTEGER DEFAULT 0`).run(); 
    } catch(e) {}

    return c.text('Database initialized successfully');
  } catch (err: any) {
    return c.text('Init failed: ' + err.message, 500);
  }
});

// ==========================================
// 1. バッジ管理 API
// ==========================================
app.get('/api/badges', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM badges ORDER BY id ASC').all()
    return c.json(results || [])
  } catch (e: any) {
    return c.json([{id: 1, name: 'ステージ'}])
  }
})

app.post('/api/badges', async (c) => {
  try {
    const body = await c.req.json()
    if (!body.name) return c.json({ error: '名前が空です' }, 400)
    await c.env.DB.prepare('INSERT INTO badges (name) VALUES (?)').bind(body.name).run()
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/badges/delete', async (c) => {
  try {
    const body = await c.req.json()
    await c.env.DB.prepare('DELETE FROM badges WHERE id = ?').bind(body.id).run()
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ==========================================
// 2. 進行コントロール用 API
// ==========================================
app.get('/api/state', async (c) => {
  try {
    let state: any = null
    try {
      state = await c.env.DB.prepare('SELECT * FROM app_state WHERE id = 1').first()
    } catch (_) {}
    
    if (!state) {
      state = { current_index: -1, is_auto: 1, wait_cm: 0, current_day: 1, delay_minutes: 0 }
    }

    const currentDay = state.current_day || 1
    const { results: timetable } = await c.env.DB.prepare(
      'SELECT * FROM timetable WHERE day = ? ORDER BY start_time ASC, id ASC'
    ).bind(currentDay).all()
    
    return c.json({ state, timetable: timetable || [] })
  } catch (e: any) {
    return c.json({ state: { current_index: -1, is_auto: 1, wait_cm: 0, current_day: 1, delay_minutes: 0 }, timetable: [] })
  }
})

app.post('/api/state/update', async (c) => {
  try {
    const body = await c.req.json()
    const updates: string[] = []
    const values: any[] = []
    
    if (body.current_day !== undefined) {
      updates.push('current_day = ?')
      values.push(body.current_day)
    }
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
    if (body.delay_minutes !== undefined) {
      updates.push('delay_minutes = ?')
      values.push(parseInt(body.delay_minutes) || 0)
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
// 3. テロップ用 API
// ==========================================
app.get('/api/info', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM info WHERE is_active = 1 ORDER BY id DESC').all()
  return c.json(results || [])
})
app.get('/api/info/all', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM info ORDER BY is_active DESC, id DESC').all()
  return c.json(results || [])
})
app.post('/api/info', async (c) => {
  const body = await c.req.json()
  const rawText = body.raw_text || body.text || ''
  const formattedText = body.formatted_text || rawText
  const tag = body.tag || 'その他'
  const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : 1
  await c.env.DB.prepare('INSERT INTO info (raw_text, formatted_text, tag, frequency, is_active) VALUES (?, ?, ?, 1, ?)')
    .bind(rawText, formattedText, tag, isActive).run()
  return c.json({ success: true })
})
app.post('/api/info/update', async (c) => {
  const body = await c.req.json()
  await c.env.DB.prepare('UPDATE info SET formatted_text = ?, tag = ?, is_active = ? WHERE id = ?')
    .bind(body.formatted_text, body.tag, body.is_active ? 1 : 0, body.id).run()
  return c.json({ success: true })
})
app.post('/api/info/delete', async (c) => {
  const body = await c.req.json()
  await c.env.DB.prepare('DELETE FROM info WHERE id = ?').bind(body.id).run()
  return c.json({ success: true })
})

// ==========================================
// 4. タイムテーブル API
// ==========================================
app.get('/api/timetable', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM timetable ORDER BY day ASC, start_time ASC, id ASC').all()
    return c.json(results || [])
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/timetable', async (c) => {
  try {
    const body = await c.req.json()
    const day = body.day || 1
    const startTime = padTimeStr(body.start_time || '')
    const endTime = padTimeStr(body.end_time || '')
    const title = body.title || ''
    const band = body.band || ''
    const type = body.type || 'song'
    const badge = body.badge || 'ステージ'

    if (!startTime || !endTime) return c.json({ error: "開始時刻と終了時刻を指定してください" }, 400)
    if (startTime >= endTime) return c.json({ error: "終了時刻は開始時刻より後に設定してください" }, 400)

    const { results: overlaps } = await c.env.DB.prepare(
      'SELECT title, start_time, end_time FROM timetable WHERE day = ? AND ? < end_time AND ? > start_time'
    ).bind(day, startTime, endTime).all()

    if (overlaps && overlaps.length > 0) {
      const conflict: any = overlaps[0]
      return c.json({ error: `時間が重複しています（既存: ${conflict.start_time}〜${conflict.end_time} 「${conflict.title}」）` }, 400)
    }

    await c.env.DB.prepare(
      'INSERT INTO timetable (day, start_time, end_time, title, band, type, badge) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(day, startTime, endTime, title, band, type, badge).run()

    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/timetable/batch', async (c) => {
  try {
    const body = await c.req.json()
    const { items, overwrite, day } = body as any
    const targetDay = day || 1

    if (!items || !Array.isArray(items) || items.length === 0) return c.json({ error: "データがありません" }, 400)

    items.forEach((item: any) => {
      item.start_time = padTimeStr(item.start_time)
      item.end_time = padTimeStr(item.end_time)
    })

    const sorted = [...items].sort((a, b) => a.start_time.localeCompare(b.start_time))
    
    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i]
      if (!curr.start_time || !curr.end_time || !curr.title) return c.json({ error: `「${curr.title || '無題'}」の入力内容を確認してください` }, 400)
      if (curr.start_time >= curr.end_time) return c.json({ error: `「${curr.title}」の終了時刻が開始時刻より前です` }, 400)
      if (i > 0 && curr.start_time < sorted[i - 1].end_time) return c.json({ error: `データ内で時間が重複しています（「${sorted[i-1].title}」と「${curr.title}」）` }, 400)
    }

    if (!overwrite) {
      const { results: existing } = await c.env.DB.prepare('SELECT title, start_time, end_time FROM timetable WHERE day = ?').bind(targetDay).all()
      if (existing && existing.length > 0) {
        for (const item of items) {
          for (const ex of existing as any[]) {
            if (item.start_time < padTimeStr(ex.end_time as string) && item.end_time > padTimeStr(ex.start_time as string)) {
              return c.json({ error: `既存の「${ex.title}」(${ex.start_time}〜${ex.end_time}) と重複しています` }, 400)
            }
          }
        }
      }
    }

    const stmts = []
    if (overwrite) stmts.push(c.env.DB.prepare('DELETE FROM timetable WHERE day = ?').bind(targetDay))
    
    for (const item of sorted) {
      stmts.push(c.env.DB.prepare('INSERT INTO timetable (day, start_time, end_time, title, band, type, badge) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(targetDay, item.start_time, item.end_time, item.title, item.band || '', item.type || 'song', item.badge || 'ステージ'))
    }

    await c.env.DB.batch(stmts)
    return c.json({ success: true, count: sorted.length })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/timetable/update', async (c) => {
  try {
    const body = await c.req.json()
    const { id, day, title, band, type, badge } = body
    const start_time = padTimeStr(body.start_time)
    const end_time = padTimeStr(body.end_time)
    const targetDay = day || 1

    if (!start_time || !end_time) return c.json({ error: "時刻を指定してください" }, 400)
    if (start_time >= end_time) return c.json({ error: "終了時刻は開始時刻より後に設定してください" }, 400)

    const { results: overlaps } = await c.env.DB.prepare(
      'SELECT title, start_time, end_time FROM timetable WHERE day = ? AND ? < end_time AND ? > start_time AND id != ?'
    ).bind(targetDay, start_time, end_time, id).all()

    if (overlaps && overlaps.length > 0) {
      const conflict: any = overlaps[0]
      return c.json({ error: `時間が重複しています（既存: ${conflict.start_time}〜${conflict.end_time} 「${conflict.title}」）` }, 400)
    }

    await c.env.DB.prepare('UPDATE timetable SET day = ?, start_time = ?, end_time = ?, title = ?, band = ?, type = ?, badge = ? WHERE id = ?')
      .bind(targetDay, start_time, end_time, title, band, type, badge || 'ステージ', id).run()
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/timetable/delete', async (c) => {
  const body = await c.req.json()
  await c.env.DB.prepare('DELETE FROM timetable WHERE id = ?').bind(body.id).run()
  return c.json({ success: true })
})

app.post('/api/timetable/delete_range', async (c) => {
  try {
    const body = await c.req.json()
    const targetDay = body.day || 1
    const start_time = padTimeStr(body.start_time)
    const end_time = padTimeStr(body.end_time)

    if (!start_time || !end_time) return c.json({ error: "時刻を指定してください" }, 400)
    if (start_time >= end_time) return c.json({ error: "終了時刻は開始時刻より後に設定してください" }, 400)

    const { results } = await c.env.DB.prepare('SELECT id, start_time, end_time FROM timetable WHERE day = ?').bind(targetDay).all()
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
// 5. 右側パネル用 & 6. AI用
// ==========================================
app.get('/api/sidebar', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM sidebar_items WHERE is_active = 1 ORDER BY id DESC').all()
    return c.json(results || [])
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})
app.get('/api/sidebar/all', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM sidebar_items ORDER BY is_active DESC, id DESC').all()
    return c.json(results || [])
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})
app.post('/api/sidebar', async (c) => {
  try {
    const body = await c.req.json()
    await c.env.DB.prepare('INSERT INTO sidebar_items (title, description, image_data, duration, is_active) VALUES (?, ?, ?, ?, ?)')
      .bind(body.title||'', body.description||'', body.image_data||'', Number(body.duration)||10, body.is_active!==undefined?(body.is_active?1:0):1).run()
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})
app.post('/api/sidebar/update', async (c) => {
  try {
    const body = await c.req.json()
    if (body.title !== undefined) {
      await c.env.DB.prepare('UPDATE sidebar_items SET title=?, description=?, duration=?, is_active=? WHERE id=?')
        .bind(body.title, body.description, Number(body.duration)||10, body.is_active?1:0, body.id).run()
    } else {
      await c.env.DB.prepare('UPDATE sidebar_items SET is_active=? WHERE id=?').bind(body.is_active?1:0, body.id).run()
    }
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})
app.post('/api/sidebar/delete', async (c) => {
  const body = await c.req.json()
  await c.env.DB.prepare('DELETE FROM sidebar_items WHERE id=?').bind(body.id).run()
  return c.json({ success: true })
})

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
      "- 先頭に必ず適切な角括弧タグを付けること。\n" +
      "- 絵文字や挨拶文は削除すること。\n" +
      "- 整形後のテキストのみを出力し、解説や前置きは一切出力しないこと。\n\n" +
      "【連絡文】\n" + rawText

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`, {
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
// 7. 管理画面 HTML
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
    .setting-box { background: #0f172a; border: 1px solid #334155; padding: 14px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 10px; }
    
    .switch-container { display: flex; align-items: center; gap: 10px; }
    .switch { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #475569; transition: .3s; border-radius: 24px; }
    .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%; }
    input:checked + .slider { background-color: #10b981; }
    input:checked + .slider:before { transform: translateX(20px); }

    .ctrl-item-card { background: #0f172a; padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 4px solid #64748b; font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
    .ctrl-item-card.active { background: #0369a1; border-left-color: #38bdf8; }
    .ctrl-item-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ctrl-time { font-weight: bold; color: #38bdf8; font-size: 13px; }
    .ctrl-title { font-weight: bold; font-size: 15px; color: #fff; word-break: break-all; }
    .ctrl-band { color: #94a3b8; font-size: 13px; word-break: break-all; }
    
    .delay-input-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .delay-input { width: 90px !important; padding: 6px 10px !important; font-size: 16px !important; text-align: center; }
    .delay-btn-group { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .delay-btn { background: #334155; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: bold; }
    .delay-btn:hover { background: #475569; }
  </style>
</head>
<body>
  <div class="container">
    <!-- ★ ヘッダー部分に目立つ遅延バッジを追加 -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;">
      <h1 style="margin:0; font-size:22px; color:#f8fafc;">茨香祭 総合管理コンソール</h1>
      <div id="globalDelayBadge" style="display:none; background:#ea580c; color:white; padding:6px 14px; border-radius:20px; font-weight:bold; font-size:14px; box-shadow:0 0 10px rgba(234,88,12,0.4);">＋0分 遅延中</div>
    </div>

    <div class="tab-nav">
      <button class="tab-btn active" id="tabBtnControl" onclick="switchTab('control')">🎮 進行</button>
      <button class="tab-btn" id="tabBtnTicker" onclick="switchTab('ticker')">📢 テロップ</button>
      <button class="tab-btn" id="tabBtnTimetable" onclick="switchTab('timetable')">📅 タイムテ</button>
      <button class="tab-btn" id="tabBtnSidebar" onclick="switchTab('sidebar')">🖼️ パネル</button>
    </div>

    <!-- タブ: 進行コントロール -->
    <div id="tabContentControl">
      <div class="card">
        <h2 style="margin-bottom: 16px;">🎮 OBSステージ進行状態</h2>
        <div class="setting-box" style="background: rgba(3, 105, 161, 0.4); border-color: #0284c7;">
          <div><div style="font-weight:bold; font-size:14px; margin-bottom:2px; color:#e0f2fe;">🗓️ 配信日程の選択</div><div style="font-size:11px; color:#bae6fd;">現在OBSに連動させるタイムテーブルの日程</div></div>
          <div style="display:flex; gap:8px;"><button id="btnCtrlDay1" class="btn" style="padding:8px 16px; border-radius:8px;" onclick="changeCurrentDay(1)">1日目</button><button id="btnCtrlDay2" class="btn btn-secondary" style="padding:8px 16px; border-radius:8px;" onclick="changeCurrentDay(2)">2日目</button></div>
        </div>

        <div class="setting-box" style="flex-direction: column; align-items: flex-start;">
          <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
            <div>
              <div style="font-weight:bold; font-size:14px; margin-bottom:2px; color:#fed7aa;">⏱️ 全体遅延オフセット</div>
              <div style="font-size:11px; color:#94a3b8;">指定した分数だけ、OBS上で定刻に赤線＋変更後時刻を表示します</div>
            </div>
            <div style="font-weight:bold; font-size:16px; color:#ea580c;" id="currentDelayLabel">遅延なし (0分)</div>
          </div>
          
          <div class="delay-input-row">
            <span style="font-size:13px; color:#94a3b8;">自由指定:</span>
            <input type="number" id="customDelayInput" class="delay-input" min="0" max="180" placeholder="0" value="0">
            <span style="font-size:14px;">分</span>
            <button class="btn" style="padding:6px 14px; font-size:13px;" onclick="submitCustomDelay()">設定する</button>
            <button class="btn btn-danger" style="padding:6px 12px; font-size:13px;" onclick="setDelay(0)">解除(0分)</button>
          </div>

          <div style="font-size:12px; color:#94a3b8; margin-top:8px;">ワンタップ指定:</div>
          <div class="delay-btn-group">
            <button class="delay-btn" onclick="setDelay(5)">+5分</button>
            <button class="delay-btn" onclick="setDelay(10)">+10分</button>
            <button class="delay-btn" onclick="setDelay(15)">+15分</button>
            <button class="delay-btn" onclick="setDelay(20)">+20分</button>
            <button class="delay-btn" onclick="setDelay(30)">+30分</button>
            <button class="delay-btn" onclick="setDelay(45)">+45分</button>
          </div>
        </div>

        <div class="setting-box">
          <div><div style="font-weight:bold; font-size:14px; margin-bottom:2px;">🕒 自動進行モード</div><div style="font-size:11px; color:#94a3b8;">時間に合わせてOBSを自動切り替え</div></div>
          <div class="switch-container"><span id="labelAutoMode" style="font-size:12px; font-weight:bold;">ON</span><label class="switch"><input type="checkbox" id="chkAutoMode" onchange="updateStateSetting()"><span class="slider"></span></label></div>
        </div>
        <div class="setting-box">
          <div><div style="font-weight:bold; font-size:14px; margin-bottom:2px;">⏳ CM完走待ち機能</div><div style="font-size:11px; color:#94a3b8;">CM動画の終了を待って切り替え</div></div>
          <div class="switch-container"><span id="labelWaitCm" style="font-size:12px; font-weight:bold;">ON</span><label class="switch"><input type="checkbox" id="chkWaitCm" onchange="updateStateSetting()"><span class="slider"></span></label></div>
        </div>
        <div class="control-slot control-slot-prev"><div style="font-size:11px; color:#94a3b8; font-weight:bold;">◀ 1つ前の企画</div><div id="ctrl-prev-title" class="c-title">なし</div></div>
        <div class="control-slot control-slot-current"><div style="font-size:11px; color:#e0f2fe; font-weight:bold;">● 現在の送出状態</div><div id="ctrl-curr-title" class="c-title">待機中</div><div id="ctrl-curr-sub" class="c-sub"></div></div>
        <div class="control-slot control-slot-next"><div style="font-size:11px; color:#94a3b8; font-weight:bold;">▶ 次の企画</div><div id="ctrl-next-title" class="c-title">なし</div></div>
        <div style="display:flex; gap:10px; margin-top:14px;"><button class="btn" style="flex:1; background:#475569; padding:14px; font-size:15px;" onclick="manualChange(-1)">◀ 前へ</button><button class="btn" style="flex:2; padding:14px; font-size:15px;" onclick="manualChange(1)">次へ ▶</button></div>
      </div>
      <div class="card" style="margin-top:16px;">
        <h3>📋 演目進行リスト</h3>
        <div id="ctrl-timetable-list" class="list-container" style="max-height: 320px; overflow-y:auto; gap:6px;"></div>
      </div>
    </div>

    <!-- タブ: テロップ管理 -->
    <div id="tabContentTicker" style="display:none;">
      <div class="card">
        <h2>📢 テロップ新規登録</h2>
        <textarea id="rawText" placeholder="サークルや本部からの連絡文を入力..."></textarea>
        <div class="form-row">
          <label style="flex:1; min-width:140px;">タグ: <select id="tagSelect"><option value="グッズ案内">グッズ案内</option><option value="企画宣伝">企画宣伝</option><option value="迷子落とし物">迷子落とし物</option><option value="その他" selected>その他</option><option value="その他（そのまま）">その他（そのまま）</option><option value="緊急">🚨 緊急</option><option value="緊急（そのまま）">🚨 緊急（そのまま）</option></select></label>
          <label style="display:flex; align-items:center; gap:6px; font-size:14px;"><input type="checkbox" id="isActiveCheck" checked> すぐに表示</label>
          <button class="btn" id="submitBtn" onclick="submitTicker()" style="width:100%;">送信して追加</button>
        </div><div id="statusMsg" style="margin-top:10px; font-weight:bold; font-size:14px;"></div>
      </div>
      <div class="card" style="margin-top:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;"><h3>📋 登録テロップ一覧</h3><button class="btn" style="padding:6px 12px; font-size:12px; background:#334155;" onclick="loadTickerList()">↻ 更新</button></div>
        <div id="itemList" class="list-container">読み込み中...</div>
      </div>
    </div>

    <!-- タブ: タイムテーブル管理 -->
    <div id="tabContentTimetable" style="display:none;">
      <div style="display:flex; gap:8px; margin-bottom:12px;">
        <button id="btnEditDay1" class="btn" style="flex:1; border-radius:8px;" onclick="setEditDay(1)">📅 1日目</button>
        <button id="btnEditDay2" class="btn btn-secondary" style="flex:1; border-radius:8px;" onclick="setEditDay(2)">📅 2日目</button>
      </div>

      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
          <h2 style="margin:0;">📅 新規登録 (<span id="txtEditDayLabel">1日目</span>)</h2>
          <div style="display:flex; gap:6px;">
            <button class="btn btn-secondary" style="padding:6px 10px;" onclick="openBadgeModal()">🏷️ バッジ管理</button>
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
            <select id="ttType" onchange="toggleNewBadgeSelect()">
              <option value="song">ステージ（演奏・企画）</option>
              <option value="break">幕間（準備・CM放映）</option>
            </select>
          </div>
          <div style="flex:1; min-width:130px;" id="newBadgeGroup">
            <label style="font-size:12px; color:#94a3b8;">バッジ</label>
            <select id="ttBadge">
            </select>
          </div>
        </div>
        <div class="form-row" style="margin-top:12px;">
          <div style="flex:1; min-width:130px;">
            <label style="font-size:12px; color:#94a3b8;">団体名</label>
            <input type="text" id="ttBand" placeholder="例: 吹奏楽部">
          </div>
          <div style="flex:2; min-width:160px;">
            <label style="font-size:12px; color:#94a3b8;">詳細（企画名・タイトル）</label>
            <input type="text" id="ttTitle" placeholder="例: オープニング演奏「響けファンファーレ」">
          </div>
        </div>
        <button class="btn" style="margin-top:14px; width:100%;" onclick="submitTimetable()">タイムテーブルに追加</button>
      </div>

      <div class="card" style="margin-top:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3 style="margin:0;">📋 登録済み一覧 (<span id="txtListDayLabel">1日目</span>)</h3>
          <button class="btn" style="padding:6px 12px; font-size:12px; background:#334155;" onclick="loadTimetableList()">↻ 更新</button>
        </div>
        <div id="timetableList" class="list-container" style="margin-top:12px;">読み込み中...</div>
      </div>
    </div>

    <!-- タブ: 右側パネル管理 -->
    <div id="tabContentSidebar" style="display:none;">
      <div class="card">
        <h2>🖼️ 右側パネル新規登録</h2>
        <div class="upload-box" onclick="document.getElementById('sideFileInput').click()"><div id="uploadPrompt">📷 タップして画像を選択（任意）</div><img id="sidePreviewImg" style="display:none; max-height:160px; margin:0 auto; border-radius:6px;" /><input type="file" id="sideFileInput" accept="image/*" style="display:none;" onchange="handleImageSelect(event)"></div>
        <div class="form-group"><label>タイトル:</label><input type="text" id="sideTitleInput" placeholder="例: 公式Tシャツ販売中！"></div>
        <div class="form-group"><label>説明・本文:</label><textarea id="sideDescInput" placeholder="例: 本部テントにて限定販売中！"></textarea></div>
        <div class="form-row"><label style="font-size:14px;">表示時間: <input type="number" id="sideDurationInput" value="10" min="3" max="60" style="width:60px;"> 秒</label><label style="margin-left:auto; font-size:14px;"><input type="checkbox" id="sideActiveCheck" checked> すぐに表示</label><button class="btn" style="width:100%; margin-top:8px;" onclick="submitSidebar()">追加する</button></div>
      </div>
      <div class="card" style="margin-top:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;"><h3>📋 右側パネル一覧</h3><button class="btn" style="padding:6px 12px; font-size:12px; background:#334155;" onclick="loadSidebarList()">↻ 更新</button></div>
        <div id="sideList" class="list-container">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- モーダル: バッジ管理 -->
  <div class="modal-overlay" id="badgeModal">
    <div class="modal-card" style="max-width: 500px;">
      <div class="modal-header">
        <h3 style="margin:0;">🏷️ 表示バッジの管理</h3>
        <button style="background:transparent; border:none; color:#94a3b8; font-size:24px; cursor:pointer;" onclick="closeBadgeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size:13px; color:#94a3b8; margin-top:0;">タイムテーブルやOBS画面に表示する「緑色の枠（バッジ）」の種類を追加・削除できます。</p>
        <div style="display:flex; gap:10px; margin-bottom:16px;">
          <input type="text" id="newBadgeName" placeholder="新しいバッジ名 (例: 吹奏楽部)" style="flex:1;">
          <button class="btn" onclick="addBadge()">追加</button>
        </div>
        <div id="badgeList" class="list-container">読み込み中...</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" style="margin-left:auto;" onclick="closeBadgeModal()">閉じる</button>
      </div>
    </div>
  </div>

  <!-- モーダル: 範囲削除 -->
  <div class="modal-overlay" id="deleteRangeModal">
    <div class="modal-card" style="max-width: 450px;">
      <div class="modal-header">
        <h3 style="margin:0;">🗑️ 指定範囲の削除 (<span id="lblDelModalDay">1日目</span>)</h3>
        <button style="background:transparent; border:none; color:#94a3b8; font-size:24px; cursor:pointer;" onclick="closeDeleteRangeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="guide-box" style="background: rgba(239, 68, 68, 0.1); border-left-color: #ef4444; color: #fca5a5;">
          指定した時間帯に<strong>完全に収まる</strong>演目を一括で削除します。
        </div>
        <div class="form-row">
          <div style="flex:1;"><label style="font-size:12px; color:#94a3b8;">開始時刻</label><input type="time" id="delStartTime" value="00:00"></div>
          <div style="flex:1;"><label style="font-size:12px; color:#94a3b8;">終了時刻</label><input type="time" id="delEndTime" value="23:59"></div>
        </div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="closeDeleteRangeModal()">キャンセル</button><button class="btn btn-danger" onclick="executeDeleteRange()">一括削除する</button></div>
    </div>
  </div>

  <!-- モーダル: 一括インポート -->
  <div class="modal-overlay" id="importModal">
    <div class="modal-card">
      <div class="modal-header">
        <h3 style="margin:0;">📋 一括インポート (<span id="lblImpModalDay">1日目</span>)</h3>
        <button style="background:transparent; border:none; color:#94a3b8; font-size:24px; cursor:pointer;" onclick="closeImportModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="guide-box">
          💡 <strong>Excel / Googleスプレッドシートからそのままコピー＆貼り付けできます</strong><br>
          列の順番 (6列): <code>[開始時刻]   [終了時刻]   [団体名]   [詳細(企画名)]   [種別(ステージ/幕間)]   [バッジ]</code><br>
        </div>
        <div class="form-group">
          <label style="font-size:12px; color:#94a3b8;">貼り付けエリア</label>
          <textarea id="importRawText" style="height:120px;" oninput="parseImportText()" placeholder="10:00	10:30	吹奏楽部	オープニング演奏	ステージ	ライブ"></textarea>
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
              <th style="width:65px;">開始</th>
              <th style="width:65px;">終了</th>
              <th>団体名</th>
              <th>詳細</th>
              <th style="width:60px;">種別</th>
              <th style="width:70px;">バッジ</th>
              <th style="width:90px;">状態</th>
            </tr>
          </thead>
          <tbody id="importPreviewBody">
            <tr><td colspan="7" style="text-align:center; color:#64748b; padding:16px;">ここにリアルタイムプレビューが表示されます</td></tr>
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
    
    var gState = { current_index: -1, is_auto: 1, wait_cm: 0, current_day: 1, delay_minutes: 0 };
    var gTimetable = [];
    var gAllTimetable = [];
    var currentEditDay = 1;
    var gBadges = [];

    // ★ 時刻計算用関数
    function addMinutes(timeStr, minutesToAdd) {
      if (!timeStr || minutesToAdd === 0) return timeStr;
      var parts = timeStr.split(':');
      var h = parseInt(parts[0], 10);
      var m = parseInt(parts[1], 10) + minutesToAdd;
      h += Math.floor(m / 60);
      m = m % 60;
      return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
    }

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
        if (contentEl) contentEl.style.display = (t === tab) ? 'block' : 'none';
        var btnEl = document.getElementById('tabBtn' + cap);
        if (btnEl) btnEl.className = 'tab-btn' + (t === tab ? ' active' : '');
      }

      if (tab === 'ticker') loadTickerList();
      if (tab === 'timetable') { loadBadges(); loadTimetableList(); }
      if (tab === 'sidebar') loadSidebarList();
      if (tab === 'control') fetchState();
    }
    
    function toggleNewBadgeSelect() {
      var type = document.getElementById('ttType').value;
      document.getElementById('newBadgeGroup').style.display = (type === 'song' || type === 'ステージ（演奏・企画）') ? 'block' : 'none';
    }
    function toggleEditBadgeSelect(id) {
      var type = document.getElementById('tt-t-'+id).value;
      var box = document.getElementById('tt-b-box-'+id);
      if(box) box.style.display = (type === 'song' || type === 'ステージ（演奏・企画）') ? 'block' : 'none';
    }

    function openBadgeModal() {
      document.getElementById('badgeModal').classList.add('active');
      loadManageBadges();
    }
    function closeBadgeModal() {
      document.getElementById('badgeModal').classList.remove('active');
    }

    async function loadBadges() {
      try {
        var res = await fetch(API_BASE + '/api/badges');
        gBadges = await res.json();
        var badgeSelect = document.getElementById('ttBadge');
        if (badgeSelect) {
          badgeSelect.innerHTML = gBadges.map(b => '<option value="'+escapeHtml(b.name)+'">'+escapeHtml(b.name)+'</option>').join('');
        }
      } catch (e) { console.error("バッジ取得エラー:", e); }
    }

    async function loadManageBadges() {
      try {
        var res = await fetch(API_BASE + '/api/badges');
        gBadges = await res.json();
        var listEl = document.getElementById('badgeList');
        if (gBadges.length === 0) { listEl.innerHTML = '<p style="color:#64748b;">登録されていません</p>'; return; }
        listEl.innerHTML = '';
        gBadges.forEach(function(b) {
          listEl.innerHTML += '<div class="item-card" style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px;">' +
            '<span style="font-weight:bold; color:#00FFCC;">' + escapeHtml(b.name) + '</span>' +
            '<button class="btn btn-danger" onclick="deleteBadge(' + b.id + ')">削除</button></div>';
        });
      } catch (e) {}
    }

    async function addBadge() {
      var name = document.getElementById('newBadgeName').value.trim();
      if (!name) return;
      try {
        await fetch(API_BASE + '/api/badges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
        document.getElementById('newBadgeName').value = '';
        showToast("🏷️ 追加しました", false);
        loadManageBadges();
        loadBadges();
        loadTimetableList();
      } catch (e) { showToast("❌ 通信エラー", true); }
    }

    async function deleteBadge(id) {
      if (!confirm("このバッジを削除しますか？")) return;
      try {
        await fetch(API_BASE + '/api/badges/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
        showToast("🗑️ 削除しました", false);
        loadManageBadges();
        loadBadges();
        loadTimetableList();
      } catch (e) { showToast("❌ 通信エラー", true); }
    }

    // --- 進行コントロール ---
    async function fetchState() {
      try {
        var res = await fetch(API_BASE + '/api/state');
        var data = await res.json();
        gState = data.state || { current_index: -1, is_auto: 1, wait_cm: 0, current_day: 1, delay_minutes: 0 };
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

        // ★遅延表示の反映 (全体ヘッダーバッジと入力欄)
        var delay = gState.delay_minutes || 0;
        
        var globalBadge = document.getElementById('globalDelayBadge');
        if (globalBadge) {
          if (delay > 0) {
            globalBadge.innerText = "🚨 ＋" + delay + "分 遅延中";
            globalBadge.style.display = "block";
          } else {
            globalBadge.style.display = "none";
          }
        }

        var delayLbl = document.getElementById('currentDelayLabel');
        if (delayLbl) {
          delayLbl.innerText = delay > 0 ? "＋" + delay + "分 遅延中" : "遅延なし (0分)";
          delayLbl.style.color = delay > 0 ? "#ea580c" : "#94a3b8";
        }
        
        var customInput = document.getElementById('customDelayInput');
        if (customInput && document.activeElement !== customInput) {
          customInput.value = delay;
        }

        var btn1 = document.getElementById('btnCtrlDay1');
        var btn2 = document.getElementById('btnCtrlDay2');
        if (gState.current_day === 1) {
          btn1.className = 'btn'; btn1.style.background = '#2563eb';
          btn2.className = 'btn btn-secondary'; btn2.style.background = '#475569';
        } else {
          btn2.className = 'btn'; btn2.style.background = '#2563eb';
          btn1.className = 'btn btn-secondary'; btn1.style.background = '#475569';
        }

        renderControlUI();
        
        // タイムテーブル管理画面を開いているときはそちらも再描画
        if (document.getElementById('tabContentTimetable').style.display === 'block') {
          renderTimetableList();
        }
      } catch (e) {}
    }

    // 遅延設定関数（共通）
    async function setDelay(min) {
      try {
        var num = parseInt(min) || 0;
        await fetch(API_BASE + '/api/state/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delay_minutes: num })
        });
        showToast(num > 0 ? "⏱️ 遅延を +" + num + "分 に設定しました" : "⏱️ 遅延を解除しました", false);
        fetchState();
      } catch (e) { showToast("❌ 通信エラー", true); }
    }

    // 手入力欄からの送信
    function submitCustomDelay() {
      var val = document.getElementById('customDelayInput').value;
      setDelay(val);
    }

    async function changeCurrentDay(d) {
      if (gState.current_day === d) return;
      if (!confirm(d + "日目に配信を切り替えますか？\\n※進行状況はリセットされます")) return;
      
      try {
        await fetch(API_BASE + '/api/state/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current_day: Number(d), current_index: -1 })
        });
        showToast(d + "日目に切り替えました", false);
        fetchState();
      } catch(e) { showToast("❌ 通信エラー: " + e.message, true); }
    }

    async function updateStateSetting() {
      var isAuto = document.getElementById('chkAutoMode').checked;
      var waitCm = document.getElementById('chkWaitCm').checked;
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

    // ★ 進行コントロールのUI描画（遅延時刻を反映）
    function renderControlUI() {
      if (!gState) return;
      var idx = gState.current_index;
      var delay = gState.delay_minutes || 0;
      
      var elPrev = document.getElementById('ctrl-prev-title');
      if (elPrev) {
        if (idx > 0 && gTimetable && gTimetable[idx - 1]) {
          var pItem = gTimetable[idx - 1];
          var pS = padTime(pItem.start_time), pE = padTime(pItem.end_time);
          var tStr = delay > 0 ? pS + "(<span style='color:#fb923c'>" + addMinutes(pS, delay) + "</span>) 〜 " + pE + "(<span style='color:#fb923c'>" + addMinutes(pE, delay) + "</span>)" : pS + " 〜 " + pE;
          elPrev.innerHTML = tStr + " | " + escapeHtml(pItem.title || '');
        } else { elPrev.innerText = "なし"; }
      }

      var elCurr = document.getElementById('ctrl-curr-title');
      var elSub = document.getElementById('ctrl-curr-sub');
      if (elCurr) {
        if (idx >= 0 && gTimetable && gTimetable[idx]) {
          var item = gTimetable[idx];
          var typeLabel = (item.type === 'song' || item.type === 'ステージ（演奏・企画）') ? '【ステージ】' : '【幕間CM】';
          elCurr.innerText = typeLabel + " " + (item.title || '');
          if (elSub) {
            var cS = padTime(item.start_time), cE = padTime(item.end_time);
            var tStrC = delay > 0 ? cS + "(<span style='color:#fb923c'>" + addMinutes(cS, delay) + "</span>) 〜 " + cE + "(<span style='color:#fb923c'>" + addMinutes(cE, delay) + "</span>)" : cS + " 〜 " + cE;
            elSub.innerHTML = tStrC + (item.band ? " | " + escapeHtml(item.band) : "");
          }
        } else {
          elCurr.innerText = "待機中・CM映像表示中";
          if (elSub) elSub.innerText = "時間になると自動で開始されます";
        }
      }

      var elNext = document.getElementById('ctrl-next-title');
      if (elNext) {
        if (gTimetable && idx + 1 < gTimetable.length && gTimetable[idx + 1]) {
          var nItem = gTimetable[idx + 1];
          var nS = padTime(nItem.start_time), nE = padTime(nItem.end_time);
          var tStrN = delay > 0 ? nS + "(<span style='color:#fb923c'>" + addMinutes(nS, delay) + "</span>) 〜 " + nE + "(<span style='color:#fb923c'>" + addMinutes(nE, delay) + "</span>)" : nS + " 〜 " + nE;
          elNext.innerHTML = tStrN + " | " + escapeHtml(nItem.title || '');
        } else { elNext.innerText = "なし"; }
      }

      var listEl = document.getElementById('ctrl-timetable-list');
      if (listEl && gTimetable) {
        listEl.innerHTML = '';
        gTimetable.forEach(function(item, i) {
          var card = document.createElement('div');
          card.className = 'ctrl-item-card ' + (i === idx ? 'active' : '');
          var isSong = (item.type === 'song' || item.type === 'ステージ（演奏・企画）');
          var lS = padTime(item.start_time), lE = padTime(item.end_time);
          var tStrL = delay > 0 ? lS + "(<span style='color:#fb923c'>" + addMinutes(lS, delay) + "</span>) 〜 " + lE + "(<span style='color:#fb923c'>" + addMinutes(lE, delay) + "</span>)" : lS + " 〜 " + lE;
          
          card.innerHTML = 
            '<div class="ctrl-item-row"><span class="ctrl-time">🕒 ' + tStrL + '</span>' +
            (isSong ? '<span class="tag tag-song" style="font-size:11px;background:#059669;color:white;padding:2px 6px;border-radius:4px;">ステージ</span>' : '<span class="tag tag-break" style="font-size:11px;background:#d97706;color:white;padding:2px 6px;border-radius:4px;">幕間CM</span>') + '</div>' +
            '<div class="ctrl-title">' + escapeHtml(item.title || '') + '</div>' +
            (item.band ? '<div class="ctrl-band">' + escapeHtml(item.band) + '</div>' : '');
          listEl.appendChild(card);
        });
      }
    }

    setInterval(function() {
      var ctrlBox = document.getElementById('tabContentControl');
      if (ctrlBox && ctrlBox.style.display !== 'none') fetchState();
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
      status.style.color = "#38bdf8"; status.innerText = "処理中...";

      var formattedText = rawText;
      if (!tag.includes("（そのまま）")) {
        try {
          status.innerText = "AIがテロップを成形中...";
          var aiRes = await fetch(API_BASE + '/api/format', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: rawText }) });
          var aiData = await aiRes.json();
          if (aiData.formatted_text) formattedText = aiData.formatted_text;
        } catch (e) {}
      }

      status.innerText = "データベースに保存中...";
      try {
        var res = await fetch(API_BASE + '/api/info', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw_text: rawText, formatted_text: formattedText, tag: tag, is_active: isActive })
        });
        if (res.ok) {
          status.style.color = "#4ade80"; status.innerText = "追加完了: " + formattedText;
          document.getElementById('rawText').value = ''; showToast("📢 テロップ登録完了", false); loadTickerList();
        } else {
          var errData = await res.json();
          showToast("❌ エラー: " + errData.error, true);
        }
      } catch (err) {
        showToast("❌ 通信エラー: " + err.message, true);
      } finally { submitBtn.disabled = false; }
    }

    async function loadTickerList() {
      var listEl = document.getElementById('itemList');
      if (!listEl) return;
      try {
        var res = await fetch(API_BASE + '/api/info/all');
        var items = await res.json();
        if (!items || items.length === 0) { listEl.innerHTML = '<div style="text-align:center; color:#64748b;">登録なし</div>'; return; }
        listEl.innerHTML = '';
        items.forEach(function(item) {
          var card = document.createElement('div');
          card.className = 'item-card ' + (item.is_active ? 'item-active' : 'item-inactive') + ((item.tag||'').indexOf('緊急')!==-1 ? ' item-emergency' : '');
          var tagOptions = '';
          TAG_LIST.forEach(function(t) { tagOptions += '<option value="'+t+'"'+(t===item.tag?' selected':'')+'>'+t+'</option>'; });
          card.innerHTML = 
            '<div class="item-header"><label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="checkbox" id="check-'+item.id+'"'+(item.is_active?' checked':'')+' onchange="updateTicker('+item.id+')"><strong style="color:'+(item.is_active?'#38bdf8':'#94a3b8')+'">'+(item.is_active?'● 表示中':'✕ 非表示')+'</strong></label><select id="tag-'+item.id+'" onchange="updateTicker('+item.id+')">'+tagOptions+'</select></div>' +
            '<div style="font-size:12px; color:#94a3b8; margin-bottom:6px;">【入力原文】' + escapeHtml(item.raw_text) + '</div>' +
            '<input type="text" id="text-'+item.id+'" value="' + escapeHtml(item.formatted_text || item.raw_text) + '">' +
            '<div style="display:flex; justify-content:space-between; margin-top:10px;"><button class="btn btn-save" onclick="updateTicker('+item.id+', this)">変更を保存</button><button class="btn btn-danger" onclick="deleteTicker('+item.id+')">削除</button></div>';
          listEl.appendChild(card);
        });
      } catch (e) {}
    }

    async function updateTicker(id, btn) {
      if (btn) { btn.disabled = true; btn.innerText = "保存中..."; }
      try {
        await fetch(API_BASE + '/api/info/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, is_active: document.getElementById('check-'+id).checked, tag: document.getElementById('tag-'+id).value, formatted_text: document.getElementById('text-'+id).value })
        });
        showToast("✅ 保存しました", false); loadTickerList();
      } catch (e) {
        showToast("❌ 通信エラー", true); if (btn) { btn.disabled = false; btn.innerText = "変更を保存"; }
      }
    }

    async function deleteTicker(id) {
      if (!confirm("本当に削除しますか？")) return;
      await fetch(API_BASE + '/api/info/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
      showToast("🗑️ 削除しました", false); loadTickerList();
    }

    // --- タイムテーブル管理 ---
    function setEditDay(day) {
      currentEditDay = day;
      var btn1 = document.getElementById('btnEditDay1');
      var btn2 = document.getElementById('btnEditDay2');
      if (day === 1) {
        btn1.className = 'btn'; btn1.style.background = '#2563eb';
        btn2.className = 'btn btn-secondary'; btn2.style.background = '#475569';
      } else {
        btn2.className = 'btn'; btn2.style.background = '#2563eb';
        btn1.className = 'btn btn-secondary'; btn1.style.background = '#475569';
      }
      document.getElementById('txtEditDayLabel').innerText = day + "日目";
      document.getElementById('txtListDayLabel').innerText = day + "日目";
      document.getElementById('lblDelModalDay').innerText = day + "日目";
      document.getElementById('lblImpModalDay').innerText = day + "日目";
      renderTimetableList();
    }

    async function submitTimetable() {
      var startTime = padTime(document.getElementById('ttStart').value);
      var endTime = padTime(document.getElementById('ttEnd').value);
      var title = document.getElementById('ttTitle').value.trim();
      var band = document.getElementById('ttBand').value.trim();
      var type = document.getElementById('ttType').value;
      var badge = document.getElementById('ttBadge').value;
      if (!title) return alert("企画名を入力してください");

      try {
        var res = await fetch(API_BASE + '/api/timetable', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ day: currentEditDay, start_time: startTime, end_time: endTime, title: title, band: band, type: type, badge: badge })
        });
        var data = await res.json();
        if (res.ok) {
          showToast("📅 追加しました！", false);
          document.getElementById('ttTitle').value = ''; document.getElementById('ttBand').value = '';
          loadTimetableList();
        } else { showToast("❌ " + (data.error || "追加失敗"), true); }
      } catch (err) { showToast("❌ 通信エラー: " + err.message, true); }
    }

    async function loadTimetableList() {
      try {
        var res = await fetch(API_BASE + '/api/timetable');
        gAllTimetable = await res.json();
        if (gAllTimetable.error) { console.error("Timetable load error:", gAllTimetable.error); return; }
        renderTimetableList();
      } catch (e) { console.error("Timetable fetch error:", e); }
    }

    // ★ タイムテーブル一覧のUI描画（遅延時刻を反映）
    function renderTimetableList() {
      var listEl = document.getElementById('timetableList');
      if (!listEl) return;
      var items = gAllTimetable.filter(function(i) { return i.day === currentEditDay; });

      if (items.length === 0) {
        listEl.innerHTML = '<div style="text-align:center; color:#64748b;">' + currentEditDay + '日目の登録はありません</div>';
        return;
      }
      listEl.innerHTML = '';
      
      var badgeOptionsHtml = gBadges.map(b => '<option value="'+escapeHtml(b.name)+'">'+escapeHtml(b.name)+'</option>').join('');
      var delay = gState.delay_minutes || 0;

      items.forEach(function(item) {
        var card = document.createElement('div');
        card.className = 'item-card ' + ((item.type === 'song' || item.type === 'ステージ（演奏・企画）') ? 'item-song' : 'item-break');
        var isSong = (item.type === 'song' || item.type === 'ステージ（演奏・企画）');
        
        var currentBadgeOptions = badgeOptionsHtml;
        if (item.badge && !gBadges.some(b => b.name === item.badge)) {
          currentBadgeOptions += '<option value="'+escapeHtml(item.badge)+'">'+escapeHtml(item.badge)+'</option>';
        }
        currentBadgeOptions = currentBadgeOptions.replace('value="'+escapeHtml(item.badge||'')+'"', 'value="'+escapeHtml(item.badge||'')+'" selected');

        var sOrig = padTime(item.start_time);
        var eOrig = padTime(item.end_time);
        
        // 遅延がある場合はラベルの横に (変更後時刻) を目立たせて表示
        var sLabel = delay > 0 ? '開始時刻 <span style="color:#fb923c; font-weight:bold;">(' + addMinutes(sOrig, delay) + ')</span>' : '開始時刻';
        var eLabel = delay > 0 ? '終了時刻 <span style="color:#fb923c; font-weight:bold;">(' + addMinutes(eOrig, delay) + ')</span>' : '終了時刻';

        card.innerHTML = 
          '<div class="item-header"><div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap;">' +
            '<div><div style="font-size:11px; color:#94a3b8; margin-bottom:2px;">' + sLabel + '</div><input type="time" id="tt-s-'+item.id+'" value="'+sOrig+'" style="width:110px;"></div><span style="margin-bottom:8px;">〜</span>' +
            '<div><div style="font-size:11px; color:#94a3b8; margin-bottom:2px;">' + eLabel + '</div><input type="time" id="tt-e-'+item.id+'" value="'+eOrig+'" style="width:110px;"></div>' +
            '<div><div style="font-size:11px; color:#94a3b8; margin-bottom:2px;">種別</div><select id="tt-t-'+item.id+'" style="width:120px;" onchange="toggleEditBadgeSelect('+item.id+')">' +
              '<option value="song"'+(isSong?' selected':'')+'>ステージ</option>' +
              '<option value="break"'+((!isSong)?' selected':'')+'>幕間CM</option>' +
            '</select></div>' +
            '<div id="tt-b-box-'+item.id+'" style="'+(!isSong ? 'display:none;' : '')+'"><div style="font-size:11px; color:#94a3b8; margin-bottom:2px;">バッジ</div><select id="tt-b-'+item.id+'" style="width:120px;">' +
              currentBadgeOptions +
            '</select></div>' +
          '</div></div>' +
          '<div style="display:flex; gap:8px; margin-top:8px;">' +
            '<div style="flex:1;"><div style="font-size:11px; color:#94a3b8; margin-bottom:2px;">団体名</div><input type="text" id="tt-band-'+item.id+'" value="'+escapeHtml(item.band||'')+'" placeholder="団体名"></div>' +
            '<div style="flex:2;"><div style="font-size:11px; color:#94a3b8; margin-bottom:2px;">詳細（企画名・タイトル）</div><input type="text" id="tt-title-'+item.id+'" value="'+escapeHtml(item.title)+'" placeholder="詳細（企画名・タイトル）"></div>' +
          '</div>' +
          '<div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">' +
            '<button class="btn btn-save" onclick="updateTimetable('+item.id+', this)">変更保存</button>' +
            '<button class="btn btn-danger" onclick="deleteTimetable('+item.id+')">削除</button>' +
          '</div>';
        listEl.appendChild(card);
      });
    }

    async function updateTimetable(id, btn) {
      if (btn) { btn.disabled = true; btn.innerText = "保存中..."; }
      try {
        var badgeVal = document.getElementById('tt-b-'+id) ? document.getElementById('tt-b-'+id).value : 'ステージ';
        var res = await fetch(API_BASE + '/api/timetable/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, day: currentEditDay, start_time: document.getElementById('tt-s-'+id).value, end_time: document.getElementById('tt-e-'+id).value, type: document.getElementById('tt-t-'+id).value, title: document.getElementById('tt-title-'+id).value, band: document.getElementById('tt-band-'+id).value, badge: badgeVal })
        });
        var data = await res.json();
        if (res.ok) { showToast("✅ 更新しました", false); loadTimetableList(); }
        else { showToast("❌ " + data.error, true); if(btn){btn.disabled=false;btn.innerText="変更保存";} }
      } catch (e) { showToast("❌ 通信エラー: " + e.message, true); if(btn){btn.disabled=false;btn.innerText="変更保存";} }
    }

    async function deleteTimetable(id) {
      if (!confirm("削除しますか？")) return;
      await fetch(API_BASE + '/api/timetable/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
      showToast("🗑️ 削除しました", false); loadTimetableList();
    }

    function openDeleteRangeModal() { document.getElementById('deleteRangeModal').classList.add('active'); }
    function closeDeleteRangeModal() { document.getElementById('deleteRangeModal').classList.remove('active'); }

    async function executeDeleteRange() {
      var start = padTime(document.getElementById('delStartTime').value);
      var end = padTime(document.getElementById('delEndTime').value);
      if (!start || !end || start >= end) return alert("正しい時刻を指定してください");
      if (!confirm("【" + currentEditDay + "日目】 " + start + " 〜 " + end + " をすべて削除しますか？")) return;

      try {
        var res = await fetch(API_BASE + '/api/timetable/delete_range', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ day: currentEditDay, start_time: start, end_time: end })
        });
        var data = await res.json();
        if (res.ok) { showToast("🗑️ 削除しました", false); closeDeleteRangeModal(); loadTimetableList(); }
        else { showToast("❌ 削除失敗: " + data.error, true); }
      } catch (e) { showToast("❌ 通信エラー: " + e.message, true); }
    }

    function openImportModal() { document.getElementById('importModal').classList.add('active'); document.getElementById('importRawText').focus(); }
    function closeImportModal() { document.getElementById('importModal').classList.remove('active'); }

    function parseImportText() {
      var text = document.getElementById('importRawText').value;
      var tbody = document.getElementById('importPreviewBody');
      var btnExecute = document.getElementById('btnExecuteImport');
      parsedBatchItems = [];

      if (!text.trim()) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">プレビューが表示されます</td></tr>'; btnExecute.disabled = true; return; }

      var rawLines = text.split('\\n');
      var parsed = [];
      for (var i = 0; i < rawLines.length; i++) {
        var line = rawLines[i].trim();
        if (!line) continue;
        var cols = (line.indexOf('\\t') !== -1) ? line.split('\\t') : line.split(',');
        var startTime = padTime((cols[0] || '').trim()), endTime = padTime((cols[1] || '').trim());
        var band = (cols[2] || '').trim();
        var title = (cols[3] || '').trim();
        var type = ((cols[4] || '').indexOf('幕間') !== -1 || (cols[4] || '').indexOf('CM') !== -1) ? 'break' : 'song';
        var badge = (cols[5] || '').trim() || 'ステージ';
        var error = (!startTime || !endTime) ? '時刻不正' : (startTime >= endTime ? '時間逆転' : (!title ? '企画名空欄' : ''));
        parsed.push({ idx: parsed.length + 1, start_time: startTime, end_time: endTime, title: title, band: band, type: type, badge: badge, error: error });
      }

      for (var aIdx = 0; aIdx < parsed.length; aIdx++) {
        for (var bIdx = aIdx + 1; bIdx < parsed.length; bIdx++) {
          if (!parsed[aIdx].error && !parsed[bIdx].error && parsed[aIdx].start_time < parsed[bIdx].end_time && parsed[aIdx].end_time > parsed[bIdx].start_time) {
            parsed[aIdx].error = '行' + parsed[bIdx].idx + 'と重複'; parsed[bIdx].error = '行' + parsed[aIdx].idx + 'と重複';
          }
        }
      }

      var errorCount = 0, rowsHtml = '';
      parsed.forEach(function(p) {
        if (p.error) errorCount++;
        rowsHtml += '<tr class="'+(p.error?'has-error':'')+'"><td>'+p.start_time+'</td><td>'+p.end_time+'</td><td>'+escapeHtml(p.band)+'</td><td>'+escapeHtml(p.title)+'</td><td>'+(p.type==='song'?'ステージ':'幕間')+'</td><td>'+escapeHtml(p.badge)+'</td><td>'+(p.error?'❌ '+p.error:'✅ OK')+'</td></tr>';
      });
      tbody.innerHTML = rowsHtml;
      document.getElementById('importStats').innerText = "解析結果: " + parsed.length + " 件" + (errorCount > 0 ? " (エラー: " + errorCount + ")" : "");

      if (errorCount > 0 || parsed.length === 0) { btnExecute.disabled = true; btnExecute.innerText = 'エラーを修正してください'; }
      else {
        btnExecute.disabled = false; btnExecute.innerText = currentEditDay + ' 日目に一括インポート';
        parsedBatchItems = parsed;
      }
    }

    async function executeBatchImport() {
      if (parsedBatchItems.length === 0) return;
      var overwrite = document.getElementById('importOverwrite').checked;
      if (overwrite && !confirm("【確認】" + currentEditDay + "日目の既存データをすべて削除しますか？")) return;

      document.getElementById('btnExecuteImport').disabled = true;
      try {
        var res = await fetch(API_BASE + '/api/timetable/batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: parsedBatchItems, overwrite: overwrite, day: currentEditDay })
        });
        var data = await res.json();
        if (res.ok) { showToast('🎉 一括登録完了！', false); closeImportModal(); loadTimetableList(); }
        else { showToast('❌ インポート失敗: ' + data.error, true); document.getElementById('btnExecuteImport').disabled = false; }
      } catch (err) { showToast('❌ 通信エラー: ' + err.message, true); document.getElementById('btnExecuteImport').disabled = false; }
    }

    // --- 右側パネル管理 ---
    function handleImageSelect(event) {
      var file = event.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function(e) {
        selectedImageData = e.target.result;
        document.getElementById('sidePreviewImg').src = selectedImageData;
        document.getElementById('sidePreviewImg').style.display = 'block';
        document.getElementById('uploadPrompt').style.display = 'none';
      };
      reader.readAsDataURL(file);
    }

    async function submitSidebar() {
      var title = document.getElementById('sideTitleInput').value.trim();
      if (!title) return alert("タイトルを入力してください");
      try {
        var res = await fetch(API_BASE + '/api/sidebar', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title, description: document.getElementById('sideDescInput').value.trim(), image_data: selectedImageData, duration: Number(document.getElementById('sideDurationInput').value), is_active: document.getElementById('sideActiveCheck').checked ? 1 : 0 })
        });
        var data = await res.json();
        if (res.ok) {
          showToast("🖼️ パネル追加完了！", false);
          document.getElementById('sideTitleInput').value = ''; document.getElementById('sideDescInput').value = '';
          selectedImageData = ''; document.getElementById('sidePreviewImg').style.display = 'none'; document.getElementById('uploadPrompt').style.display = 'block';
          loadSidebarList();
        } else { showToast("❌ エラー: " + data.error, true); }
      } catch (e) { showToast("❌ 通信エラー: " + e.message, true); }
    }

    async function loadSidebarList() {
      var listEl = document.getElementById('sideList');
      if (!listEl) return;
      try {
        var res = await fetch(API_BASE + '/api/sidebar/all');
        var items = await res.json();
        if (!items || items.length === 0) { listEl.innerHTML = '<div style="text-align:center; color:#64748b;">登録なし</div>'; return; }
        listEl.innerHTML = '';
        items.forEach(function(item) {
          var card = document.createElement('div');
          card.className = 'item-card ' + (item.is_active ? 'item-active' : 'item-inactive');
          card.innerHTML = 
            '<div class="item-header" style="margin-bottom:12px;"><label style="display:flex; align-items:center; gap:8px;"><input type="checkbox" id="side-check-'+item.id+'"'+(item.is_active?' checked':'')+' onchange="updateSidebar('+item.id+')"><strong style="color:'+(item.is_active?'#38bdf8':'#94a3b8')+'">'+(item.is_active?'● 表示中':'✕ 非表示')+'</strong></label><div>表示秒数: <input type="number" id="side-dur-'+item.id+'" value="'+(item.duration||10)+'" style="width:60px;"></div></div>' +
            (item.image_data ? '<img src="'+item.image_data+'" class="thumb-preview">' : '') +
            '<div style="display:flex; flex-direction:column; gap:8px; margin-bottom:12px;"><input type="text" id="side-title-'+item.id+'" value="' + escapeHtml(item.title) + '"><textarea id="side-desc-'+item.id+'">'+escapeHtml(item.description||'')+'</textarea></div>' +
            '<div style="display:flex; justify-content:flex-end; gap:8px;"><button class="btn btn-save" onclick="updateSidebar('+item.id+', this)">変更保存</button><button class="btn btn-danger" onclick="deleteSidebar('+item.id+')">削除</button></div>';
          listEl.appendChild(card);
        });
      } catch (e) {}
    }

    async function updateSidebar(id, btn) {
      if (btn) { btn.disabled = true; btn.innerText = "保存中..."; }
      try {
        await fetch(API_BASE + '/api/sidebar/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, title: document.getElementById('side-title-'+id).value, description: document.getElementById('side-desc-'+id).value, duration: document.getElementById('side-dur-'+id).value, is_active: document.getElementById('side-check-'+id).checked })
        });
        showToast("✅ 保存しました", false); loadSidebarList();
      } catch (e) { showToast("❌ 通信エラー", true); if (btn) { btn.disabled = false; btn.innerText = "変更保存"; } }
    }

    async function deleteSidebar(id) {
      if (!confirm("削除しますか？")) return;
      await fetch(API_BASE + '/api/sidebar/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
      showToast("🗑️ 削除しました", false); loadSidebarList();
    }

    function escapeHtml(str) { return (str || '').replace(/[&<>'"]/g, function(t) { return {'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[t] || t; }); }

    loadBadges().then(() => setEditDay(1));
    switchTab('control');
  </script>
</body>
</html>
`

export default app
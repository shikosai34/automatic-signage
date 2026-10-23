import { Hono } from 'hono'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import type { LocalDatabase, LocalStatement } from './database.js'
import type { ObsController } from './obs.js'


type Program = {
  id: number
  day: number
  title: string
  description: string
  scheduled_start: string
  adjusted_start: string
  end_time: string
  kind: string
  class_name: string
  circle_slug: string
  media_path: string
}

type CatalogRecord = {
  slug: string
  name: string
  kind?: string
  class_name?: string
  group_name?: string
  description?: string
  program_description?: string
  circle_cut_path?: string
  circle_cut_alt?: string
  source_url?: string
}

export function createApp(db: LocalDatabase, obs: ObsController) {
const app = new Hono()
obs.onMediaEnded((inputName) => { if (inputName === cmInput) { void db.prepare('SELECT current_scene_mode FROM signage_state WHERE id=1').first<any>().then((row) => { if (row?.current_scene_mode !== 'cm') return; if (cmTimer) clearTimeout(cmTimer); cmTimer = setTimeout(() => { void playNextCm().catch((error) => console.error('CM selection failed:', error.message)) }, 300) }) } })
const adminHtml = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8')
const broadcastHtml = readFileSync(new URL('../public/broadcast.html', import.meta.url), 'utf8')
const asset = (name?: string) => (c: any) => c.html(adminHtml)
let cmGeneration = 0
let cmTimer: ReturnType<typeof setTimeout> | undefined
const cmInput = process.env.OBS_CM_SOURCE || 'CM映像'
const stopCmQueue = async () => { cmGeneration += 1; if (cmTimer) clearTimeout(cmTimer); cmTimer = undefined; await obs.stopMedia(cmInput).catch(() => {}) }
const playNextCm = async () => {
  const generation = cmGeneration
  const screen = await screenData(db)
  const ad = screen.playlist[0]
  if (!ad) { await obs.stopMedia(cmInput).catch(() => {}); return }
  const root = resolve(process.env.SIGNAGE_MEDIA_ROOT || resolve(import.meta.dirname, '../../CM'))
  const media = resolve(root, String(ad.media_path).replace(/[\\/]+/g, sep))
  if (media !== root && !media.startsWith(root + sep)) throw new Error('CMパスはメディアルート内を指定してください。')
  if (!existsSync(media)) throw new Error(`CMファイルが見つかりません: ${ad.media_path}`)
  await obs.playMedia(cmInput, media)
  await db.batch([
    db.prepare('UPDATE commercials SET play_count=play_count+1,last_played_at=CURRENT_TIMESTAMP WHERE id=?').bind(ad.id),
    db.prepare('INSERT INTO playback_history (commercial_id,break_key) VALUES (?,?)').bind(ad.id, screen.break_key),
  ])
  if (generation !== cmGeneration) return
  cmTimer = setTimeout(() => { void playNextCm().catch((error) => console.error('CM selection failed:', error.message)) }, Math.max(1000, Math.min(ad.duration_seconds * 1000, screen.gap_seconds * 1000)))
}
const nowJst = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
const padTime = (value: string) => {
  const match = /^\s*(\d{1,2}):(\d{1,2})\s*$/.exec(value || '')
  return match ? `${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}` : ''
}
const timeToMinutes = (value: string) => {
  const time = padTime(value)
  if (!time) return -1
  const [hour, minute] = time.split(':').map(Number)
  return hour * 60 + minute
}
const text = (value: unknown, max = 2000) => String(value ?? '').trim().slice(0, max)
const int = (value: unknown, fallback = 0, min = -2147483648, max = 2147483647) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

async function requireAdmin(c: any) {
  const host = c.req.header('host') || ''
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return c.json({ error: 'ローカル接続だけ許可されています。' }, 403)
  return null
}

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let value = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i += 1 }
    else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) { values.push(value.trim()); value = '' }
    else value += char
  }
  values.push(value.trim())
  return values
}

function parseCsv(source: string) {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '"' && quoted && normalized[index + 1] === '"') { current += '""'; index += 1 }
    else if (char === '"') { quoted = !quoted; current += char }
    else if (char === '\n' && !quoted) { if (current.trim()) lines.push(current); current = '' }
    else current += char
  }
  if (current.trim()) lines.push(current)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0]).map(value => value.toLowerCase().replace(/[\s_\-]/g, ''))
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line)
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] || '']))
  })
}

const csvValue = (row: Record<string, string>, ...keys: string[]) => {
  for (const key of keys) {
    const compact = key.toLowerCase().replace(/[\s_\-]/g, '')
    if (row[compact] !== undefined) return row[compact]
  }
  return ''
}

async function loadPrograms(db: LocalDatabase, day: number): Promise<Program[]> {
  const result = await db.prepare('SELECT * FROM programs WHERE day = ? ORDER BY COALESCE(NULLIF(adjusted_start, \'\'), scheduled_start), display_order, id').bind(day).all<Program>()
  return result.results || []
}

async function buildPlaylist(db: LocalDatabase, day: number, gapSeconds: number, breakKey: string, syncedSlug = '') {
  if (gapSeconds <= 0) return []
  const result = await db.prepare(`
    SELECT cm.*, COALESCE(cc.preference_score, 0) AS circle_preference,
           COALESCE(cc.circle_cut_path, '') AS circle_cut_path,
           COALESCE(cc.name, '') AS circle_name
    FROM commercials cm LEFT JOIN circle_catalog cc ON cc.slug = cm.circle_slug
    WHERE cm.is_active = 1 ORDER BY cm.id ASC
  `).all<any>()
  const recent = await db.prepare(`
    SELECT commercial_id, COUNT(*) AS recent_count
    FROM playback_history WHERE played_at >= datetime('now', '-60 minutes')
    GROUP BY commercial_id
  `).all<{ commercial_id: number; recent_count: number }>()
  const usedInBreak = await db.prepare('SELECT commercial_id FROM playback_history WHERE break_key = ?').bind(breakKey).all<{ commercial_id: number }>()
  const recentCounts = new Map((recent.results || []).map(item => [item.commercial_id, item.recent_count]))
  const alreadyUsed = new Set((usedInBreak.results || []).map(item => item.commercial_id))
  const ads = (result.results || []).map((ad: any) => ({ ...ad }))
  const averagePlays = ads.length ? ads.reduce((total: number, ad: any) => total + int(ad.play_count, 0, 0, 1000000), 0) / ads.length : 0
  const prioritizedAds = ads.map((ad: any) => ({
    ...ad,
    duration_seconds: Math.max(1, int(ad.duration_seconds, 15, 1, 3600)),
    score: int(ad.preference_score, 0, -10, 10) * 3 + int(ad.circle_preference, 0, -10, 10) * 2 - (recentCounts.get(ad.id) || 0) * 8 + (averagePlays - int(ad.play_count, 0, 0, 1000000)) * 0.5,
  })).filter((ad: any) => !alreadyUsed.has(ad.id))

  // Favor the selected circle when synchronization is enabled, then fill the
  // remaining gap with high-priority, underplayed items that still fit.
  prioritizedAds.sort((a: any, b: any) => {
    const syncBoostA = syncedSlug && a.circle_slug === syncedSlug ? 100 : 0
    const syncBoostB = syncedSlug && b.circle_slug === syncedSlug ? 100 : 0
    return (b.score + syncBoostB) - (a.score + syncBoostA) || a.duration_seconds - b.duration_seconds || a.id - b.id
  })
  const selected: any[] = []
  const perCircle = new Map<string, number>()
  let remaining = gapSeconds
  for (const ad of prioritizedAds) {
    const circleSlug = ad.circle_slug || `ad-${ad.id}`
    const used = perCircle.get(circleSlug) || 0
    if (ad.duration_seconds > remaining || used >= Math.max(1, int(ad.max_per_break, 1, 1, 20))) continue
    selected.push({
      id: ad.id,
      title: ad.title,
      circle_slug: ad.circle_slug,
      circle_name: ad.circle_name,
      media_path: ad.media_path,
      duration_seconds: ad.duration_seconds,
      circle_cut_path: ad.circle_cut_path,
    })
    remaining -= ad.duration_seconds
    perCircle.set(circleSlug, used + 1)
    if (remaining <= 0) break
  }
  return selected
}

async function screenData(db: LocalDatabase) {
  const state = await db.prepare('SELECT * FROM signage_state WHERE id = 1').first<any>() || { current_day: 1, wait_cm: 1, delay_minutes: 0, sidebar_mode: 'sync', current_scene_mode: 'program' }
  const day = int(state.current_day, 1, 1, 7)
  const programs = await loadPrograms(db, day)
  const currentMinutes = timeToMinutes(nowJst())
  const effectiveStart = (program: Program) => timeToMinutes(program.adjusted_start || program.scheduled_start)
  let scheduledIndex = -1
  programs.forEach((program, index) => { if (effectiveStart(program) <= currentMinutes) scheduledIndex = index })
  const current = scheduledIndex >= 0 ? programs[scheduledIndex] : null
  const next = programs.find(program => program.kind !== 'break' && effectiveStart(program) > currentMinutes) || null
  const breakNow = state.current_scene_mode === 'cm' || current?.kind === 'break' || (!current && !!next)
  const gapEnd = next
  const gapSeconds = breakNow && gapEnd ? Math.max(0, (effectiveStart(gapEnd) - currentMinutes) * 60) : 0
  const breakKey = `${day}:${current?.id ?? 'gap'}:${gapEnd?.id ?? 'end'}`
  const notices = await db.prepare('SELECT * FROM announcements WHERE is_active = 1 ORDER BY is_emergency DESC, display_order ASC, id DESC').all<any>()
  const catalog = await db.prepare('SELECT * FROM circle_catalog WHERE is_active = 1 ORDER BY display_order ASC, name ASC').all<any>()
  const playlist = state.wait_cm && breakNow ? await buildPlaylist(db, day, gapSeconds, breakKey, current?.circle_slug || '') : []
  const mode = state.sidebar_mode === 'independent' ? 'independent' : 'sync'
  let sidebar: any = null
  if (mode === 'sync' && playlist.length) sidebar = catalog.results?.find((circle: any) => circle.slug === playlist[0].circle_slug) || null
  if (mode === 'sync' && !sidebar && current?.circle_slug) sidebar = catalog.results?.find((circle: any) => circle.slug === current.circle_slug) || null
  if (mode === 'independent' && catalog.results?.length) {
    const rotationIndex = Math.floor(Date.now() / 12000) % catalog.results.length
    sidebar = catalog.results[rotationIndex]
  }
  return { state, day, now: nowJst(), current, next, current_index: scheduledIndex, gap_seconds: gapSeconds, break_key: breakKey, playlist, notices: notices.results || [], sidebar, sidebar_mode: mode }
}

app.get('/', asset('admin.html'))
app.get('/admin', asset('admin.html'))
app.get('/admin.html', asset('admin.html'))
app.get('/broadcast', (c) => c.html(broadcastHtml))
app.get('/broadcast.html', (c) => c.html(broadcastHtml))
app.get('/api/health', (c) => c.json({ ok: true, storage: 'SQLite', mediaUploads: false, obs: 'local-websocket' }))
app.get('/api/obs/status', async (c) => c.json(await obs.status()))
app.get('/api/obs/config', (c) => c.json(obs.connectionSettings()))
app.post('/api/obs/config', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  try {
    const password = typeof body.password === 'string' ? body.password : undefined
    return c.json(await obs.updateConnectionSettings(int(body.port, 4455, 1, 65535), password, Boolean(body.clear_password)))
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400) }
})
app.get('/api/obs/scenes', async (c) => {
  try { return c.json({ scenes: await obs.scenes() }) }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 503) }
})
app.post('/api/obs/scene', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  try { const result = await obs.switchScene(text(body.scene_name, 120)); const mode = body.mode === 'cm' ? 'cm' : 'program'; await db.prepare('UPDATE signage_state SET current_scene_mode=?,updated_at=CURRENT_TIMESTAMP WHERE id=1').bind(mode).run(); if (mode === 'cm') { cmGeneration += 1; if (cmTimer) clearTimeout(cmTimer); cmTimer = undefined; await playNextCm() } else await stopCmQueue(); return c.json(result) }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400) }
})
app.post('/api/obs/text', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  const source = text(body.source, 120); const value = text(body.text, 4000)
  if (!source) return c.json({ error: 'OBSテキストソース名を入力してください。' }, 400)
  try { await obs.setText(source, value); return c.json({ success: true }) }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400) }
})
app.post('/api/obs/publish', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const screen = await screenData(db)
  const current = screen.current
  const next = screen.next
  const configured = [
    [process.env.OBS_TEXT_SOURCE || 'telop', [current?.title, current?.class_name, current?.description].filter(Boolean).join('\n')],
    [process.env.OBS_NEXT_SOURCE || '', next ? `${next.adjusted_start || next.scheduled_start}  ${next.title}` : ''],
    [process.env.OBS_NOTICE_SOURCE || '', screen.notices.filter((notice: any) => notice.is_active).map((notice: any) => notice.text).join('\n')],
  ] as const
  try { return c.json(await obs.publishText(Object.fromEntries(configured))) }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400) }
})

app.get('/api/broadcast-state', async (c) => {
  const screen = await screenData(db)
  return c.json({ now: screen.now, current: screen.current, next: screen.next, notices: screen.notices, sidebar: screen.sidebar, sidebar_mode: screen.sidebar_mode })
})

app.get('/api/state', async (c) => {
  const screen = await screenData(db)
  return c.json({ state: screen.state, timetable: await loadPrograms(db, screen.day), playback: screen })
})

app.get('/api/timetable', async (c) => {
  const day = int(c.req.query('day'), 1, 1, 7)
  return c.json(await loadPrograms(db, day))
})

app.post('/api/timetable/import', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  const rows = parseCsv(text(body.csv, 1_000_000))
  const day = int(body.day, 1, 1, 7)
  const overwrite = Boolean(body.overwrite)
  if (!rows.length) return c.json({ error: 'CSVにデータ行がありません。' }, 400)
  const programs = rows.map((row, index) => {
    const title = text(csvValue(row, 'title', '企画名'), 200)
    const description = text(csvValue(row, 'description', '説明', '企画説明'), 2000)
    const scheduled = padTime(csvValue(row, 'scheduled_start', 'start_time', '開始時間', '開始時刻'))
    const adjusted = padTime(csvValue(row, 'adjusted_start', 'adjusted_start_time', '変更後開始時間', '変更後開始時刻'))
    const end = padTime(csvValue(row, 'end_time', '終了時間', '終了時刻'))
    const kind = text(csvValue(row, 'kind', 'type', '区分'), 24).toLowerCase()
    const className = text(csvValue(row, 'class_name', 'class', 'クラス名'), 80)
    const circleSlug = text(csvValue(row, 'circle_slug', 'slug', 'サークルslug'), 120)
    const mediaPath = text(csvValue(row, 'media_path', 'video_path', '映像パス'), 500)
    const startMinutes = timeToMinutes(adjusted || scheduled)
    if (!title || startMinutes < 0 || (end && timeToMinutes(end) <= startMinutes)) throw new Error(`${index + 2}行目: 企画名と開始時刻を確認してください。`)
    return { title, description, scheduled_start: scheduled, adjusted_start: adjusted, end_time: end || adjusted || scheduled, kind: ['break', 'cm', '幕間'].includes(kind) ? 'break' : 'program', class_name: className, circle_slug: circleSlug, media_path: mediaPath, startMinutes }
  })
  const sorted = [...programs].sort((a, b) => timeToMinutes(a.adjusted_start || a.scheduled_start) - timeToMinutes(b.adjusted_start || b.scheduled_start))
  for (let index = 1; index < sorted.length; index += 1) if (sorted[index].startMinutes === sorted[index - 1].startMinutes) return c.json({ error: `開始時刻が重複しています: ${sorted[index - 1].title} / ${sorted[index].title}` }, 400)
  const current = await loadPrograms(db, day)
  if (!overwrite && current.length) return c.json({ error: 'この日の企画データがあります。上書きする場合は確認欄を選択してください。' }, 409)
  const statements: LocalStatement[] = []
  if (overwrite) statements.push(db.prepare('DELETE FROM programs WHERE day = ?').bind(day))
  for (const [order, item] of sorted.entries()) statements.push(db.prepare(`
    INSERT INTO programs (day, title, description, scheduled_start, adjusted_start, end_time, kind, class_name, circle_slug, media_path, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(day, item.title, item.description, item.scheduled_start, item.adjusted_start, item.end_time, item.kind, item.class_name, item.circle_slug, item.media_path, order))
  await db.batch(statements)
  return c.json({ success: true, count: sorted.length })
})

app.post('/api/timetable', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  const day = int(body.day, 1, 1, 7)
  const start = padTime(text(body.scheduled_start || body.start_time, 10))
  const adjusted = padTime(text(body.adjusted_start, 10))
  const end = padTime(text(body.end_time, 10))
  if (!text(body.title, 200) || timeToMinutes(start) < 0 || (end && timeToMinutes(end) <= timeToMinutes(adjusted || start))) return c.json({ error: '企画名と開始時刻を確認してください。' }, 400)
  const result = await db.prepare(`INSERT INTO programs (day,title,description,scheduled_start,adjusted_start,end_time,kind,class_name,circle_slug,media_path)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(day, text(body.title, 200), text(body.description, 2000), start, adjusted, end || adjusted || start, body.kind === 'break' ? 'break' : 'program', text(body.class_name, 80), text(body.circle_slug, 120), text(body.media_path, 500)).run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

app.post('/api/timetable/update', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  const scheduledStart = padTime(body.scheduled_start || body.start_time)
  const adjustedStart = padTime(body.adjusted_start)
  const endTime = padTime(body.end_time) || adjustedStart || scheduledStart
  await db.prepare(`UPDATE programs SET title=?,description=?,scheduled_start=?,adjusted_start=?,end_time=?,kind=?,class_name=?,circle_slug=?,media_path=? WHERE id=?`)
    .bind(text(body.title, 200), text(body.description, 2000), scheduledStart, adjustedStart, endTime, body.kind === 'break' ? 'break' : 'program', text(body.class_name, 80), text(body.circle_slug, 120), text(body.media_path, 500), int(body.id)).run()
  return c.json({ success: true })
})

app.post('/api/timetable/delete', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>(); await db.prepare('DELETE FROM programs WHERE id=?').bind(int(body.id)).run(); return c.json({ success: true })
})

app.get('/api/catalog', async (c) => {
  const result = await db.prepare('SELECT * FROM circle_catalog WHERE is_active=1 ORDER BY display_order,name').all()
  return c.json(result.results || [])
})

app.post('/api/catalog/sync', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  const records = (Array.isArray(body.records) ? body.records : []).slice(0, 300) as CatalogRecord[]
  if (!records.length) return c.json({ error: 'カタログデータがありません。' }, 400)
  const statements = records.filter(item => item.slug && item.name).map((item, index) => db.prepare(`
    INSERT INTO circle_catalog (slug,name,kind,class_name,group_name,description,program_description,circle_cut_path,circle_cut_alt,source_url,display_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET name=excluded.name,kind=excluded.kind,class_name=excluded.class_name,group_name=excluded.group_name,
      description=excluded.description,program_description=excluded.program_description,circle_cut_path=excluded.circle_cut_path,circle_cut_alt=excluded.circle_cut_alt,source_url=excluded.source_url,display_order=excluded.display_order,updated_at=CURRENT_TIMESTAMP
  `).bind(text(item.slug, 120), text(item.name, 200), item.kind === 'class' ? 'class' : 'circle', text(item.class_name, 80), text(item.group_name, 80), text(item.description, 1600), text(item.program_description, 2400), text(item.circle_cut_path, 800), text(item.circle_cut_alt, 500), text(item.source_url, 800), index))
  for (let index = 0; index < statements.length; index += 80) await db.batch(statements.slice(index, index + 80))
  return c.json({ success: true, count: statements.length })
})

app.post('/api/catalog/update', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  await db.prepare(`UPDATE circle_catalog SET preference_score=?,display_order=?,is_active=? WHERE slug=?`)
    .bind(int(body.preference_score, 0, -10, 10), int(body.display_order, 0, 0, 9999), body.is_active ? 1 : 0, text(body.slug, 120)).run()
  return c.json({ success: true })
})

app.get('/api/commercials', async (c) => {
  const result = await db.prepare(`SELECT cm.*, cc.name AS circle_name FROM commercials cm LEFT JOIN circle_catalog cc ON cc.slug=cm.circle_slug ORDER BY cm.is_active DESC, cm.id DESC`).all()
  return c.json(result.results || [])
})

app.post('/api/commercials', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  const title = text(body.title, 200); const mediaPath = text(body.media_path, 500)
  if (!title || !mediaPath || /^(data:|https?:\/\/)/i.test(mediaPath)) return c.json({ error: 'CM名とPC上の相対パスを入力してください。アップロードやURL登録はできません。' }, 400)
  const result = await db.prepare(`INSERT INTO commercials (title,circle_slug,media_path,duration_seconds,preference_score,max_per_break,is_active)
    VALUES (?,?,?,?,?,?,?)`).bind(title,text(body.circle_slug,120),mediaPath,int(body.duration_seconds,15,1,3600),int(body.preference_score,0,-10,10),int(body.max_per_break,1,1,20),body.is_active===false?0:1).run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

app.post('/api/commercials/update', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  const mediaPath = text(body.media_path, 500)
  if (/^(data:|https?:\/\/)/i.test(mediaPath)) return c.json({ error: 'ローカルPCの相対パスを登録してください。' }, 400)
  await db.prepare(`UPDATE commercials SET title=?,circle_slug=?,media_path=?,duration_seconds=?,preference_score=?,max_per_break=?,is_active=? WHERE id=?`)
    .bind(text(body.title,200),text(body.circle_slug,120),mediaPath,int(body.duration_seconds,15,1,3600),int(body.preference_score,0,-10,10),int(body.max_per_break,1,1,20),body.is_active?1:0,int(body.id)).run()
  return c.json({ success: true })
})

app.post('/api/commercials/delete', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>(); await db.prepare('DELETE FROM commercials WHERE id=?').bind(int(body.id)).run(); return c.json({ success: true })
})

app.post('/api/commercials/:id/play', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const id = int(c.req.param('id'))
  const breakKey = text(c.req.query('break') || '', 120)
  await db.batch([
    db.prepare('UPDATE commercials SET play_count=play_count+1,last_played_at=CURRENT_TIMESTAMP WHERE id=?').bind(id),
    db.prepare('INSERT INTO playback_history (commercial_id,break_key) VALUES (?,?)').bind(id, breakKey),
  ])
  return c.json({ success: true })
})

app.get('/api/announcements', async (c) => {
  const result = await db.prepare('SELECT * FROM announcements ORDER BY is_active DESC,is_emergency DESC,display_order ASC,id DESC').all()
  return c.json(result.results || [])
})

app.post('/api/announcements', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>(); const message = text(body.text, 1600)
  if (!message) return c.json({ error: 'お知らせ文を入力してください。' }, 400)
  const result = await db.prepare('INSERT INTO announcements (text,category,is_emergency,is_active) VALUES (?,?,?,?)')
    .bind(message,text(body.category || 'お知らせ',50),body.is_emergency?1:0,body.is_active===false?0:1).run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

app.post('/api/announcements/update', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  await db.prepare('UPDATE announcements SET text=?,category=?,is_emergency=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(text(body.text,1600),text(body.category || 'お知らせ',50),body.is_emergency?1:0,body.is_active?1:0,int(body.id)).run()
  return c.json({ success: true })
})

app.post('/api/announcements/delete', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>(); await db.prepare('DELETE FROM announcements WHERE id=?').bind(int(body.id)).run(); return c.json({ success: true })
})

app.get('/api/settings', async (c) => c.json(await db.prepare('SELECT * FROM signage_state WHERE id=1').first() || {}))
app.post('/api/settings', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const body = await c.req.json<any>()
  const updates: string[] = []
  const values: unknown[] = []
  const fields: Record<string, unknown> = {
    current_day: body.current_day === undefined ? undefined : int(body.current_day, 1, 1, 7),
    sidebar_mode: body.sidebar_mode === undefined ? undefined : (body.sidebar_mode === 'independent' ? 'independent' : 'sync'),
    wait_cm: body.wait_cm === undefined ? undefined : (body.wait_cm ? 1 : 0),
    delay_minutes: body.delay_minutes === undefined ? undefined : int(body.delay_minutes, 0, -180, 720),
  }
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) { updates.push(`${key}=?`); values.push(value) }
  if (updates.length) await db.prepare(`UPDATE signage_state SET ${updates.join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=1`).bind(...values).run()
  return c.json({ success: true })
})

app.get('/api/playback', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  return c.json(await screenData(db))
})


app.post('/api/backups', async (c) => {
  const denied = await requireAdmin(c); if (denied) return denied
  const tables = ['signage_state','programs','circle_catalog','commercials','announcements']
  const snapshot: Record<string, unknown> = { created_at: new Date().toISOString(), media_policy: 'Local paths and text only; no media bytes.' }
  for (const table of tables) snapshot[table] = (await db.prepare(`SELECT * FROM ${table}`).all()).results
  const body = JSON.stringify(snapshot, null, 2)
  const directory = resolve(process.env.SIGNAGE_BACKUP_DIR || './data/backups')
  mkdirSync(directory, { recursive: true })
  const filename = resolve(directory, `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(filename, body, 'utf8')
  await db.prepare('INSERT INTO backup_log (local_path,byte_size) VALUES (?,?)').bind(filename, Buffer.byteLength(body)).run()
  return c.json({ success: true, key: filename, byte_size: Buffer.byteLength(body) })
})
app.get('/api/backups', async (c) => c.json((await db.prepare('SELECT id,local_path,created_at,byte_size FROM backup_log ORDER BY id DESC LIMIT 10').all()).results))

return app
}

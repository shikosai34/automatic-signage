import type { LocalDatabase } from './database.js'

const demoPrograms = [
  ['【デモ】オープニング', '進行画面の表示確認用サンプルです。実際の企画情報ではありません。', '09:00', '09:15', 'program', '放送テスト', '1-1'],
  ['【デモ】企画 A', '企画タイトル、説明、団体表示を確認できます。', '09:15', '09:30', 'program', '表示確認', '1-2'],
  ['【デモ】休憩・CM', 'CMシーンとローカル動画の設定確認用サンプルです。', '09:30', '09:40', 'break', '', '1-3'],
  ['【デモ】企画 B', 'タイムラインからこの企画の設定をすぐ開けます。', '09:40', '10:00', 'program', '表示確認', '1-4'],
  ['【デモ】企画 C', '開始時刻と変更後時刻の表示確認用サンプルです。', '10:00', '10:15', 'program', '放送テスト', '1-5'],
  ['【デモ】休憩・CM 2', 'お知らせとサークルカットの表示確認用サンプルです。', '10:15', '10:30', 'break', '', '2-1'],
  ['【デモ】エンディング', '実運用前に実際の進行表へ置き換えてください。', '10:30', '10:45', 'program', '表示確認', '2-2'],
] as const

const demoCommercials = [
  ['【デモ】サンプルCM 1', 'mov_hts-samp001.mp4', '1-1'],
  ['【デモ】サンプルCM 2', 'mov_hts-samp003.mp4', '1-2'],
  ['【デモ】サンプルCM 3', 'sample-5.mp4', '1-3'],
] as const

export async function seedDemoDataIfEmpty(db: LocalDatabase) {
  const existingPrograms = await db.prepare('SELECT id FROM programs LIMIT 1').all()
  const existingCommercials = await db.prepare('SELECT id FROM commercials LIMIT 1').all()
  const existingAnnouncements = await db.prepare('SELECT id FROM announcements LIMIT 1').all()

  let programs = 0
  let commercials = 0
  let announcements = 0

  if (!existingPrograms.results.length) {
    const statements = demoPrograms.map(([title, description, scheduledStart, endTime, kind, className, circleSlug], displayOrder) => db.prepare(`
      INSERT INTO programs (day,title,description,scheduled_start,adjusted_start,end_time,kind,class_name,circle_slug,display_order,is_demo)
      VALUES (1,?,?,?,?,?,?,?,?,?,?)
    `)
      .bind(title, description, scheduledStart, '', endTime, kind, className, circleSlug, displayOrder, 1))
    await db.batch(statements)
    programs = statements.length
  }

  if (!existingCommercials.results.length) {
    const statements = demoCommercials.map(([title, mediaPath, circleSlug]) => db.prepare(`
      INSERT INTO commercials (title,circle_slug,media_path,duration_seconds,preference_score,max_per_break,is_active)
      VALUES (?,?,?,15,0,1,0)
    `).bind(title, circleSlug, mediaPath))
    await db.batch(statements)
    commercials = statements.length
  }

  if (!existingAnnouncements.results.length) {
    await db.prepare(`INSERT INTO announcements (text,category,is_emergency,is_active)
      VALUES (?,?,0,0)`).bind('【デモ】長文表示の確認用です。実際のお知らせを入力すると、画面に収まりきらない文章は自動で2列に分けて表示します。配信中に変更した内容もOBS画面へすぐ反映されます。', 'デモ').run()
    announcements = 1
  }

  return { programs, commercials, announcements }
}

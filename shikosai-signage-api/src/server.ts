import { serve } from '@hono/node-server'
import { openDatabase } from './database.js'
import { seedCatalogIfEmpty } from './catalog-seed.js'
import { seedDemoDataIfEmpty } from './demo-seed.js'
import { createApp } from './index.js'
import { ObsController } from './obs.js'

const port = Number(process.env.PORT || 8787)
const host = '127.0.0.1'
const { db, close } = openDatabase()
const obs = new ObsController()
const seeded = await seedCatalogIfEmpty(db)
if (seeded) console.log(`公式サイト取得済み団体データ ${seeded}件を初期登録しました。`)
const demo = await seedDemoDataIfEmpty(db)
if (demo.programs || demo.commercials || demo.announcements) {
  console.log(`安全な表示確認用デモを登録しました（企画 ${demo.programs}件、CM ${demo.commercials}件、お知らせ ${demo.announcements}件）。`)
}
const app = createApp(db, obs)
const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`茨香祭 配信進行管理: http://${host}:${info.port}/admin`)
  console.log('ローカルSQLiteとOBS WebSocketを使用します。外部公開アドレスにはbindしません。')
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close()
    close()
    process.exit(0)
  })
}

import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export type LocalStatement = {
  bind(...values: unknown[]): LocalStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { last_row_id: number; changes: number } }>
}
export type LocalDatabase = {
  prepare(sql: string): LocalStatement
  batch(statements: LocalStatement[]): Promise<unknown[]>
}

export function openDatabase() {
  const filename = resolve(process.env.SIGNAGE_DB_PATH || './data/signage.sqlite')
  mkdirSync(dirname(filename), { recursive: true })
  const sqlite = new Database(filename)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  const migrationDirectory = resolve(import.meta.dirname, '../migrations')
  const migrationFiles = ['0001_local_signage.sql', '0002_manual_obs_scene.sql', '0003_demo_programs.sql', '0004_cm_target_program.sql']
  for (const name of migrationFiles) {
    const applied = sqlite.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)
    if (applied) continue
    if (name === '0002_manual_obs_scene.sql') {
      const columns = sqlite.pragma('table_info(signage_state)') as Array<{ name: string }>
      if (columns.some((column) => column.name === 'current_scene_mode')) {
        sqlite.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name)
        continue
      }
    }
    const source = readFileSync(resolve(migrationDirectory, name), 'utf8')
    sqlite.transaction(() => {
      sqlite.exec(source)
      sqlite.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name)
    })()
  }

  const adapter: LocalDatabase = {
    prepare(sql) {
      let values: unknown[] = []
      const statement: LocalStatement = {
        bind(...next) { values = next; return statement },
        async first<T>() { return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null },
        async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[] } },
        async run() {
          const result = sqlite.prepare(sql).run(...values)
          return { meta: { last_row_id: Number(result.lastInsertRowid), changes: result.changes } }
        },
      }
      return statement
    },
    async batch(statements) {
      const results = sqlite.transaction(() => statements.map((statement) => statement.run()))()
      return Promise.all(results)
    },
  }
  return { db: adapter, close: () => sqlite.close() }
}

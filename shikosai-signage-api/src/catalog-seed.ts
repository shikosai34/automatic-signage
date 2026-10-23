import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { LocalDatabase } from './database.js'

type CatalogRecord = {
  slug: string; name: string; kind?: string; class_name?: string; group_name?: string
  description?: string; program_description?: string; circle_cut_path?: string
  circle_cut_alt?: string; source_url?: string
}

export async function seedCatalogIfEmpty(db: LocalDatabase) {
  const { results } = await db.prepare('SELECT slug FROM circle_catalog LIMIT 1').all()
  if (results.length) return 0
  const file = resolve(import.meta.dirname, '../../seed/shikosai-catalog.json')
  const catalog = JSON.parse(readFileSync(file, 'utf8')) as { records?: CatalogRecord[] }
  const records = catalog.records || []
  const statements = records.filter((record) => record.slug && record.name).map((record, index) => db.prepare(`
    INSERT INTO circle_catalog (slug,name,kind,class_name,group_name,description,program_description,circle_cut_path,circle_cut_alt,source_url,display_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).bind(record.slug, record.name, record.kind === 'class' ? 'class' : 'circle', record.class_name || '', record.group_name || '', record.description || '', record.program_description || '', record.circle_cut_path || '', record.circle_cut_alt || '', record.source_url || '', index))
  await db.batch(statements)
  return statements.length
}

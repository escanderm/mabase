// Миграции (design.md §15): mb_migrations/YYYYMMDDHHMM-имя.ts с up(db).
// Применённые - в _migrations; down нет: откат - это новая миграция.
//
// Каждая миграция - одна транзакция: упала посреди - в базе её нет, и
// отметка о применении не ставится. Порядок - по имени файла.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATIONS, type CollectionApi, type Db } from './db'

export type MigrationDb = Record<string, CollectionApi>
export type Migration = { name: string; up: (db: MigrationDb) => unknown }

const NAME = /^\d{12}-[\w.-]+\.ts$/

export async function loadMigrations(dir: string): Promise<Migration[]> {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir)
  const wrong = files.filter((f) => f.endsWith('.ts') && !NAME.test(f))
  if (wrong.length) {
    throw new Error(`миграции: имя файла - YYYYMMDDHHMM-имя.ts, а не ${wrong.map((f) => `"${f}"`).join(', ')}`)
  }
  const out: Migration[] = []
  for (const file of files.filter((f) => NAME.test(f)).sort()) {
    const mod = await import(join(dir, file))
    const up = mod.up ?? mod.default
    if (typeof up !== 'function') throw new Error(`миграция ${file}: нужен export function up(db)`)
    out.push({ name: file, up })
  }
  return out
}

export async function appliedMigrations(db: Db): Promise<string[]> {
  return (await db.c[MIGRATIONS]!.find({}, { sort: { _id: 1 }, fields: ['_id'] })).map((d) => d._id)
}

// Применить недостающие. Возвращает имена применённых и сколько пропущено.
export async function applyMigrations(db: Db, list: Migration[], opts: { onApply?: (name: string) => void } = {}): Promise<{ applied: string[]; skipped: number }> {
  const done = new Set(await appliedMigrations(db))
  const applied: string[] = []
  for (const m of list) {
    if (done.has(m.name)) continue
    await db.transaction(
      async (tx) => {
        await m.up(tx.c)
        await tx.c[MIGRATIONS]!.insert({ _id: m.name, at: Date.now() })
      },
      { origin: 'migration' },
    )
    applied.push(m.name)
    opts.onApply?.(m.name)
  }
  return { applied, skipped: list.length - applied.length }
}

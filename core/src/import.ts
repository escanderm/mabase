// Импорт NDJSON (mabase import): пачками по 1000 документов в транзакции,
// мимо правил, хуки работают. Документ с _id, который уже есть, пропускается:
// повторный импорт безопасен. Ошибка в пачке отменяет её; сохранённые пачки
// остаются (design.md §15).
import type { Db, Doc } from './db'
import { ActionError } from './errors'

const BATCH = 1000

export async function importNdjson(db: Db, collection: string, text: string): Promise<{ inserted: number; skipped: number }> {
  const lines = text.split('\n')
  let inserted = 0
  let skipped = 0
  let batch: Array<{ line: number; doc: Doc }> = []
  const flush = async () => {
    const docs = batch
    batch = []
    await db.transaction(async (tx) => {
      for (const { doc } of docs) {
        if (typeof doc._id === 'string' && (await tx.c[collection]!.findOne({ _id: doc._id }, { fields: ['_id'] }))) skipped++
        else {
          await tx.c[collection]!.insert(doc)
          inserted++
        }
      }
    })
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue
    let doc: Doc
    try {
      doc = JSON.parse(lines[i]!)
    } catch {
      throw new ActionError('bad_request', `строка ${i + 1}: не JSON`)
    }
    batch.push({ line: i + 1, doc })
    if (batch.length >= BATCH) await flush()
  }
  if (batch.length) await flush()
  return { inserted, skipped }
}

// expand: связанные документы прямо в ответе - doc._expand.<поле>. Одна
// связь - документ или null, many - массив найденных (в порядке _id в поле).
// Кто и что видит - решает load: у клиента через правило view той
// коллекции, у админки - всё.
import type { Doc, Relation } from './db'
import { ActionError } from './errors'

export const MAX_EXPAND = 10

export async function expandDocs(
  docs: Doc[],
  fields: string[],
  relations: Record<string, Required<Relation>>,
  load: (to: string, ids: string[]) => Promise<Doc[]>,
): Promise<void> {
  if (fields.length > MAX_EXPAND) throw new ActionError('bad_request', `expand: не больше ${MAX_EXPAND} полей`)
  for (const field of fields) {
    const rel = relations[field]
    if (!rel) throw new ActionError('bad_request', `expand: ${field} - не связь`)
    const ids = new Set<string>()
    for (const d of docs) for (const id of refsOf(d, field, rel)) ids.add(id)
    const found = new Map((ids.size ? await load(rel.to, [...ids]) : []).map((d) => [d._id, d]))
    for (const d of docs) {
      const ex = ((d as any)._expand ??= {})
      ex[field] = rel.many ? refsOf(d, field, rel).flatMap((id) => (found.has(id) ? [found.get(id)!] : [])) : (found.get(d[field]) ?? null)
    }
  }
}

function refsOf(d: Doc, field: string, rel: Required<Relation>): string[] {
  const v = d[field]
  if (rel.many) return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return typeof v === 'string' ? [v] : []
}

// ?expand=a,b из адреса
export function parseExpand(v: string | null): string[] | undefined {
  if (!v) return undefined
  return v.split(',').map((x) => x.trim()).filter(Boolean)
}

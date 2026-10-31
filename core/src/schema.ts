// Схема коллекции - zod, необязательная (design.md §8). Проверяется только при
// записи: старые документы после смены схемы читаются как есть.
import type { z } from 'zod'
import { DefinitionError, ValidationError } from './errors'
import { SYSTEM_FIELDS, type Doc } from './query'

export type Schema = z.ZodType<Record<string, unknown>>

// Тип поля по пути внутри схемы. Обёртки (optional, nullable, default) снимаются.
function typeAt(schema: z.ZodType, parts: string[]): string | null {
  let cur: any = schema
  let i = 0
  while (cur) {
    const def = cur._zod?.def
    if (!def) return null
    switch (def.type) {
      case 'optional':
      case 'nullable':
      case 'default':
      case 'prefault':
      case 'readonly':
      case 'catch':
      case 'nonoptional':
        cur = def.innerType
        continue
      case 'pipe':
        cur = def.in
        continue
      case 'array':
        cur = def.element // индекс по массиву - по его элементам
        continue
      case 'object':
        if (i === parts.length) return 'object'
        cur = def.shape[parts[i++]!]
        continue
      default:
        return i === parts.length ? def.type : null
    }
  }
  return null
}

const NOT_INDEXABLE = new Set(['object', 'record', 'map', 'set', 'date', 'tuple'])

export function checkIndexes(collection: string, schema: Schema | undefined, indexes: string[]): void {
  for (const field of indexes) {
    if (field === '_id') throw new DefinitionError(`${collection}: индекс по _id есть всегда, объявлять не нужно`)
    if (!schema) continue
    const t = typeAt(schema, field.split('.'))
    if (t && NOT_INDEXABLE.has(t)) {
      throw new DefinitionError(
        `${collection}: индекс на поле ${field} типа ${t} не поддерживается. ` +
          'Индекс - на строку, число, булево или массив из них; на вложенное поле - через точку',
      )
    }
  }
}

// Проверить документ схемой. Возвращает то, что отдал zod (с умолчаниями и без
// лишних полей), плюс служебные поля.
// legacy - документ до обновления: поля, которых схема не знает, но которые в
// нём уже были, не удаляются. Иначе первый же update старого документа молча
// срезал бы всё, чего нет в новой схеме (design.md §8: «перестаёт
// проверяться», а не «исчезает»). Новые поля вне схемы по-прежнему не
// появляются - только те, что были.
export function validateDoc(collection: string, schema: Schema, doc: Doc, legacy?: Doc): Doc {
  const body: Record<string, unknown> = { ...doc }
  for (const f of SYSTEM_FIELDS) delete body[f]
  const r = schema.safeParse(body)
  if (!r.success) throw new ValidationError(collection, r.error.issues.map((i) => ({ path: i.path, message: i.message })))
  const out: Record<string, unknown> = { ...(r.data as object) }
  if (legacy) for (const [k, v] of Object.entries(body)) if (!(k in out) && Object.hasOwn(legacy, k)) out[k] = v
  return { ...out, _id: doc._id, _createdAt: doc._createdAt, _updatedAt: doc._updatedAt }
}

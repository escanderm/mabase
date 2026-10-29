// Порядок значений - как в Mongo: null и отсутствующее < числа < строки <
// объекты < булевы. Один и тот же порядок у индекса и у сортировки в памяти,
// иначе ответ зависел бы от того, нашёлся ли индекс.
import { QueryError } from './errors'
import { pathValues, type Doc } from './query'

export type Dir = 1 | -1
export type SortSpec = Array<[path: string, dir: Dir]>

export function rank(v: unknown): number {
  if (v === null || v === undefined) return 0
  switch (typeof v) {
    case 'number':
      return 1
    case 'string':
      return 2
    case 'boolean':
      return 4
    default:
      return 3 // объекты и вложенные массивы: между собой равны, дальше решает _id
  }
}

export function compareValues(a: unknown, b: unknown): number {
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  if (ra === 0 || ra === 3) return 0
  return (a as any) < (b as any) ? -1 : (a as any) > (b as any) ? 1 : 0
}

export const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Ключ сортировки поля-массива - как в Mongo: по возрастанию наименьший
// элемент, по убыванию наибольший.
export function sortKey(doc: Doc, parts: readonly string[], dir: Dir): unknown {
  const vals = pathValues(doc, parts)
  let best = vals[0]
  for (let i = 1; i < vals.length; i++) {
    const c = compareValues(vals[i], best)
    if (dir === 1 ? c < 0 : c > 0) best = vals[i]
  }
  return best
}

export function parseSort(sort: Record<string, unknown> | undefined): SortSpec {
  if (!sort) return []
  const spec: SortSpec = []
  for (const [path, dir] of Object.entries(sort)) {
    if (dir !== 1 && dir !== -1) throw new QueryError(`sort.${path}: нужно 1 или -1`)
    spec.push([path, dir])
  }
  return spec
}

// Без сортировки - по _id. Последний ключ всегда _id: при равных значениях
// порядок стабилен, и на нём держится курсорная пагинация.
export function normalizeSort(spec: SortSpec): SortSpec {
  if (spec.length === 0) return [['_id', 1]]
  if (spec.some(([p]) => p === '_id')) return spec.slice(0, spec.findIndex(([p]) => p === '_id') + 1)
  return [...spec, ['_id', spec[0]![1]]]
}

export function comparator(spec: SortSpec): (a: Doc, b: Doc) => number {
  const keys = spec.map(([path, dir]) => ({ path, parts: path.split('.'), dir }))
  return (a, b) => {
    for (const { path, parts, dir } of keys) {
      const c = path === '_id' ? compareIds(a._id, b._id) : compareValues(sortKey(a, parts, dir), sortKey(b, parts, dir))
      if (c !== 0) return c * dir
    }
    return 0
  }
}

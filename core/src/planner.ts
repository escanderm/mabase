// Планировщик запросов (design.md §8). Простой:
// 1. Из условий верхнего уровня (и $and) выбрать самый узкий источник:
//    равенство или $in по индексу, диапазон по индексу, или все документы.
//    Границы по _id (курсор) режут списки двоичным поиском.
// 2. Если источник уже отдаёт нужный порядок - идти по нему и остановиться на
//    limit. Иначе собрать всё подходящее и отсортировать в памяти.
// 3. Остаток фильтра проверяет sift. Индекс отдаёт только кандидатов.
import { FieldIndex, isRangeBound, sliceByIds, type Bound, type IdBounds } from './indexes'
import { comparator, normalizeSort, parseSort, type Dir, type SortSpec } from './order'
import { compileQuery, type Doc, type Query } from './query'
import { QueryError } from './errors'

export type CollState = {
  docs: Map<string, Doc>
  ids: string[] // все _id коллекции по порядку
  indexes: Map<string, FieldIndex>
}

export type FindOptions = {
  sort?: Record<string, 1 | -1>
  limit?: number
  fields?: string[]
  // Сколько документов можно проверить sift-ом. Больше - QueryError. Для
  // запросов клиента: широкий запрос без индекса не вешает единственный процесс.
  maxScanned?: number
}

export type Explain = {
  plan: string // откуда взяли кандидатов
  scanned: number // сколько документов проверил sift
  sortedInMemory: boolean
}

type Plan =
  | { kind: 'lists'; name: string; lists: Array<readonly string[]>; cost: number }
  | { kind: 'range'; name: string; index: FieldIndex; keys: FieldIndex['keys']; cost: number }
  | { kind: 'scan'; name: string; cost: number }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof RegExp)

const isEqScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v)

function conjuncts(q: Query, out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  for (const [k, v] of Object.entries(q)) {
    if (k === '$and') for (const sub of v as Query[]) conjuncts(sub, out)
    else if (k !== '$or') out.push([k, v])
  }
  return out
}

function eqValues(cond: unknown): unknown[] | null {
  if (isEqScalar(cond)) return [cond]
  if (!isPlainObject(cond)) return null
  if ('$eq' in cond && isEqScalar(cond.$eq)) return [cond.$eq]
  if (Array.isArray(cond.$in) && cond.$in.every(isEqScalar)) return cond.$in
  return null
}

function rangeBounds(cond: unknown): { lo?: Bound; hi?: Bound } | null {
  if (!isPlainObject(cond)) return null
  const r: { lo?: Bound; hi?: Bound } = {}
  if (isRangeBound(cond.$gt)) r.lo = { v: cond.$gt, incl: false }
  if (isRangeBound(cond.$gte)) r.lo = { v: cond.$gte, incl: true }
  if (isRangeBound(cond.$lt)) r.hi = { v: cond.$lt, incl: false }
  if (isRangeBound(cond.$lte)) r.hi = { v: cond.$lte, incl: true }
  return r.lo || r.hi ? r : null
}

function idBoundsOf(conds: Array<[string, unknown]>): IdBounds {
  const b: IdBounds = {}
  for (const [path, cond] of conds) {
    if (path !== '_id' || !isPlainObject(cond)) continue
    for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
      const v = cond['$' + op]
      if (typeof v === 'string') b[op] = v
    }
  }
  return b
}

const slicedLength = (list: readonly string[], b: IdBounds) => {
  const [from, to] = sliceByIds(list, b)
  return to - from
}

function choosePlan(state: CollState, conds: Array<[string, unknown]>, bounds: IdBounds): Plan[] {
  const plans: Plan[] = [{ kind: 'scan', name: 'все документы', cost: slicedLength(state.ids, bounds) }]
  let best = plans[0]!.cost

  for (const [path, cond] of conds) {
    const eq = eqValues(cond)
    if (path === '_id') {
      if (eq && eq.every((v) => typeof v === 'string')) {
        const ids = [...new Set(eq as string[])].filter((id) => state.docs.has(id)).sort()
        const cost = slicedLength(ids, bounds)
        plans.push({ kind: 'lists', name: '_id', lists: [ids], cost })
        best = Math.min(best, cost)
      }
      continue
    }
    const index = state.indexes.get(path)
    if (!index) continue
    if (eq) {
      const lists = eq.map((v) => index.eq(v)).filter((l) => l.length > 0)
      const cost = lists.reduce((s, l) => s + slicedLength(l, bounds), 0)
      plans.push({ kind: 'lists', name: `индекс ${path} =`, lists, cost })
      best = Math.min(best, cost)
      continue
    }
    const r = rangeBounds(cond)
    if (r) {
      // У поля-массива условия проверяются по элементам отдельно:
      // [1, 20] подходит под { $gt: 15, $lt: 5 }. Поэтому только одна граница.
      const keys = index.range(r.lo, index.multikey && r.lo ? undefined : r.hi)
      let cost = 0
      for (const k of keys) {
        cost += index.lists.get(k.k)!.length
        if (cost > best) break
      }
      plans.push({ kind: 'range', name: `индекс ${path} диапазон`, index, keys, cost })
      best = Math.min(best, cost)
    }
  }
  return plans
}

// Список id в порядке источника. dir - направление по _id или по значению поля.
function* iterate(plan: Plan, state: CollState, bounds: IdBounds, dir: Dir): Generator<string> {
  if (plan.kind === 'scan' || (plan.kind === 'lists' && plan.lists.length === 1)) {
    const list = plan.kind === 'scan' ? state.ids : plan.lists[0]!
    const [from, to] = sliceByIds(list, bounds)
    if (dir === 1) for (let i = from; i < to; i++) yield list[i]!
    else for (let i = to - 1; i >= from; i--) yield list[i]!
    return
  }
  if (plan.kind === 'lists') {
    // слияние нескольких отсортированных списков ($in); один id в двух списках - один раз
    const cur = plan.lists.map((l) => {
      const [from, to] = sliceByIds(l, bounds)
      return dir === 1 ? { l, i: from, end: to } : { l, i: to - 1, end: from - 1 }
    })
    while (true) {
      let pick: string | undefined
      for (const c of cur) {
        if (c.i === c.end) continue
        const id = c.l[c.i]!
        if (pick === undefined || (dir === 1 ? id < pick : id > pick)) pick = id
      }
      if (pick === undefined) return
      for (const c of cur) if (c.i !== c.end && c.l[c.i] === pick) c.i += dir
      yield pick
    }
  }
  const seen = plan.index.multikey ? new Set<string>() : null
  const keys = plan.keys
  for (let ki = dir === 1 ? 0 : keys.length - 1; dir === 1 ? ki < keys.length : ki >= 0; ki += dir) {
    const list = plan.index.lists.get(keys[ki]!.k)!
    for (let i = dir === 1 ? 0 : list.length - 1; dir === 1 ? i < list.length : i >= 0; i += dir) {
      const id = list[i]!
      if (seen) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      yield id
    }
  }
}

// Отдаёт ли источник документы в порядке сортировки (в каком направлении).
function streamDir(plan: Plan, sort: SortSpec): Dir | null {
  const [first, second] = sort
  if (plan.kind !== 'range') return first![0] === '_id' ? first![1] : null
  if (plan.index.multikey || first![0] !== plan.index.field) return null
  return second && second[0] === '_id' && second[1] === first![1] ? first![1] : null
}

export type FindResult = { docs: Doc[]; explain: Explain }

export function runFind(
  state: CollState,
  query: Query,
  opts: FindOptions & { unordered?: boolean } = {},
  overlay?: Map<string, Doc | null>,
): FindResult {
  const match = compileQuery(query)
  const limit = opts.limit
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new QueryError('limit: нужно целое число больше 0')
  const sort = normalizeSort(parseSort(opts.sort))
  const conds = conjuncts(query)
  const bounds = idBoundsOf(conds)
  const plans = choosePlan(state, conds, bounds)
  const byCost = [...plans].sort((a, b) => a.cost - b.cost)
  let plan = byCost[0]!
  let dir = opts.unordered ? 1 : streamDir(plan, sort)

  // Сортировка по полю с индексом и limit: иногда выгоднее идти по индексу
  // сортировки и фильтровать, чем собрать всех кандидатов и сортировать.
  // Годится только сортировка по одному полю: индекс даёт порядок (поле, _id).
  const [first, second] = sort
  const byOneField = sort.length === 2 && second![0] === '_id' && second![1] === first![1]
  if (dir === null && limit !== undefined && byOneField && first![0] !== '_id') {
    const index = state.indexes.get(first![0])
    if (index && !index.multikey) {
      const expectScanned = (limit * state.docs.size) / Math.max(plan.cost, 1)
      if (expectScanned < plan.cost) {
        plan = { kind: 'range', name: `индекс ${index.field} по порядку`, index, keys: index.keys, cost: state.docs.size }
        dir = sort[0]![1]
      }
    }
  }

  const ov = overlay && overlay.size ? overlay : undefined
  const out: Doc[] = []
  let scanned = 0
  for (const id of iterate(plan, state, bounds, dir ?? 1)) {
    if (ov?.has(id)) continue // версию из транзакции проверим ниже
    const doc = state.docs.get(id)!
    scanned++
    if (opts.maxScanned !== undefined && scanned > opts.maxScanned) {
      throw new QueryError(
        `запрос проверил больше ${opts.maxScanned} документов: слишком широкий фильтр без индекса. ` +
          'Добавьте индекс на поле фильтра или сузьте запрос',
      )
    }
    if (!match(doc)) continue
    out.push(doc)
    if (dir !== null && limit !== undefined && out.length >= limit) break
  }

  let sortedInMemory = false
  let extra = false
  if (ov) {
    for (const doc of ov.values()) {
      if (doc && match(doc)) {
        out.push(doc)
        extra = true
      }
    }
  }
  if (!opts.unordered && (dir === null || extra)) {
    out.sort(comparator(sort))
    sortedInMemory = true
  }
  if (limit !== undefined && out.length > limit) out.length = limit
  return { docs: out, explain: { plan: plan.name, scanned, sortedInMemory } }
}

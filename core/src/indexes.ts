// Индексы (design.md §8).
//
// FieldIndex - индекс поля:
//   lists: значение -> id документов, отсортированные по _id. Равенство и
//          "последние 50 сообщений комнаты" - хвост одного списка;
//   keys:  все значения поля по порядку. Диапазоны ($gt, $lt) и сортировка по
//          полю идут по нему: (значение, _id).
// Каждый документ есть в индексе хотя бы раз: нет поля или пустой массив -
// ключ null, объект - общий ключ объектов. Поэтому обход индекса по порядку
// видит все документы.
import { compareIds, compareValues, rank } from './order'
import { pathValues, type Doc } from './query'

export function indexKey(v: unknown): string {
  switch (typeof v) {
    case 'string':
      return 's' + v
    case 'number':
      return 'n' + v
    case 'boolean':
      return 'b' + v
    default:
      return v === null || v === undefined ? 'z' : 'x'
  }
}

// Значения, которые ищутся по индексу. null и булевы - нет: по ним мало
// разных значений, а у null особые правила (совпадает с отсутствующим полем).
export const isRangeBound = (v: unknown) => typeof v === 'number' || typeof v === 'string'

function lowerBound<T>(arr: readonly T[], before: (x: T) => boolean): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (before(arr[mid]!)) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Отсортированный список строк: вставка и удаление двоичным поиском.
// Новые ULID обычно больше всех - тогда просто push.
export function sortedInsert(list: string[], id: string): void {
  if (list.length === 0 || list[list.length - 1]! < id) {
    list.push(id)
    return
  }
  const i = lowerBound(list, (x) => x < id)
  if (list[i] !== id) list.splice(i, 0, id)
}

export function sortedRemove(list: string[], id: string): void {
  const i = lowerBound(list, (x) => x < id)
  if (list[i] === id) list.splice(i, 1)
}

export type IdBounds = { gt?: string; gte?: string; lt?: string; lte?: string }

// Срез отсортированного по _id списка по границам курсора: [from, to).
export function sliceByIds(list: readonly string[], b: IdBounds): [number, number] {
  let from = 0
  let to = list.length
  if (b.gte !== undefined) from = Math.max(from, lowerBound(list, (x) => x < b.gte!))
  if (b.gt !== undefined) from = Math.max(from, lowerBound(list, (x) => x <= b.gt!))
  if (b.lte !== undefined) to = Math.min(to, lowerBound(list, (x) => x <= b.lte!))
  if (b.lt !== undefined) to = Math.min(to, lowerBound(list, (x) => x < b.lt!))
  return [from, Math.max(from, to)]
}

type Key = { k: string; v: unknown }
export type Bound = { v: unknown; incl: boolean }

export class FieldIndex {
  readonly parts: string[]
  readonly lists = new Map<string, string[]>()
  readonly keys: Key[] = []
  // сколько документов дают больше одного значения (поле-массив)
  multi = 0

  constructor(readonly field: string) {
    this.parts = field.split('.')
  }

  // Индекс по массивам: документ встречается под несколькими значениями.
  get multikey(): boolean {
    return this.multi > 0
  }

  private docKeys(doc: Doc): Map<string, unknown> {
    const out = new Map<string, unknown>()
    for (const v of pathValues(doc, this.parts)) {
      const k = indexKey(v)
      if (!out.has(k)) out.set(k, k === 'z' ? null : k === 'x' ? {} : v)
    }
    return out
  }

  add(doc: Doc): void {
    const keys = this.docKeys(doc)
    if (keys.size > 1) this.multi++
    for (const [k, v] of keys) {
      let list = this.lists.get(k)
      if (!list) {
        this.lists.set(k, (list = []))
        const i = lowerBound(this.keys, (x) => compareValues(x.v, v) < 0)
        this.keys.splice(i, 0, { k, v })
      }
      sortedInsert(list, doc._id)
    }
  }

  remove(doc: Doc): void {
    const keys = this.docKeys(doc)
    if (keys.size > 1) this.multi--
    for (const [k, v] of keys) {
      const list = this.lists.get(k)
      if (!list) continue
      sortedRemove(list, doc._id)
      if (list.length === 0) {
        this.lists.delete(k)
        const i = lowerBound(this.keys, (x) => compareValues(x.v, v) < 0)
        if (this.keys[i]?.k === k) this.keys.splice(i, 1)
      }
    }
  }

  eq(v: unknown): readonly string[] {
    return this.lists.get(indexKey(v)) ?? []
  }

  // Значения в диапазоне по порядку. Как в Mongo, диапазон не выходит за тип
  // границы: { $gt: 5 } - только числа.
  range(lo: Bound | undefined, hi: Bound | undefined): Key[] {
    const r = rank((lo ?? hi)!.v)
    if (lo && hi && rank(hi.v) !== r) return []
    let from = lowerBound(this.keys, (x) => rank(x.v) < r)
    let to = lowerBound(this.keys, (x) => rank(x.v) <= r)
    if (lo) from = lowerBound(this.keys, (x) => (lo.incl ? compareValues(x.v, lo.v) < 0 : compareValues(x.v, lo.v) <= 0))
    if (hi) to = lowerBound(this.keys, (x) => (hi.incl ? compareValues(x.v, hi.v) <= 0 : compareValues(x.v, hi.v) < 0))
    return this.keys.slice(from, Math.max(from, to))
  }

  // Сверка с индексом, построенным заново. Пустой массив - всё в порядке.
  verify(fresh: FieldIndex, name: string): string[] {
    const problems: string[] = []
    if (this.lists.size !== fresh.lists.size) problems.push(`${name}: ${this.lists.size} ключей, ожидалось ${fresh.lists.size}`)
    for (const [k, list] of fresh.lists) {
      if (this.lists.get(k)?.join() !== list.join()) problems.push(`${name}[${k}] не совпадает`)
    }
    for (const [k, list] of this.lists) {
      for (let i = 1; i < list.length; i++) if (compareIds(list[i - 1]!, list[i]!) >= 0) problems.push(`${name}[${k}] не отсортирован`)
    }
    if (this.keys.map((x) => x.k).join('|') !== fresh.keys.map((x) => x.k).join('|')) problems.push(`${name}: порядок значений не совпадает`)
    if (this.multi !== fresh.multi) problems.push(`${name}: multi ${this.multi}, ожидалось ${fresh.multi}`)
    return problems
  }
}

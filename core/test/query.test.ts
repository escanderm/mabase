// Планировщик и индексы: ответ по индексу должен совпадать с полным перебором.
import { describe, expect, test } from 'bun:test'
import sift from 'sift'
import { openDb, type Doc } from '../src/db'
import { comparator, normalizeSort, parseSort } from '../src/order'
import { tmpDir } from './helpers'

// Детерминированный генератор: упавший тест повторяется с тем же seed.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SCALARS = [-1, 0, 1, 2, 2.5, 10, 'a', 'b', '10', '', null, true, false]

function randomDoc(r: () => number): Record<string, unknown> {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!
  const doc: Record<string, unknown> = {}
  const roll = r()
  if (roll < 0.6) doc.a = pick(SCALARS)
  else if (roll < 0.75) doc.a = [pick(SCALARS), pick(SCALARS)]
  else if (roll < 0.8) doc.a = []
  else if (roll < 0.85) doc.a = { x: 1 }
  else if (roll < 0.9) doc.a = [[1, 2], 'a'] // вложенный массив
  if (r() < 0.8) doc.b = pick(['x', 'y', 'z'])
  if (r() < 0.9) doc.p = Math.floor(r() * 20) // поле без массивов: по нему индекс отдаёт порядок
  if (r() < 0.7) doc.tags = ['t1', 't2', 't3'].filter(() => r() < 0.5)
  const n = r()
  if (n < 0.4) doc.n = { v: pick([1, 2, 3, 'q']) }
  else if (n < 0.6) doc.n = [{ v: pick([1, 5]) }, { v: pick([2, 7]) }]
  if (r() < 0.1) doc._id = `custom-${Math.floor(r() * 1e6)}`
  return doc
}

function randomQuery(r: () => number, ids: string[]): { query: any; sort?: any; limit?: number } {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!
  const num = () => pick([-1, 0, 1, 2, 2.5, 10, 'a', 'b', '1'])
  const conds: Array<() => Record<string, unknown>> = [
    () => ({ a: pick(SCALARS) }),
    () => ({ a: { $eq: pick(SCALARS) } }),
    () => ({ a: { $in: [pick(SCALARS), pick(SCALARS)] } }),
    () => ({ a: { $gt: num() } }),
    () => ({ a: { $gte: num(), $lt: num() } }),
    () => ({ a: { $lte: num() } }),
    () => ({ a: { $ne: pick(SCALARS) } }),
    () => ({ b: pick(['x', 'y', 'z', 'w']) }),
    () => ({ b: { $exists: r() < 0.5 } }),
    () => ({ tags: pick(['t1', 't2', 't3']) }),
    () => ({ tags: { $in: ['t1', 't3'] } }),
    () => ({ 'n.v': pick([1, 2, 5, 7, 'q']) }),
    () => ({ 'n.v': { $gte: pick([1, 2, 3, 5]) } }),
    () => ({ _id: { $lt: pick(ids) } }),
    () => ({ _id: { $gte: pick(ids) } }),
    () => ({ _id: { $gt: pick(ids), $lte: pick(ids) } }),
    () => ({ _id: pick(ids) }),
    () => ({ _id: { $in: [pick(ids), pick(ids), 'нет-такого'] } }),
    () => ({ $or: [{ b: 'x' }, { a: 1 }] }),
    () => ({ p: Math.floor(r() * 20) }),
    () => ({ p: { $gte: Math.floor(r() * 20) } }),
    () => ({ p: { $lt: Math.floor(r() * 20) } }),
  ]
  const parts = Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(conds)())
  const query = r() < 0.5 ? { $and: parts } : Object.assign({}, ...parts)
  const sort = pick([undefined, { _id: -1 }, { _id: 1 }, { a: 1 }, { a: -1 }, { b: 1, _id: -1 }, { 'n.v': 1 }, { b: -1, a: 1 }, { p: 1 }, { p: -1 }, { p: 1, _id: 1 }])
  const limit = pick([undefined, 1, 3, 10])
  return { query, sort, limit }
}

function bruteForce(all: Doc[], query: any, sort: any, limit?: number): string[] {
  const out = all.filter(sift(query) as (d: Doc) => boolean).sort(comparator(normalizeSort(parseSort(sort))))
  return (limit ? out.slice(0, limit) : out).map((d) => d._id)
}

describe('планировщик', () => {
  test.each([42, 7, 2026])('21. случайные запросы: индекс = полный перебор (вне и внутри транзакции), seed %d', async (seed) => {
    const db = await openDb({ dir: tmpDir('q'), fsync: false, compactMinBytes: 0 })
    db.collection('x', { indexes: ['a', 'b', 'tags', 'n.v', 'p'] })
    const r = rng(seed)
    await db.c.x!.insertMany(Array.from({ length: 400 }, () => randomDoc(r)))

    let checked = 0
    const plans = new Set<string>()
    const run = async (all: Doc[], api: typeof db.c.x, rounds: number) => {
      const ids = all.map((d) => d._id)
      for (let i = 0; i < rounds; i++) {
        const { query, sort, limit } = randomQuery(r, ids)
        const want = bruteForce(all, query, sort, limit)
        const got = (await api!.find(query, { sort, limit })).map((d) => d._id)
        if (got.join() !== want.join()) {
          throw new Error(`расхождение: ${JSON.stringify({ query, sort, limit })}\nиндекс: ${got}\nперебор: ${want}`)
        }
        const cnt = await api!.count(query)
        if (cnt !== bruteForce(all, query, undefined).length) throw new Error(`count: ${JSON.stringify(query)} ${cnt} != ${bruteForce(all, query, undefined).length}; plan ${JSON.stringify(await api!.explain(query))}`)
        plans.add((await api!.explain(query, { sort, limit })).plan.replace(/ (=|диапазон|по порядку)$/, ' $1'))
        checked++
      }
    }

    await run(await db.c.x!.find(), db.c.x, 1500)

    // внутри транзакции: overlay с новыми, изменёнными и удалёнными документами
    await db.transaction(async (tx) => {
      const all = await tx.c.x!.find()
      for (let i = 0; i < 30; i++) {
        const d = all[Math.floor(r() * all.length)]!
        const k = r()
        if (k < 0.3) await tx.c.x!.insert(randomDoc(r)).catch(() => {}) // свой _id может совпасть
        else if (k < 0.6) await tx.c.x!.update(d._id, { $set: { a: SCALARS[i % SCALARS.length], b: 'x' } }).catch(() => {})
        else await tx.c.x!.remove(d._id).catch(() => {})
      }
      await run(await tx.c.x!.find(), tx.c.x, 500)
    })

    expect(db.verifyIndexes()).toEqual([])
    console.log(`  проверено ${checked} запросов, источники: ${[...plans].sort().join('; ')}`)
    expect(plans.size).toBeGreaterThanOrEqual(8) // индексы действительно использовались
    await db.close()
  })

  test('22. поле-массив: условия проверяются по элементам отдельно', async () => {
    const db = await openDb({ dir: tmpDir('q'), fsync: false, compactMinBytes: 0 })
    db.collection('x', { indexes: ['a'] })
    await db.c.x!.insert({ _id: 'arr', a: [1, 20] })
    await db.c.x!.insert({ _id: 'num', a: 10 })
    // как в Mongo: 20 > 15, а 1 < 5 - документ подходит, хотя ни один элемент не лежит в (5, 15)
    expect((await db.c.x!.find({ a: { $gt: 15, $lt: 5 } })).map((d) => d._id)).toEqual(['arr'])
    // сортировка по массиву: по возрастанию - наименьший элемент, по убыванию - наибольший
    expect((await db.c.x!.find({}, { sort: { a: 1 } })).map((d) => d._id)).toEqual(['arr', 'num'])
    expect((await db.c.x!.find({}, { sort: { a: -1 } })).map((d) => d._id)).toEqual(['arr', 'num'])
    await db.close()
  })

  test('23. порядок типов как в Mongo: null < числа < строки < объекты < булевы', async () => {
    const db = await openDb({ dir: tmpDir('q'), fsync: false, compactMinBytes: 0 })
    db.collection('x', { indexes: ['a'] })
    for (const [id, a] of [['bool', true], ['str', 'a'], ['num', 5], ['obj', { k: 1 }], ['null', null]] as const) {
      await db.c.x!.insert({ _id: id, a })
    }
    await db.c.x!.insert({ _id: 'missing' })
    expect((await db.c.x!.find({}, { sort: { a: 1 } })).map((d) => d._id)).toEqual(['missing', 'null', 'num', 'str', 'obj', 'bool'])
    // { $gt: 1 } - только числа, строки не попадают
    expect((await db.c.x!.find({ a: { $gt: 1 } })).map((d) => d._id)).toEqual(['num'])
    await db.close()
  })
})

describe('limit и sort доходят до индекса', () => {
  test('24. последние 50 из 100 тыс. сообщений комнаты: проверено 50 документов', async () => {
    const db = await openDb({ dir: tmpDir('q'), fsync: false, compactMinBytes: 0 })
    db.collection('messages', { indexes: ['roomId'] })
    const rooms = ['r0', 'r1', 'r2', 'r3']
    await db.c.messages!.insertMany(
      Array.from({ length: 100_000 }, (_, i) => ({ roomId: i % 10 ? 'r0' : rooms[i % 4], text: `m${i}` })),
    )
    const q = { roomId: 'r0' }
    const opts = { sort: { _id: -1 as const }, limit: 50 }

    const t0 = performance.now()
    const page1 = await db.c.messages!.find(q, opts)
    const ms = performance.now() - t0
    expect(page1).toHaveLength(50)
    expect(await db.c.messages!.explain(q, opts)).toEqual({ plan: 'индекс roomId =', scanned: 50, sortedInMemory: false })

    // курсор: следующие 50 старее последнего - тоже 50 проверенных
    const cursor = { roomId: 'r0', _id: { $lt: page1.at(-1)!._id } }
    const page2 = await db.c.messages!.find(cursor, opts)
    expect(page2[0]!._id < page1.at(-1)!._id).toBe(true)
    expect((await db.c.messages!.explain(cursor, opts)).scanned).toBe(50)

    // правило "комнаты, где я участник" ($in) + комната клиента: выбирается равенство
    const withRule = { $and: [{ roomId: { $in: rooms } }, { roomId: 'r1' }] }
    expect((await db.c.messages!.explain(withRule, opts)).plan).toBe('индекс roomId =')
    // только правило (пользователь в двух небольших комнатах): слияние списков, без сортировки в памяти
    const rule = await db.c.messages!.explain({ roomId: { $in: ['r1', 'r2'] } }, opts)
    expect(rule).toEqual({ plan: 'индекс roomId =', scanned: 50, sortedInMemory: false })

    console.log(`  последние 50 из ${await db.c.messages!.count(q)} в комнате: ${ms.toFixed(2)} мс`)
    await db.close()
  })

  test('25. сортировка по полю с индексом: диапазон и limit без перебора всего', async () => {
    const db = await openDb({ dir: tmpDir('q'), fsync: false, compactMinBytes: 0 })
    db.collection('products', { indexes: ['price', 'category'] })
    await db.c.products!.insertMany(
      Array.from({ length: 20_000 }, (_, i) => ({ price: (i * 7919) % 10_000, category: i % 2 ? 'a' : 'b' })),
    )
    // самые дешёвые 10
    const cheap = await db.c.products!.explain({}, { sort: { price: 1 }, limit: 10 })
    expect(cheap).toEqual({ plan: 'индекс price по порядку', scanned: 10, sortedInMemory: false })
    // диапазон цены с сортировкой по цене
    const range = await db.c.products!.explain({ price: { $gte: 5000 } }, { sort: { price: -1 }, limit: 10 })
    expect(range).toEqual({ plan: 'индекс price диапазон', scanned: 10, sortedInMemory: false })
    const top = await db.c.products!.find({ price: { $gte: 5000 } }, { sort: { price: -1 }, limit: 3 })
    expect(top.map((d) => d.price)).toEqual([9999, 9999, 9998]) // каждая цена встречается дважды
    // категория (половина базы) + сортировка по цене: идём по цене и фильтруем
    const mixed = await db.c.products!.explain({ category: 'a' }, { sort: { price: 1 }, limit: 10 })
    expect(mixed.plan).toBe('индекс price по порядку')
    expect(mixed.scanned).toBeLessThan(100)
    await db.close()
  })
})

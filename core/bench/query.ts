// Замеры ядра: запросы через индекс, запись с индексами, старт с построением индексов.
// bun bench/query.ts [число сообщений, по умолчанию 100000]
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../src/db'

const N = Number(process.argv[2] ?? 100_000)
const dir = join(import.meta.dir, '..', '.tmp', `bench-${N}`)
rmSync(dir, { recursive: true, force: true })

const mb = (x: number) => `${Math.round(x / 2 ** 20)} МБ`
function time(label: string, runs: number, fn: () => unknown) {
  const t0 = performance.now()
  for (let i = 0; i < runs; i++) fn()
  console.log(`${label.padEnd(58)} ${((performance.now() - t0) / runs).toFixed(3)} мс`)
}
async function timeAsync(label: string, runs: number, fn: () => Promise<unknown>) {
  const t0 = performance.now()
  for (let i = 0; i < runs; i++) await fn()
  console.log(`${label.padEnd(58)} ${((performance.now() - t0) / runs).toFixed(3)} мс`)
}

const indexes = { messages: ['roomId', 'authorId'], products: ['price', 'category'] }
let db = await openDb({ dir, fsync: false, compactMinBytes: 0 })
for (const [c, idx] of Object.entries(indexes)) db.collection(c, { indexes: idx })

// ---------- запись ----------
console.log(`\n== Запись (${N} сообщений, 2 индекса) ==`)
let t0 = performance.now()
await db.c.messages!.insertMany(
  Array.from({ length: N }, (_, i) => ({
    roomId: `r${i % 100 < 90 ? 0 : i % 100}`, // 90% в одной большой комнате
    authorId: `u${i % 50}`,
    text: `Сообщение ${i} `.padEnd(120, '.'),
  })),
)
let s = (performance.now() - t0) / 1000
console.log(`insertMany пачками по 1000, без fsync: ${Math.round(N / s)} док/с`)
await db.c.products!.insertMany(
  Array.from({ length: 20_000 }, (_, i) => ({ price: (i * 7919) % 100_000, category: `c${i % 20}` })),
)

const single = 2000
t0 = performance.now()
for (let i = 0; i < single; i++) await db.c.messages!.insert({ roomId: 'r0', authorId: 'u1', text: 'x' })
console.log(`одиночные insert, без fsync: ${Math.round(single / ((performance.now() - t0) / 1000))} tx/с`)

// ---------- чтение ----------
console.log(`\n== Запросы (в комнате r0: ${await db.c.messages!.count({ roomId: 'r0' })} сообщений) ==`)
const m = db.c.messages!
const last50 = await m.find({ roomId: 'r0' }, { sort: { _id: -1 }, limit: 50 })
const cursor = last50.at(-1)!._id
await timeAsync('последние 50 сообщений комнаты', 2000, () => m.find({ roomId: 'r0' }, { sort: { _id: -1 }, limit: 50 }))
await timeAsync('следующие 50 (курсор _id < последнего)', 2000, () =>
  m.find({ roomId: 'r0', _id: { $lt: cursor } }, { sort: { _id: -1 }, limit: 50 }),
)
const myRooms = ['r0', 'r91', 'r95', 'r99']
await timeAsync('правило $in по 4 комнатам + комната клиента', 2000, () =>
  m.find({ $and: [{ roomId: { $in: myRooms } }, { roomId: 'r95' }] }, { sort: { _id: -1 }, limit: 50 }),
)
await timeAsync('только правило $in по 4 комнатам, последние 50', 2000, () =>
  m.find({ roomId: { $in: myRooms } }, { sort: { _id: -1 }, limit: 50 }),
)
await timeAsync('count комнаты (90% базы)', 200, () => m.count({ roomId: 'r0' }))
await timeAsync('без индекса: text $regex, limit 50 (полный перебор)', 20, () =>
  m.find({ text: { $regex: '^Сообщение 1' } }, { limit: 50 }),
)
const p = db.c.products!
await timeAsync('товары: 10 самых дешёвых из 20 тыс.', 2000, () => p.find({}, { sort: { price: 1 }, limit: 10 }))
await timeAsync('товары: категория + сортировка по цене, 10', 2000, () =>
  p.find({ category: 'c3' }, { sort: { price: 1 }, limit: 10 }),
)
await timeAsync('товары: цена 50-60 тыс., по цене, 20', 2000, () =>
  p.find({ price: { $gte: 50_000, $lt: 60_000 } }, { sort: { price: 1 }, limit: 20 }),
)

// ---------- старт ----------
const heap = process.memoryUsage()
await db.close()
console.log(`\n== Память после заполнения: heap ${mb(heap.heapUsed)}, rss ${mb(heap.rss)} ==`)
Bun.gc(true)
t0 = performance.now()
db = await openDb({ dir, fsync: false, compactMinBytes: 0 })
const openMs = performance.now() - t0
t0 = performance.now()
for (const [c, idx] of Object.entries(indexes)) db.collection(c, { indexes: idx })
const indexMs = performance.now() - t0
console.log(`старт: чтение ${openMs.toFixed(0)} мс + индексы ${indexMs.toFixed(0)} мс`)
await db.compact()
await db.close()
db = await openDb({ dir, fsync: false, compactMinBytes: 0 })
t0 = performance.now()
for (const [c, idx] of Object.entries(indexes)) db.collection(c, { indexes: idx })
console.log(`после компактирования: индексы ${(performance.now() - t0).toFixed(0)} мс`)
Bun.gc(true)
const after = process.memoryUsage()
console.log(`память после старта: heap ${mb(after.heapUsed)}, rss ${mb(after.rss)}`)
await db.close()
rmSync(dir, { recursive: true, force: true })

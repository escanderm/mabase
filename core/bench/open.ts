// Отдельный процесс: открыть базу, построить индекс и замерить старт, память и запрос чата.
// bun bench/open.ts <dir>
import { openDb } from '../src/db'

const dir = process.argv[2]!
const t0 = performance.now()
const db = await openDb({ dir, compactMinBytes: 0 })
const tOpen = performance.now() - t0
db.collection('m', { indexes: ['roomId'] })
const tReady = performance.now() - t0

Bun.gc(true)
const mem = process.memoryUsage()

const opts = { sort: { _id: -1 as const }, limit: 50 }
const q0 = performance.now()
const last50 = await db.c.m!.find({ roomId: 'r7' }, opts)
const tQuery = performance.now() - q0
const explain = await db.c.m!.explain({ roomId: 'r7' }, opts)

console.log(
  JSON.stringify({
    openMs: Math.round(tOpen),
    readyMs: Math.round(tReady),
    heapMB: Math.round(mem.heapUsed / 2 ** 20),
    rssMB: Math.round(mem.rss / 2 ** 20),
    last50: last50.length,
    queryMs: Math.round(tQuery * 100) / 100,
    scanned: explain.scanned,
  }),
)
await db.close()

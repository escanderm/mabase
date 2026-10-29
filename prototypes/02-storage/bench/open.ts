// Отдельный процесс: открыть базу и замерить старт, память и типичный запрос чата.
// bun bench/open.ts <dir>
import { openDb } from '../src/db'

const dir = process.argv[2]!
const t0 = performance.now()
const db = await openDb({ dir, compactAtBytes: 0 })
const tOpen = performance.now() - t0
db.collection('m', { indexes: ['roomId'] })
const tReady = performance.now() - t0

Bun.gc(true)
const mem = process.memoryUsage()

// "последние 50 сообщений комнаты": индекс отдаёт отсортированный по _id список
const q0 = performance.now()
const room = await db.c.m!.find({ roomId: 'r7' })
const last50 = room.slice(-50)
const tQuery = performance.now() - q0

console.log(
  JSON.stringify({
    openMs: Math.round(tOpen),
    readyMs: Math.round(tReady),
    heapMB: Math.round(mem.heapUsed / 2 ** 20),
    rssMB: Math.round(mem.rss / 2 ** 20),
    roomDocs: room.length,
    last50: last50.length,
    queryMs: Math.round(tQuery * 10) / 10,
  }),
)
await db.close()

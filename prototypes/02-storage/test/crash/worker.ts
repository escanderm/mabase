// Рабочий процесс для тестов на падения (SPEC §7, тесты 13-14).
// bun test/crash/worker.ts <dir> <runId> <count>
// Каждая транзакция: 2 документа в "a" и 1 в "b" с общей меткой batch.
// После коммита (то есть после fsync) печатает "ACK <tx> <batch>".
import { writeSync } from 'node:fs'
import { openDb } from '../../src/db'

const [dir, runId, countArg] = process.argv.slice(2)
const count = Number(countArg ?? 1000)

const db = await openDb({ dir: dir!, compactAtBytes: Number(process.env.MB_COMPACT_AT ?? 4096) })
db.collection('a', { indexes: ['batch'] })
db.collection('b', { indexes: ['batch'] })

let prevB: string | null = null
for (let i = 0; i < count; i++) {
  const batch = `${runId}-${i}`
  await db.transaction(async (tx) => {
    await tx.c.a!.insert({ batch, k: 1 })
    await tx.c.a!.insert({ batch, k: 2 })
    const b = await tx.c.b!.insert({ batch, touched: 0 })
    // изменение старой записи - чтобы в логе были не только вставки
    if (prevB) await tx.c.b!.update(prevB, { $inc: { touched: 1 } })
    prevB = b._id
  })
  writeSync(1, `ACK ${db.lastTx} ${batch}\n`)
}
await db.close()
writeSync(1, 'DONE\n')

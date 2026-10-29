// Замеры для RESULTS.md (SPEC §8). bun bench/bench.ts
import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { currentLogPath, tmpDir } from '../test/helpers'

const OPEN = join(import.meta.dir, 'open.ts')
const msg = (i: number) => ({
  roomId: `r${i % 100}`,
  authorId: `u${i % 1000}`,
  text: `Сообщение номер ${i}: короткий текст как в обычном чате`,
  n: i,
})

async function sequential(fsync: boolean, count: number) {
  const dir = tmpDir('bench')
  const db = await openDb({ dir, fsync, compactAtBytes: 0 })
  const t0 = performance.now()
  for (let i = 0; i < count; i++) await db.c.m!.insert(msg(i))
  const sec = (performance.now() - t0) / 1000
  await db.close()
  rmSync(dir, { recursive: true })
  return Math.round(count / sec)
}

async function parallel(count: number) {
  const dir = tmpDir('bench')
  const db = await openDb({ dir, compactAtBytes: 0 })
  const t0 = performance.now()
  await Promise.all(Array.from({ length: count }, (_, i) => db.c.m!.insert(msg(i))))
  const sec = (performance.now() - t0) / 1000
  await db.close()
  rmSync(dir, { recursive: true })
  return Math.round(count / sec)
}

async function batched(total: number, batch: number, fsync: boolean) {
  const dir = tmpDir('bench')
  const db = await openDb({ dir, fsync, compactAtBytes: 0 })
  db.collection('m', { indexes: ['roomId'] })
  const t0 = performance.now()
  for (let b = 0; b < total / batch; b++) {
    await db.transaction(async (tx) => {
      for (let i = 0; i < batch; i++) await tx.c.m!.insert(msg(b * batch + i))
    })
  }
  const writeSec = (performance.now() - t0) / 1000
  const logMB = statSync(currentLogPath(dir)).size / 2 ** 20
  return { db, dir, writeSec, logMB }
}

async function volume(total: number) {
  const { db, dir, writeSec, logMB } = await batched(total, 1000, false)
  const c0 = performance.now()
  await db.compact()
  const compactSec = (performance.now() - c0) / 1000
  const snapMB = statSync(join(dir, `snapshot.${db.lastTx}.jsonl`)).size / 2 ** 20
  await db.close()

  const proc = Bun.spawn(['bun', OPEN, dir], { stdout: 'pipe', stderr: 'inherit' })
  const opened = JSON.parse(await new Response(proc.stdout).text())
  await proc.exited
  rmSync(dir, { recursive: true })
  return { docs: total, writeSec: +writeSec.toFixed(1), logMB: +logMB.toFixed(0), compactSec: +compactSec.toFixed(2), snapMB: +snapMB.toFixed(0), ...opened }
}

console.log(`Bun ${Bun.version}, ${process.platform}/${process.arch}`)

console.log('\n1. Одиночные транзакции подряд (1 документ = 1 транзакция)')
console.log(`   с fsync:  ${await sequential(true, 3000)} транзакций/с`)
console.log(`   без fsync: ${await sequential(false, 30000)} транзакций/с`)
console.log(`   100 параллельных вставок с fsync: ${await parallel(3000)} транзакций/с (очередь всё равно одна)`)

console.log('\n2. Пакетная запись: 100 тыс. документов пачками по 1000, с fsync')
{
  const r = await batched(100_000, 1000, true)
  console.log(`   ${r.writeSec.toFixed(1)} с, ${Math.round(100_000 / r.writeSec)} документов/с, лог ${r.logMB.toFixed(0)} МБ`)
  await r.db.close()
  rmSync(r.dir, { recursive: true })
}

console.log('\n3. Объём: запись, компактирование, старт в новом процессе')
for (const n of [100_000, 1_000_000]) console.log('  ', JSON.stringify(await volume(n)))

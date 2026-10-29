// Объём, как в прототипе 02 (те же документы): запись пачками, компактирование,
// старт в новом процессе. bun bench/volume.ts
import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { tmpDir } from '../test/helpers'

const msg = (i: number) => ({
  roomId: `r${i % 100}`,
  authorId: `u${i % 1000}`,
  text: `Сообщение номер ${i}: короткий текст как в обычном чате`,
  n: i,
})

for (const total of (process.argv[2] ? [Number(process.argv[2])] : [100_000, 1_000_000])) {
  const dir = tmpDir('volume')
  const db = await openDb({ dir, fsync: false, compactMinBytes: 0 })
  db.collection('m', { indexes: ['roomId'] })
  let t0 = performance.now()
  for (let i = 0; i < total; i += 10_000) await db.c.m!.insertMany(Array.from({ length: 10_000 }, (_, k) => msg(i + k)))
  const writeSec = (performance.now() - t0) / 1000
  t0 = performance.now()
  await db.compact()
  const compactSec = (performance.now() - t0) / 1000
  const snapMB = statSync(join(dir, `snapshot.${db.lastTx}.jsonl`)).size / 2 ** 20
  await db.close()

  const proc = Bun.spawn(['bun', join(import.meta.dir, 'open.ts'), dir], { stdout: 'pipe', stderr: 'inherit' })
  const opened = JSON.parse(await new Response(proc.stdout).text())
  await proc.exited
  rmSync(dir, { recursive: true })
  console.log(JSON.stringify({ docs: total, docsPerSec: Math.round(total / writeSec), compactSec: +compactSec.toFixed(2), snapMB: +snapMB.toFixed(0), ...opened }))
}

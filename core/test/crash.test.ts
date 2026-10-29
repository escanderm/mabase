// Тесты 13-14 из SPEC §7: падение процесса в заданных точках и случайный kill -9.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { files, tmpDir } from './helpers'

const WORKER = join(import.meta.dir, 'crash', 'worker.ts')

type Run = { acks: Array<{ tx: number; batch: string }>; signal: string | null; exitCode: number | null; stderr: string }

// killAfterFirstAckMs: убить через столько мс после первого подтверждения.
// Отсчёт от первого ACK, а не от запуска: иначе на медленной машине процесс
// погибает ещё до начала записи, и тест ничего не проверяет.
async function runWorker(dir: string, runId: string, count: number, env: Record<string, string> = {}, killAfterFirstAckMs?: number): Promise<Run> {
  const proc = Bun.spawn(['bun', WORKER, dir, runId, String(count)], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const readOut = async () => {
    let text = ''
    let armed = false
    const decoder = new TextDecoder()
    for await (const chunk of proc.stdout) {
      text += decoder.decode(chunk, { stream: true })
      if (killAfterFirstAckMs !== undefined && !armed && text.includes('ACK ')) {
        armed = true
        setTimeout(() => proc.kill('SIGKILL'), killAfterFirstAckMs)
      }
    }
    return text
  }
  const [out, stderr] = await Promise.all([readOut(), new Response(proc.stderr).text()])
  await proc.exited
  const acks = out
    .split('\n')
    .filter((l) => l.startsWith('ACK '))
    .map((l) => {
      const [, tx, batch] = l.split(' ')
      return { tx: Number(tx), batch: batch! }
    })
  return { acks, signal: proc.signalCode ?? null, exitCode: proc.exitCode, stderr }
}

// Инварианты SPEC §7 после восстановления.
async function checkInvariants(dir: string, acked: Array<{ tx: number; batch: string }>): Promise<{ lastTx: number; batches: number }> {
  const db = await openDb({ dir, compactMinBytes: 0 })
  db.collection('a', { indexes: ['batch'] })
  db.collection('b', { indexes: ['batch'] })

  // атомарность: у каждой метки либо 2+1 документа, либо ничего
  const count = new Map<string, { a: number; b: number }>()
  for (const d of await db.c.a!.find()) {
    const c = count.get(d.batch) ?? { a: 0, b: 0 }
    c.a++
    count.set(d.batch, c)
  }
  for (const d of await db.c.b!.find()) {
    const c = count.get(d.batch) ?? { a: 0, b: 0 }
    c.b++
    count.set(d.batch, c)
  }
  for (const [batch, c] of count) {
    if (c.a !== 2 || c.b !== 1) throw new Error(`Пакет ${batch} записан частично: a=${c.a}, b=${c.b}`)
  }

  // сохранность: всё подтверждённое есть
  for (const { tx, batch } of acked) {
    if (!count.has(batch)) throw new Error(`Подтверждённый пакет ${batch} (tx ${tx}) потерян`)
    if (tx > db.lastTx) throw new Error(`Подтверждённый tx ${tx} больше последнего ${db.lastTx}`)
  }

  const problems = db.verifyIndexes()
  if (problems.length) throw new Error(`Индексы разошлись с данными: ${problems.join('; ')}`)

  const gen = db.stats.gen
  const lastTx = db.lastTx
  await db.close()
  const left = files(dir)
  const expected = ['CURRENT', `log.${gen}.jsonl`, `snapshot.${gen}.jsonl`]
  if (left.join() !== expected.join()) throw new Error(`Мусор в папке: ${left.join(', ')}`)
  return { lastTx, batches: count.size }
}

const POINTS: Array<[string, number]> = [
  ['log.beforeWrite', 30],
  ['log.afterWriteBeforeFsync', 30],
  ['log.afterFsyncBeforeApply', 30],
  ['compact.afterSnapshotTmp', 2],
  ['compact.afterSnapshotRename', 2],
  ['compact.afterNewLog', 2],
  ['compact.afterCurrent', 2],
  ['compact.beforeDeleteOld', 2],
]

describe('падения процесса', () => {
  for (const [point, hit] of POINTS) {
    test(`13. падение в точке ${point}`, async () => {
      const dir = tmpDir('crash')
      const run = await runWorker(dir, 'r1', 2000, { MB_CRASH_AT: point, MB_CRASH_HIT: String(hit) })
      expect(run.stderr).toBe('')
      expect(run.signal).toBe('SIGKILL')
      expect(run.acks.length).toBeGreaterThan(0)
      await checkInvariants(dir, run.acks)

      // база продолжает работать с той же папкой
      const next = await runWorker(dir, 'r2', 20)
      expect(next.exitCode).toBe(0)
      await checkInvariants(dir, [...run.acks, ...next.acks])
    })
  }

  test('14. случайный kill -9 снаружи, 50 повторов на одной папке', async () => {
    const dir = tmpDir('kill')
    const acked: Array<{ tx: number; batch: string }> = []
    let killedMidWork = 0
    for (let i = 0; i < 50; i++) {
      const killAfter = Math.floor(Math.random() * 200)
      const run = await runWorker(dir, `k${i}`, 100_000, { MB_COMPACT_AT: '8192' }, killAfter)
      expect(run.signal).toBe('SIGKILL')
      expect(run.stderr).toBe('')
      if (run.acks.length > 0) killedMidWork++
      acked.push(...run.acks)
      await checkInvariants(dir, acked)
    }
    const { lastTx, batches } = await checkInvariants(dir, acked)
    console.log(`  kill -9: 50 запусков, ${killedMidWork} убиты посреди записи, подтверждено ${acked.length} транзакций, в базе ${batches} пакетов, lastTx ${lastTx}`)
    expect(killedMidWork).toBe(50)
  })
})

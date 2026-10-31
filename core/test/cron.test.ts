// Тесты 179-184: cron (design.md §13) и миграции (§15).
//  179-180: разбор выражений и расчёт следующего запуска (включая сверку
//           с полным перебором минут);
//  181: schedule() в конфиге/хуках - проверка выражения и дублей;
//  182: периодическая задача выполняется и получает следующее время;
//  183: миграции - порядок, идемпотентность, откат упавшей миграции;
//  184: mabase migrate в CLI.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetApi, schedule, scheduledTasks } from '../src/api'
import { nextCronRun, parseCron } from '../src/cron'
import { openDb } from '../src/db'
import { appliedMigrations, applyMigrations, loadMigrations } from '../src/migrations'
import { Scheduler, ensureSchedules } from '../src/scheduler'
import { sleep, tmpDir, waitFor } from './helpers'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const at = (s: string) => new Date(s).getTime()

// Независимая проверка: идём по минутам и ищем первое совпадение.
function bruteNext(expr: string, from: number, days = 70): number {
  const c = parseCron(expr)
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const end = from + days * 24 * 60 * 60_000
  while (d.getTime() <= end) {
    const domOk = c.dom.has(d.getDate())
    const dowOk = c.dow.has(d.getDay())
    const dayOk = c.domRestricted && c.dowRestricted ? domOk || dowOk : domOk && dowOk
    if (c.months.has(d.getMonth() + 1) && dayOk && c.hours.has(d.getHours()) && c.minutes.has(d.getMinutes())) return d.getTime()
    d.setMinutes(d.getMinutes() + 1)
  }
  throw new Error(`перебор не нашёл ${expr} за ${days} дней`)
}

describe('cron', () => {
  test('179. простое, шаг, диапазон, список; ровно следующая минута', () => {
    expect(nextCronRun('* * * * *', at('2026-03-10T12:00:30'))).toBe(at('2026-03-10T12:01:00'))
    expect(nextCronRun('*/15 * * * *', at('2026-03-10T12:07:00'))).toBe(at('2026-03-10T12:15:00'))
    expect(nextCronRun('0 9 * * *', at('2026-03-10T12:00:00'))).toBe(at('2026-03-11T09:00:00'))
    expect(nextCronRun('0 9 * * *', at('2026-03-10T08:00:00'))).toBe(at('2026-03-10T09:00:00'))
    expect(nextCronRun('0 12 1 * *', at('2026-03-10T00:00:00'))).toBe(at('2026-04-01T12:00:00'))
    expect(nextCronRun('0 0 29 2 *', at('2026-03-01T00:00:00'))).toBe(at('2028-02-29T00:00:00'))
    expect(nextCronRun('5,35 8-10 * * *', at('2026-03-10T10:36:00'))).toBe(at('2026-03-11T08:05:00'))
  })

  test('180. то же, что полный перебор минут, на наборе выражений', () => {
    const from = at('2026-03-10T12:34:00')
    for (const expr of ['* * * * *', '*/7 * * * *', '0 9 * * *', '30 8 * * 1-5', '0 0 13 * 5', '15 3 1,15 * *', '0 0 * * 0', '0 6 * * 7']) {
      expect(nextCronRun(expr, from)).toBe(bruteNext(expr, from))
    }
  })

  test('181. кривое выражение - понятная ошибка', () => {
    for (const bad of ['', '0 9 * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'a * * * *', '*/0 * * * *', '5-1 * * * *']) {
      expect(() => parseCron(bad)).toThrow()
    }
  })
})

describe('периодические задачи', () => {
  test('182. schedule(): проверка выражения, дублей; resetApi чистит', () => {
    resetApi()
    schedule('digest.daily', '0 9 * * *', { to: 'team' })
    expect(scheduledTasks()).toEqual([{ event: 'digest.daily', cron: '0 9 * * *', data: { to: 'team' } }])
    expect(() => schedule('digest.daily', '* * * * *')).toThrow(/уже запланировано/)
    expect(() => schedule('bad', '0 9 * *')).toThrow(/cron/)
    resetApi()
    expect(scheduledTasks()).toEqual([])
  })

  test('183. задача по cron выполняется и остаётся со следующим временем', async () => {
    const db = await openDb({ dir: tmpDir('cron-run'), fsync: false, compactMinBytes: 0 })
    const calls: number[] = []
    const map = new Map([['tick', [async () => void calls.push(Date.now())]]])
    const s = new Scheduler(db, () => map as any, { retryBaseMs: 20, onError: () => {} })
    await s.start()
    await ensureSchedules(db, [{ event: 'tick', cron: '* * * * *' }])

    const created = await db.c._scheduled!.findOne({ event: 'tick' })
    expect(created).toMatchObject({ cron: '* * * * *', attempts: 0 })
    expect(Number(created!.runAt)).toBeGreaterThan(Date.now())
    expect(created!.key).toBe('cron:tick')

    // сдвигаем время в прошлое: задача должна выполниться сейчас и получить следующее
    await db.c._scheduled!.update(created!._id, { $set: { runAt: Date.now() - 1000 } })
    await waitFor(() => calls.length === 1, 3000)
    await waitFor(async () => {
      const t = await db.c._scheduled!.findOne({ event: 'tick' })
      return !!t && Number(t.runAt) > Date.now()
    }, 2000)

    const after = await db.c._scheduled!.findOne({ event: 'tick' })
    expect(after).not.toBeNull() // не удалена: она периодическая
    expect(after!.attempts).toBe(0)
    // Следующее время - на границе минуты и не в прошлом. Проверять «больше,
    // чем через 30 секунд» нельзя: до следующей минуты может остаться меньше.
    expect(Number(after!.runAt) % 60_000).toBe(0)
    expect(Number(after!.runAt)).toBeGreaterThan(Date.now() - 60_000)

    // повторный ensureSchedules не создаёт вторую задачу
    await ensureSchedules(db, [{ event: 'tick', cron: '*/5 * * * *' }])
    expect(await db.c._scheduled!.count({ event: 'tick' })).toBe(1)
    await s.stop()
    await db.close()
  }, 20_000)
})

describe('миграции', () => {
  const migration = (dir: string, name: string, body: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), body)
  }

  test('184. применяются по порядку, один раз; упавшая откатывается целиком', async () => {
    const root = tmpDir('mig')
    const dir = join(root, 'mb_migrations')
    migration(dir, '202601010000-add-field.ts', `export async function up(db) {
      for (const d of await db.docs.find()) await db.docs.update(d._id, { $set: { migrated: true } })
    }`)
    migration(dir, '202601020000-insert.ts', `export function up(db) { return db.docs.insert({ _id: 'from-migration', text: 'new' }) }`)
    migration(dir, '202601030000-bad.ts', `export async function up(db) {
      await db.docs.insert({ _id: 'half', text: 'half' })
      throw new Error('посреди миграции')
    }`)

    const db = await openDb({ dir: join(root, 'db'), fsync: false, compactMinBytes: 0 })
    db.collection('docs', {})
    await db.c.docs!.insert({ _id: 'old', text: 'old' })

    const list = await loadMigrations(dir)
    expect(list.map((m) => m.name)).toEqual(['202601010000-add-field.ts', '202601020000-insert.ts', '202601030000-bad.ts'])

    const seen: string[] = []
    const err = await applyMigrations(db, list, { onApply: (n) => seen.push(n) }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('посреди миграции')
    expect(seen).toEqual(['202601010000-add-field.ts', '202601020000-insert.ts']) // третья не применилась

    // первые две на месте, третья откатилась целиком (ни документа, ни отметки)
    expect((await db.c.docs!.findOne({ _id: 'old' }))!.migrated).toBe(true)
    expect(await db.c.docs!.findOne({ _id: 'from-migration' })).not.toBeNull()
    expect(await db.c.docs!.findOne({ _id: 'half' })).toBeNull()
    expect(await appliedMigrations(db)).toEqual(['202601010000-add-field.ts', '202601020000-insert.ts'])

    // повторный запуск: ничего не применяется заново
    const again = await applyMigrations(db, list.slice(0, 2))
    expect(again).toEqual({ applied: [], skipped: 2 })
    await db.close()
  })

  test('185. кривое имя файла и файл без up - понятная ошибка', async () => {
    const dir = tmpDir('mig-bad')
    writeFileSync(join(dir, 'add-field.ts'), 'export function up() {}')
    expect(await loadMigrations(dir).catch((e) => e.message)).toContain('YYYYMMDDHHMM')
    const dir2 = tmpDir('mig-bad2')
    writeFileSync(join(dir2, '202601010000-nope.ts'), 'export const x = 1')
    expect(await loadMigrations(dir2).catch((e) => e.message)).toContain('up(db)')
  })

  test('186. mabase migrate в CLI применяет и сообщает', async () => {
    const root = tmpDir('mig-cli')
    writeFileSync(
      join(root, 'mabase.config.ts'),
      `import { defineCollection, defineConfig, z } from 'mabase'
const docs = defineCollection('docs', { schema: z.object({ text: z.string().optional(), done: z.boolean().optional() }).passthrough() })
export default defineConfig({ collections: [docs] })`,
    )
    mkdirSync(join(root, 'mb_migrations'))
    writeFileSync(
      join(root, 'mb_migrations', '202601010000-mark.ts'),
      `export async function up(db) { await db.docs.insert({ _id: 'seeded-by-migration', done: true }) }`,
    )
    const run = async () => {
      const p = Bun.spawn(['bun', CLI, 'migrate', '--root', root], { stdout: 'pipe', stderr: 'pipe' })
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      return { code: await p.exited, out: out + err }
    }
    const first = await run()
    expect(first.code).toBe(0)
    expect(first.out).toContain('202601010000-mark.ts')
    expect(first.out).toContain('Применено миграций: 1')

    const second = await run()
    expect(second.code).toBe(0)
    expect(second.out).toContain('Всё уже применено')

    const db = await openDb({ dir: join(root, 'mb_data', 'db') })
    expect((await db.c.docs!.findOne({ _id: 'seeded-by-migration' }))!.done).toBe(true)
    await db.close()
    await sleep(1)
  }, 40_000)
})

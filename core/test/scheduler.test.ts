// Отложенные события (design.md §13): доставка, время, повторы, провал,
// пропущенные за время простоя, минимум один раз, письмо о приглашении в чате.
import { describe, expect, test } from 'bun:test'
import type { Handler } from '../src/bus'
import { openDb, SCHEDULED, type Db } from '../src/db'
import { Scheduler, type SchedulerOptions } from '../src/scheduler'
import { Tail, type TailEntry } from '../src/tail'
import { sleep, tmpDir, waitFor } from './helpers'

type Calls = Array<{ event: string; data: any; attempt: number; at: number }>

async function setup(handlers: Record<string, Handler>, opts: SchedulerOptions = {}, dir = tmpDir('sch')) {
  const db = await openDb({ dir, fsync: false, compactMinBytes: 0 })
  const map = new Map(Object.entries(handlers).map(([k, h]) => [k, [h]]))
  const errors: string[] = []
  const tail = new Tail()
  const log: TailEntry[] = []
  tail.listen((e) => void log.push(e))
  const s = new Scheduler(db, () => map, { retryBaseMs: 20, onError: (_, w) => void errors.push(w), tail, ...opts })
  return { db, s, errors, log, dir }
}

const emit = (db: Db, event: string, data: unknown, opts: { after?: string | number; key?: string } = {}) =>
  db.transaction((tx) => tx.emit(event, data, { after: opts.after ?? 0, key: opts.key }))

describe('отложенные события', () => {
  test('160. таймаут не запускает вторую копию обработчика: повтор ждёт завершения первой', async () => {
    let running = 0
    let maxRunning = 0
    let calls = 0
    const { db, s } = await setup(
      {
        slow: async () => {
          calls++
          running++
          maxRunning = Math.max(maxRunning, running)
          await sleep(300) // дольше таймаута
          running--
        },
      },
      { timeoutMs: 100, retryBaseMs: 30, maxAttempts: 2 },
    )
    await s.start()
    await emit(db, 'slow', {})
    await sleep(700)
    await s.stop()
    // Без правки: по таймауту задача уходила в повтор через 30 мс, и вторая
    // копия работала параллельно с первой (двойное письмо/insert).
    expect(maxRunning).toBe(1)
    expect(calls).toBeGreaterThanOrEqual(1)
    await db.close()
  }, 20_000)

  test('115. выполняется один раз и удаляется; key свободен снова; транзакция с ошибкой задач не ставит', async () => {
    const calls: Calls = []
    const { db, s } = await setup({ greet: ({ data, task }) => void calls.push({ event: 'greet', data, attempt: task!.attempt, at: Date.now() }) })
    await s.start()
    await emit(db, 'greet', { to: 'u1' }, { key: 'greet:u1' })
    await emit(db, 'greet', { to: 'u1' }, { key: 'greet:u1' }) // пока лежит - не ставится
    await waitFor(() => calls.length === 1, 2000)
    await s.idle()
    expect(calls).toEqual([{ event: 'greet', data: { to: 'u1' }, attempt: 1, at: expect.any(Number) }])
    expect(await db.c[SCHEDULED]!.count()).toBe(0)
    await emit(db, 'greet', { to: 'u1' }, { key: 'greet:u1' }) // выполнена - key свободен
    await waitFor(() => calls.length === 2, 2000)

    await db.transaction(async (tx) => {
      tx.emit('greet', { to: 'nope' }, { after: 0 })
      throw new Error('отмена')
    }).catch(() => {})
    await sleep(50)
    expect(calls.map((c) => c.data.to)).toEqual(['u1', 'u1'])
    await s.stop()
    await db.close()
  })

  test('116. не раньше runAt; ближняя задача не ждёт дальнюю', async () => {
    const calls: Calls = []
    const { db, s } = await setup({ e: ({ data }) => void calls.push({ event: 'e', data, attempt: 0, at: Date.now() }) })
    await s.start()
    await sleep(20) // планировщик уже спит: время пробуждения меняют только новые задачи
    const t0 = Date.now()
    await emit(db, 'e', 'дальняя', { after: '300ms' })
    await emit(db, 'e', 'ближняя', { after: '50ms' })
    await waitFor(() => calls.length === 2, 2000)
    expect(calls.map((c) => c.data)).toEqual(['ближняя', 'дальняя'])
    expect(calls[0]!.at - t0).toBeGreaterThanOrEqual(45)
    expect(calls[0]!.at - t0).toBeLessThan(250)
    expect(calls[1]!.at - t0).toBeGreaterThanOrEqual(295)
    await s.stop()
    await db.close()
  })

  test('117. ошибка - повтор с растущей паузой; успех на третьей попытке', async () => {
    const calls: Calls = []
    const { db, s, errors, log } = await setup({
      flaky: ({ task }) => {
        calls.push({ event: 'flaky', data: null, attempt: task!.attempt, at: Date.now() })
        if (task!.attempt < 3) throw new Error('почта не отвечает')
      },
    })
    await s.start()
    await emit(db, 'flaky', null)
    await waitFor(() => calls.length === 3, 3000)
    await s.idle()
    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3])
    const gap1 = calls[1]!.at - calls[0]!.at
    const gap2 = calls[2]!.at - calls[1]!.at
    expect(gap1).toBeGreaterThanOrEqual(18) // 20 мс
    expect(gap2).toBeGreaterThanOrEqual(38) // 40 мс - вдвое больше
    expect(errors).toEqual(['отложенное событие flaky, попытка 1', 'отложенное событие flaky, попытка 2'])
    expect(log.filter((e) => e.kind === 'task').map((e) => [e.attempt, e.ok])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ])
    expect(await db.c[SCHEDULED]!.count()).toBe(0)
    await s.stop()
    await db.close()
  })

  test('118. после maxAttempts - failed, остаётся для разбора, key освобождён; нет обработчика - тоже ошибка', async () => {
    let n = 0
    const { db, s, errors, log } = await setup(
      {
        broken: () => {
          n++
          throw new Error('всегда падает')
        },
      },
      { maxAttempts: 3 },
    )
    await s.start()
    await emit(db, 'broken', { x: 1 }, { key: 'k' })
    await emit(db, 'typo.event', {})
    await waitFor(async () => (await db.c[SCHEDULED]!.count({ failed: true })) === 2, 3000)
    await sleep(100)
    expect(n).toBe(3) // больше не запускается
    const failed = await db.c[SCHEDULED]!.find({ failed: true }, { sort: { event: 1 } })
    expect(failed[0]).toMatchObject({ event: 'broken', attempts: 3, failedKey: 'k', lastError: 'всегда падает', data: { x: 1 } })
    expect(failed[0]!.key).toBeUndefined()
    expect(failed[1]).toMatchObject({ event: 'typo.event', lastError: "нет обработчика on('typo.event')" })
    expect(errors.filter((e) => e.includes('провалено после 3 попыток'))).toHaveLength(2)
    expect(log.some((e) => e.kind === 'task' && e.failed === true)).toBe(true)
    // key свободен: новая задача с тем же ключом ставится
    await emit(db, 'broken', { x: 2 }, { key: 'k' })
    expect(await db.c[SCHEDULED]!.count({ key: 'k' })).toBe(1)
    await s.stop()
    await db.close()
  })

  test('119. пропущенные за время простоя выполняются при старте; упал посреди обработчика - выполнится снова', async () => {
    const dir = tmpDir('sch-restart')
    // сервер лежал: задачи поставлены, их время прошло
    const db0 = await openDb({ dir, fsync: false })
    await emit(db0, 'late', 1, { after: '10ms' })
    await emit(db0, 'late', 2, { after: '20ms' })
    await emit(db0, 'slow', 3)
    await db0.close()
    await sleep(50)

    const seen: unknown[] = []
    let release!: () => void
    const hang = new Promise<void>((r) => (release = r))
    const a = await setup(
      {
        late: ({ data, task }) => void seen.push({ data, late: Date.now() - task!.runAt > 0 }),
        slow: () => hang, // "процесс упадёт" посреди этого обработчика
      },
      { timeoutMs: 5000 },
      dir,
    )
    expect(await a.s.start()).toBe(3)
    await waitFor(() => seen.length === 2, 2000)
    expect(seen).toEqual([
      { data: 1, late: true },
      { data: 2, late: true },
    ])
    // остановка ждёт начатые обработчики: slow закончит и задача удалится
    const stopping = a.s.stop()
    release()
    await stopping
    await a.db.close()

    const db2 = await openDb({ dir, fsync: false })
    const slowLeft = await db2.c[SCHEDULED]!.count({ event: 'slow' })
    await db2.close()
    expect(slowLeft).toBe(0)

    // жёсткий случай: обработчик успел отработать, удалить задачу - нет
    const db3 = await openDb({ dir, fsync: false })
    await emit(db3, 'once', 'x')
    await db3.close()
    const runs: number[] = []
    const b = await setup({ once: ({ task }) => void runs.push(task!.attempt) }, {}, dir)
    // подменяем remove: "процесс упал" сразу после обработчика
    const realRemove = b.db.c[SCHEDULED]!.remove
    ;(b.db.c[SCHEDULED] as any).constructor.prototype.remove = async function (this: any, id: string) {
      if (this.name === SCHEDULED) throw new Error('процесс упал')
      return realRemove.call(this, id)
    }
    await b.s.start()
    await waitFor(() => runs.length >= 1, 2000)
    await b.s.stop()
    ;(b.db.c[SCHEDULED] as any).constructor.prototype.remove = realRemove
    await b.db.close()
    const c = await setup({ once: ({ task }) => void runs.push(task!.attempt) }, {}, dir)
    await c.s.start()
    await waitFor(() => runs.length >= 2, 2000)
    await c.s.idle()
    expect(runs.length).toBeGreaterThanOrEqual(2) // минимум один раз - на деле дважды
    expect(await c.db.c[SCHEDULED]!.count({ event: 'once' })).toBe(0)
    await c.s.stop()
    await c.db.close()
  })

  test('120. 300 задач, 4 одновременно: каждая ровно один раз, одновременно не больше 4', async () => {
    const done = new Map<number, number>()
    let active = 0
    let max = 0
    const { db, s } = await setup(
      {
        job: async ({ data }) => {
          max = Math.max(max, ++active)
          await sleep(1)
          active--
          done.set(data, (done.get(data) ?? 0) + 1)
        },
      },
      { concurrency: 4 },
    )
    await s.start()
    await db.transaction((tx) => {
      for (let i = 0; i < 300; i++) tx.emit('job', i, { after: 0 })
    })
    await waitFor(() => done.size === 300, 10_000)
    await s.idle()
    expect([...done.values()].every((n) => n === 1)).toBe(true)
    expect(max).toBe(4)
    expect(await db.c[SCHEDULED]!.count()).toBe(0)
    await s.stop()
    await db.close()
  })
})

describe('чат: письмо о приглашении', () => {
  test('121. invite ставит задачу в своей транзакции, письмо уходит через mail.send; приняли раньше - письма нет', async () => {
    const { cpSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { loadProject, parseArgs } = await import('../src/cli')
    const api = await import('../src/api')
    const { openApp, startServer } = await import('../src/server')
    const root = tmpDir('chat-mail')
    for (const f of ['mabase.config.ts', 'seed.ts', 'mb_hooks']) cpSync(join(import.meta.dir, '..', '..', 'chat', f), join(root, f), { recursive: true })
    const { flags } = parseArgs(['serve', '--root', root, '--port', '0', '--host', '127.0.0.1'])
    const { config, seed } = await loadProject(flags, { seed: true })
    const mails: Array<{ to: string; subject: string }> = []
    Object.assign(config, { env: {}, onWarning: () => {}, db: { fsync: false }, mail: { onDevMail: (m: any) => void mails.push(m) } })
    const app = await openApp(config)
    await seed!.seed({ db: app.db.c, auth: app.auth })
    await app.close()
    const s = await startServer(config)
    api.bindMailer(s.mail) // как в mabase serve
    try {
      const alice = s.actions
      const aliceUser = (await s.db.c.users!.findOne({ email: 'alice@example.test' }))!
      await s.db.c.rooms!.insert({ _id: 'third', name: 'Третья', ownerId: aliceUser._id, participants: [aliceUser._id] })
      await alice.run('invite', { roomId: 'third', email: 'bob@example.test' }, { id: aliceUser._id })
      await waitFor(() => mails.length === 1, 3000)
      expect(mails[0]).toMatchObject({ to: 'bob@example.test', subject: 'Алиса приглашает вас в "Третья"' })
      await s.scheduler.idle()
      expect(await s.db.c._scheduled!.count()).toBe(0)

      // приглашение приняли раньше, чем пришло время письма - письма нет
      const carol = (await s.db.c.users!.findOne({ email: 'carol@example.test' }))!
      await s.db.transaction(async (tx) => {
        const inv = await tx.c.invites!.insert({ roomId: 'third', roomName: 'Третья', from: aliceUser._id, to: carol._id })
        tx.emit('invite.email', { inviteId: inv._id }, { after: '100ms' })
        await tx.c.invites!.remove(inv._id)
      })
      await sleep(200)
      await s.scheduler.idle()
      expect(mails).toHaveLength(1)
    } finally {
      api.bindMailer(null)
      await s.stop()
    }
  }, 30_000)
})

// Действия (design.md §10) и emit в транзакции (§13: постановка задачи).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { Actions, defineAction, toClientError, type ActionRunInfo } from '../src/actions'
import { openDb, SCHEDULED, type CommitInfo } from '../src/db'
import { ActionError } from '../src/errors'
import { currentLogPath, sleep, tmpDir } from './helpers'

const alice = { id: 'alice' }
const bob = { id: 'bob' }

async function setup(defs: Parameters<typeof defineAction>[1][] | ReturnType<typeof defineAction>[], more = {}) {
  const dir = tmpDir('a')
  const db = await openDb({ dir, fsync: false, compactMinBytes: 0, ...more })
  const errors: unknown[] = []
  const actions = new Actions(db, defs as any, { onError: (e) => errors.push(e) })
  const runs: ActionRunInfo[] = []
  actions.onRun((i) => runs.push(i))
  const commits: CommitInfo[] = []
  db.onCommit((c) => commits.push(c))
  return { db, dir, actions, errors, runs, commits }
}

// Ошибка, которую получит клиент.
async function clientError(p: Promise<unknown>) {
  try {
    await p
  } catch (err) {
    return toClientError(err)
  }
  throw new Error('ожидалась ошибка')
}

describe('действия', () => {
  test('37. действие атомарно: ActionError после записей - ничего не сохранено', async () => {
    const transfer = defineAction('transfer', {
      input: z.object({ amount: z.number().positive() }),
      handler: async ({ input, db }) => {
        await db.accounts!.update('a', { $inc: { balance: -input.amount } })
        await db.accounts!.update('b', { $inc: { balance: input.amount } })
        const a = await db.accounts!.findOne({ _id: 'a' }) // видит свою запись
        if (a!.balance < 0) throw new ActionError('conflict', 'Недостаточно средств', { balance: a!.balance + input.amount })
        return { balance: a!.balance }
      },
    })
    const { db, actions, commits } = await setup([transfer])
    await db.c.accounts!.insertMany([{ _id: 'a', balance: 100 }, { _id: 'b', balance: 0 }])
    const tx = db.lastTx

    expect(await actions.run('transfer', { amount: 30 }, alice)).toEqual({ balance: 70 })
    expect(await clientError(actions.run('transfer', { amount: 500 }, alice))).toEqual({
      status: 409,
      code: 'conflict',
      message: 'Недостаточно средств',
      details: { balance: 70 },
    })
    expect(db.peek('accounts', 'a')!.balance).toBe(70)
    expect(db.peek('accounts', 'b')!.balance).toBe(30)
    expect(db.lastTx).toBe(tx + 1) // упавшее действие строку в лог не добавило
    expect(commits.at(-1)!.ops).toHaveLength(2) // обе записи - одна транзакция
    await db.close()
  })

  test('38. вход и input проверяются до транзакции: очередь не занимается', async () => {
    let calls = 0
    const send = defineAction('send', {
      input: z.object({ text: z.string().min(1).max(10) }),
      handler: async ({ input, user, db }) => {
        calls++
        return db.messages!.insert({ text: input.text, authorId: user.id })
      },
    })
    const ping = defineAction('ping', { public: true, handler: ({ user }) => ({ user: user?.id ?? null }) })
    const noInput = defineAction('noInput', { handler: () => 'ok' })
    const { db, actions } = await setup([send, ping, noInput])

    // занять очередь записи надолго: проверки до транзакции её не ждут
    let release!: () => void
    const blocker = db.transaction(async (tx) => {
      await tx.c.x!.find()
      await new Promise<void>((r) => (release = r))
    })
    await sleep(10)
    const t0 = performance.now()
    expect(await clientError(actions.run('send', { text: 'привет' }, null))).toMatchObject({ status: 401, code: 'unauthorized' })
    const bad = await clientError(actions.run('send', { text: '' }, alice))
    expect(bad).toMatchObject({ status: 400, code: 'bad_request' })
    expect(bad.details).toEqual([{ path: 'text', message: expect.any(String) }])
    expect(await clientError(actions.run('nope', {}, alice))).toMatchObject({ status: 404, code: 'not_found' })
    expect(await clientError(actions.run('noInput', { x: 1 }, alice))).toMatchObject({ status: 400 })
    expect(performance.now() - t0).toBeLessThan(50) // не ждали занятую очередь
    expect(calls).toBe(0)
    release()
    await blocker

    expect(await actions.run('ping', undefined, null)).toEqual({ user: null }) // public: без входа можно
    expect(await actions.run('noInput', {}, alice)).toBe('ok')
    const msg = (await actions.run('send', { text: 'привет' }, alice)) as any
    expect(msg.authorId).toBe('alice')
    await db.close()
  })

  test('39. внутренняя ошибка: клиенту 500 без подробностей, подробности - в onError', async () => {
    const boom = defineAction('boom', {
      handler: async ({ db }) => {
        await db.x!.insert({ a: 1 })
        throw new Error('секретная деталь: пароль от базы')
      },
    })
    const badResult = defineAction('badResult', {
      handler: async ({ db }) => {
        await db.x!.insert({ a: 2 })
        return { at: new Date() } // не переживёт JSON
      },
    })
    const { db, actions, errors, runs } = await setup([boom, badResult])
    const e = await clientError(actions.run('boom', undefined, alice))
    expect(e).toEqual({ status: 500, code: 'internal', message: 'Внутренняя ошибка сервера' })
    expect(JSON.stringify(e)).not.toContain('пароль')
    expect(String(errors[0])).toContain('пароль')
    expect(runs.at(-1)).toMatchObject({ name: 'boom', userId: 'alice', ok: false, code: 'internal' })

    expect((await clientError(actions.run('badResult', undefined, alice))).status).toBe(500)
    expect(await db.c.x!.count()).toBe(0) // ответ проверен до коммита - запись отменена
    await db.close()
  })

  test('40. параллельные действия не теряют обновления', async () => {
    const inc = defineAction('inc', {
      handler: async ({ db }) => {
        const c = await db.counters!.findOne({ _id: 'c' })
        await sleep(0) // дать другим действиям вклиниться, если бы очередь не держалась
        await db.counters!.update('c', { $set: { n: c!.n + 1 } })
      },
    })
    const { db, actions } = await setup([inc])
    await db.c.counters!.insert({ _id: 'c', n: 0 })
    await Promise.all(Array.from({ length: 100 }, () => actions.run('inc', undefined, alice)))
    expect(db.peek('counters', 'c')!.n).toBe(100)
    await db.close()
  })

  test('41. внешний вызов до первого обращения к базе не держит очередь и не ловит таймаут', async () => {
    const slowFetch = defineAction('slowFetch', {
      handler: async ({ db }) => {
        await sleep(300) // "fetch" до базы: очередь ещё не взята
        await db.x!.insert({ ok: true })
      },
    })
    const slowInside = defineAction('slowInside', {
      handler: async ({ db, signal }) => {
        await db.x!.insert({ ok: false })
        await sleep(300) // "fetch" после базы: держит очередь всей базы
        if (signal.aborted) return
        await db.x!.insert({ late: true })
      },
    })
    const { db, actions } = await setup([slowFetch, slowInside], { txTimeoutMs: 100 })
    await actions.run('slowFetch', undefined, alice)
    expect(await clientError(actions.run('slowInside', undefined, alice))).toMatchObject({ status: 500 })
    await sleep(350)
    expect((await db.c.x!.find()).map((d) => d.ok)).toEqual([true])
    await db.close()
  })
})

describe('emit', () => {
  test('42. события уходят подписчикам только после коммита; упавшее действие - без событий', async () => {
    const pay = defineAction('pay', {
      input: z.object({ fail: z.boolean() }),
      handler: async ({ input, db, emit }) => {
        await db.orders!.insert({ _id: 'o1', paid: true })
        emit('order.paid', { orderId: 'o1' })
        if (input.fail) throw new ActionError('conflict', 'нет')
      },
    })
    const onlyEvent = defineAction('onlyEvent', { handler: ({ emit }) => emit('hello', { n: 1 }) })
    const { db, actions, commits } = await setup([pay, onlyEvent])

    await clientError(actions.run('pay', { fail: true }, alice))
    expect(commits).toHaveLength(0)
    await actions.run('pay', { fail: false }, alice)
    expect(commits).toHaveLength(1)
    expect(commits[0]!.events).toEqual([{ event: 'order.paid', data: { orderId: 'o1' } }])
    expect(commits[0]!.tx).toBe(db.lastTx)
    expect(Object.isFrozen(commits[0]!.events[0]!.data)).toBe(true)

    // действие без записей: событие всё равно уходит, с номером последней транзакции
    await actions.run('onlyEvent', undefined, alice)
    expect(commits[1]).toMatchObject({ tx: db.lastTx, ops: [], events: [{ event: 'hello', data: { n: 1 } }] })
    await db.close()
  })

  test('43. отложенное событие - в той же строке лога; key не даёт поставить дубль', async () => {
    const invite = defineAction('invite', {
      input: z.object({ to: z.string(), fail: z.boolean().default(false) }),
      handler: async ({ input, db, emit }) => {
        const inv = await db.invites!.upsert({ _id: `general:${input.to}` }, { to: input.to })
        emit('invite.email', { inviteId: inv._id }, { after: '0s', key: `invite:${inv._id}` })
        emit('invite.email', { inviteId: inv._id }, { after: '0s', key: `invite:${inv._id}` }) // дубль в той же транзакции
        if (input.fail) throw new ActionError('conflict', 'нет')
      },
    })
    const remind = defineAction('remind', {
      handler: ({ emit }) => emit('remind', { at: 1 }, { after: '5m' }), // без записей и без key
    })
    const { db, dir, actions } = await setup([invite, remind])

    await clientError(actions.run('invite', { to: 'carol', fail: true }, alice))
    expect(await db.c[SCHEDULED]!.count()).toBe(0) // действие упало - задачи нет

    const t0 = Date.now()
    await actions.run('invite', { to: 'carol' }, alice)
    const lines = readFileSync(currentLogPath(dir), 'utf8').trim().split('\n')
    const last = JSON.parse(lines.at(-1)!)
    expect(last.ops.map((o: any) => o.c).sort()).toEqual([SCHEDULED, 'invites']) // одна строка лога
    const [task] = await db.c[SCHEDULED]!.find()
    expect(task).toMatchObject({ event: 'invite.email', data: { inviteId: 'general:carol' }, key: 'invite:general:carol', attempts: 0 })
    expect(task!.runAt).toBeGreaterThanOrEqual(t0)

    await actions.run('invite', { to: 'carol' }, alice) // повторный запрос: задача с этим key уже стоит
    expect(await db.c[SCHEDULED]!.count({ key: 'invite:general:carol' })).toBe(1)

    await actions.run('remind', undefined, alice)
    const r = await db.c[SCHEDULED]!.findOne({ event: 'remind' })
    expect(r!.runAt - Date.now()).toBeGreaterThan(4 * 60_000)
    expect(() => db.collection(SCHEDULED)).toThrow(/системная/)
    await db.close()
  })
})

// Логика из examples/chat/mabase.config.ts на настоящем ядре: ровно те действия.
describe('чат на действиях', () => {
  const roomActions = () => [
    defineAction('createRoom', {
      input: z.object({ name: z.string().min(1).max(80) }),
      handler: ({ input, user, db }) => db.rooms!.insert({ name: input.name, ownerId: user.id, participants: [user.id] }),
    }),
    defineAction('invite', {
      input: z.object({ roomId: z.string(), userId: z.string() }),
      handler: async ({ input, user, db, emit }) => {
        const room = await db.rooms!.findOne({ _id: input.roomId, ownerId: user.id })
        if (!room) throw new ActionError('not_found', 'Комната не найдена')
        if (room.participants.includes(input.userId)) throw new ActionError('conflict', 'Уже в комнате')
        const existing = await db.invites!.findOne({ roomId: room._id, to: input.userId })
        if (existing) return existing
        const inv = await db.invites!.insert({ roomId: room._id, from: user.id, to: input.userId })
        emit('invite.email', { inviteId: inv._id }, { after: '0s', key: `invite:${inv._id}` })
        return inv
      },
    }),
    defineAction('acceptInvite', {
      input: z.object({ inviteId: z.string() }),
      handler: async ({ input, user, db }) => {
        const inv = await db.invites!.findOne({ _id: input.inviteId, to: user.id })
        if (!inv) throw new ActionError('not_found', 'Приглашение не найдено')
        await db.invites!.remove(inv._id)
        await db.rooms!.update(inv.roomId, { $push: { participants: user.id } })
        return { roomId: inv.roomId }
      },
    }),
    defineAction('kick', {
      input: z.object({ roomId: z.string(), userId: z.string() }),
      handler: async ({ input, user, db }) => {
        const room = await db.rooms!.findOne({ _id: input.roomId, ownerId: user.id })
        if (!room) throw new ActionError('not_found', 'Комната не найдена')
        if (input.userId === user.id) throw new ActionError('bad_request', 'Нельзя выгнать себя')
        await db.rooms!.update(room._id, { $pull: { participants: input.userId } })
      },
    }),
  ]

  test('44. создать комнату, пригласить, принять, выгнать', async () => {
    const { db, actions } = await setup(roomActions())
    db.collection('rooms', { indexes: ['participants', 'ownerId'] })
    db.collection('invites', { indexes: ['to', 'roomId'] })

    const room = (await actions.run('createRoom', { name: 'Общая' }, alice)) as any
    const inv = (await actions.run('invite', { roomId: room._id, userId: 'bob' }, alice)) as any
    expect((await actions.run('invite', { roomId: room._id, userId: 'bob' }, alice)) as any).toEqual(inv) // идемпотентно
    expect(await db.c[SCHEDULED]!.count({ event: 'invite.email' })).toBe(1)

    // Боб не владелец - пригласить не может, и это не 500
    expect(await clientError(actions.run('invite', { roomId: room._id, userId: 'carol' }, bob))).toMatchObject({ status: 404 })
    // чужое приглашение не принять
    expect(await clientError(actions.run('acceptInvite', { inviteId: inv._id }, { id: 'carol' }))).toMatchObject({ status: 404 })

    expect(await actions.run('acceptInvite', { inviteId: inv._id }, bob)).toEqual({ roomId: room._id })
    expect((await db.c.rooms!.find({ participants: 'bob' })).map((r) => r._id)).toEqual([room._id])
    expect(await db.c.invites!.count()).toBe(0)
    expect(await clientError(actions.run('invite', { roomId: room._id, userId: 'bob' }, alice))).toMatchObject({ status: 409 })

    await actions.run('kick', { roomId: room._id, userId: 'bob' }, alice)
    expect(await db.c.rooms!.count({ participants: 'bob' })).toBe(0)
    expect(await clientError(actions.run('kick', { roomId: room._id, userId: 'alice' }, alice))).toMatchObject({ status: 400 })
    expect(db.verifyIndexes()).toEqual([])
    await db.close()
  })
})

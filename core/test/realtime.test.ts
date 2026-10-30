// Realtime (design.md §12): подписки, reset по dependsOn, реконнект, события,
// presence, сессия соединения, лимиты, настоящий WebSocket и tail.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Access, type AccessDef } from '../src/access'
import { Auth } from '../src/auth'
import { Bus, type Handler } from '../src/bus'
import { openDb, type CollectionApi, type Db } from '../src/db'
import { Mailer } from '../src/mail'
import { Realtime, type EventConfig } from '../src/realtime'
import { startServer } from '../src/server'
import { sleep, tmpDir, waitFor } from './helpers'

const SECRET = 'test-secret-'.padEnd(48, 'x')

const roomIdsOf = async (db: Record<string, CollectionApi>, userId: string) =>
  (await db.rooms!.find({ participants: userId }, { fields: ['_id'] })).map((r) => r._id)

const defs: Record<string, AccessDef> = {
  rooms: { rules: { list: (u) => (u ? { participants: u.id } : false) } },
  messages: {
    owner: 'authorId',
    fields: { hidden: ['ip'], private: ['draft'] },
    rules: {
      dependsOn: ['rooms'],
      list: async (u, { db }) => (u ? { roomId: { $in: await roomIdsOf(db, u.id) } } : false),
    },
  },
  // админам видно всё, остальным - только своё (роль меняется - фильтр меняется)
  notes: { rules: { list: (u) => (u ? (u.roles?.includes('admin') ? true : { ownerId: u.id }) : false) } },
  _presence: { rules: { dependsOn: ['rooms'], list: (u) => (u ? true : false) } },
  // медленное правило: читает rooms, потом ждёт - окно для гонок; нет комнат - отказ
  slow: {
    rules: {
      dependsOn: ['rooms'],
      list: async (u, { db }) => {
        if (!u) return false
        const ids = await roomIdsOf(db, u.id)
        await sleep(slowMs.value)
        return ids.length ? { roomId: { $in: ids } } : false
      },
    },
  },
}
const slowMs = { value: 0 }

const events: Record<string, EventConfig> = {
  typing: {
    from: 'client',
    input: z.object({ roomId: z.string() }),
    allow: async (user, data, { db }) => (await roomIdsOf(db, user.id)).includes(data.roomId),
    to: async (data, { db }) => (await db.rooms!.findOne({ _id: data.roomId }))?.participants ?? [],
  },
  'room.renamed': { to: async (data, { db }) => (await db.rooms!.findOne({ _id: data.roomId }))?.participants ?? [] },
  announce: { broadcast: 'authenticated' },
}

async function setup(o: { handlers?: Map<string, Handler[]> } = {}) {
  const db = await openDb({ dir: tmpDir('rt'), fsync: false, compactMinBytes: 0 })
  db.collection('rooms', { indexes: ['participants'] })
  db.collection('messages', { indexes: ['roomId'] })
  db.collection('notes', { indexes: ['ownerId'] })
  db.collection('_presence', { indexes: ['userId'] })
  db.collection('slow', { indexes: ['roomId'] })
  const access = new Access(db, defs)
  const auth = new Auth(access, { secret: SECRET, mail: new Mailer({ onDevMail: () => {} }) })
  const errors: string[] = []
  const rt = new Realtime(access, auth, { events, onError: (_, w) => void errors.push(w), clientEventsPerSecond: 5, verifyIntervalMs: 50 })
  await rt.start()
  const bus = new Bus(db, () => o.handlers ?? new Map(), { onError: (_, w) => void errors.push(w) })
  const users: Record<string, { id: string; token: string; refresh: string }> = {}
  for (const name of ['alice', 'bob', 'carol']) {
    await auth.upsertUser({ email: `${name}@example.test`, password: `${name}-pass-1` })
    const s = await auth.login({ email: `${name}@example.test`, password: `${name}-pass-1` })
    users[name] = { id: s.user._id, token: s.accessToken, refresh: s.refreshToken }
  }
  const { alice, bob, carol } = users as Record<'alice' | 'bob' | 'carol', { id: string; token: string; refresh: string }>
  await db.c.rooms!.insertMany([
    { _id: 'general', name: 'Общая', participants: [alice.id, bob.id] },
    { _id: 'private', name: 'Кэрол', participants: [carol.id] },
  ])
  return { db, access, auth, rt, bus, alice, bob, carol, errors }
}

// Поддельное соединение: что сервер прислал, закрыл ли он.
function client(rt: Realtime) {
  const inbox: any[] = []
  let closed: { code: number; reason: string } | null = null
  const conn = rt.connect(
    (t) => inbox.push(JSON.parse(t)),
    (code, reason) => (closed = { code, reason }),
  )
  const send = (m: unknown) => conn.receive(typeof m === 'string' ? m : JSON.stringify(m))
  return { conn, inbox, send, closed: () => closed, of: (type: string) => inbox.filter((m) => m.type === type) }
}

async function connected(rt: Realtime, token?: string) {
  const c = client(rt)
  await c.send({ type: 'hello', token })
  return c
}

// Все изменения подписки по порядку: [op, id или текст]
const ops = (c: ReturnType<typeof client>, sub: string) =>
  c.of('changes').flatMap((m) => m.items.filter((i: any) => i.sub === sub).map((i: any) => [i.op, i.doc?.text ?? i.id]))

describe('realtime', () => {
  test('89. hello, presence, user.online/offline по вкладкам', async () => {
    const online: string[] = []
    const handlers = new Map<string, Handler[]>([
      ['user.online', [({ data }) => void online.push(`+${data.userId}`)]],
      ['user.offline', [({ data }) => void online.push(`-${data.userId}`)]],
    ])
    const { db, rt, bus, bob, alice } = await setup({ handlers })
    const first = client(rt)
    await first.send({ type: 'sub', id: 's', collection: 'rooms' })
    expect(first.of('error')[0]).toMatchObject({ code: 'bad_request', message: 'Первое сообщение - hello' })

    const guest = await connected(rt)
    expect(guest.of('ready')[0]).toMatchObject({ user: null, tx: db.lastTx })
    const bad = client(rt)
    await bad.send({ type: 'hello', token: 'garbage.token' })
    expect(bad.closed()).toMatchObject({ code: 4001 })

    const tab1 = await connected(rt, bob.token)
    const tab2 = await connected(rt, bob.token)
    const a = await connected(rt, alice.token)
    expect(tab1.of('ready')[0].user).toBe(bob.id)
    expect(await db.c._presence!.count({ userId: bob.id })).toBe(2)
    tab1.conn.close(1000, 'закрыл вкладку')
    await tab1.conn.closedByClient()
    expect(await db.c._presence!.count({ userId: bob.id })).toBe(1)
    await tab2.conn.closedByClient()
    await a.conn.closedByClient()
    await bus.settled()
    expect(online).toEqual([`+${bob.id}`, `+${alice.id}`, `-${bob.id}`, `-${alice.id}`]) // online один раз на две вкладки
    expect(await db.c._presence!.count({})).toBe(0)

    // presence прошлого запуска стирается при старте
    await db.c._presence!.insert({ _id: 'stale', userId: 'x', connectedAt: 0 })
    await rt.start()
    expect(await db.c._presence!.count({})).toBe(0)
    await rt.stop()
    await db.close()
  })

  test('90. подписка: added/updated/removed по правилу и фильтру; скрытые поля; одно сообщение на коммит', async () => {
    const { db, rt, alice, bob, carol } = await setup()
    const b = await connected(rt, bob.token)
    const c = await connected(rt, carol.token)
    await b.send({ type: 'sub', id: 'feed', collection: 'messages', filter: { roomId: 'general' } })
    await b.send({ type: 'sub', id: 'all', collection: 'messages' })
    await c.send({ type: 'sub', id: 'all', collection: 'messages' })
    expect(b.of('subscribed').map((m) => m.id)).toEqual(['feed', 'all'])

    const m = await db.c.messages!.insert({ roomId: 'general', authorId: alice.id, text: 'привет', ip: '10.0.0.1', draft: 'черновик' })
    await db.c.messages!.insert({ roomId: 'private', authorId: carol.id, text: 'тайна' })
    await db.c.messages!.update(m._id, { $set: { text: 'привет!' } })
    await db.transaction(async (tx) => {
      await tx.c.messages!.update(m._id, { $set: { roomId: 'private' } }) // ушло из видимого
      await tx.c.messages!.insert({ roomId: 'general', authorId: bob.id, text: 'в той же транзакции' })
    })
    await rt.settled()
    expect(ops(b, 'feed')).toEqual([
      ['added', 'привет'],
      ['updated', 'привет!'],
      ['removed', m._id],
      ['added', 'в той же транзакции'],
    ])
    expect(ops(b, 'all').map((x) => x[1])).not.toContain('тайна') // чужая комната
    expect(ops(c, 'all')).toEqual([
      ['added', 'тайна'],
      ['added', 'привет!'], // переехало в комнату Кэрол - для неё added
    ])
    const added = b.of('changes')[0].items[0].doc
    expect(added.ip).toBeUndefined() // hidden
    expect(added.draft).toBeUndefined() // private чужого автора
    const removed = b.of('changes')[2].items.find((i: any) => i.op === 'removed')
    expect(removed).toEqual({ sub: 'feed', op: 'removed', id: m._id }) // без данных
    expect(b.of('changes')[2].items).toHaveLength(4) // одна транзакция - одно сообщение: feed и all, по removed и added
    expect(b.of('changes').map((x) => x.tx)).toEqual([...b.of('changes').map((x) => x.tx)].sort((x, y) => x - y))

    await b.send({ type: 'unsub', id: 'feed' })
    await db.c.messages!.insert({ roomId: 'general', authorId: alice.id, text: 'после отписки' })
    await rt.settled()
    expect(ops(b, 'feed').at(-1)).toEqual(['added', 'в той же транзакции'])
    await rt.stop()
    await db.close()
  })

  test('91. dependsOn: выгнанный получает reset до следующего сообщения комнаты и больше их не видит', async () => {
    const { db, rt, alice, bob } = await setup()
    const b = await connected(rt, bob.token)
    await b.send({ type: 'sub', id: 'feed', collection: 'messages', filter: { roomId: 'general' } })
    await db.c.messages!.insert({ roomId: 'general', authorId: alice.id, text: 'до' })
    // kick и сразу новое сообщение - отдельными транзакциями, без пауз
    const kick = db.c.rooms!.update('general', { $pull: { participants: bob.id } })
    const after = db.c.messages!.insert({ roomId: 'general', authorId: alice.id, text: 'после kick' })
    await Promise.all([kick, after])
    // и в одной транзакции: снова добавить и тут же выгнать с сообщением
    await db.transaction(async (tx) => {
      await tx.c.rooms!.update('general', { $set: { name: 'Общая 2' } })
      await tx.c.messages!.insert({ roomId: 'general', authorId: alice.id, text: 'в транзакции с rooms' })
    })
    await rt.settled()
    const seq = b.inbox.filter((m) => m.type === 'changes' || m.type === 'reset').map((m) => (m.type === 'reset' ? 'reset' : m.items.map((i: any) => i.doc?.text).join()))
    expect(seq).toEqual(['до', 'reset'])

    // вернули в комнату - снова reset и снова видит
    await db.c.rooms!.update('general', { $push: { participants: bob.id } })
    await db.c.messages!.insert({ roomId: 'general', authorId: alice.id, text: 'вернулся' })
    await rt.settled()
    expect(b.of('reset')).toHaveLength(2)
    expect(ops(b, 'feed').at(-1)).toEqual(['added', 'вернулся'])

    // rooms поменялись, но фильтр Боба тот же - reset не нужен
    await db.c.rooms!.update('private', { $set: { name: 'Кэрол 2' } })
    await rt.settled()
    expect(b.of('reset')).toHaveLength(2)
    await rt.stop()
    await db.close()
  })

  test('92. реконнект: подписка -> буфер -> чтение с tx -> буфер с большим tx = состояние сервера (под нагрузкой)', async () => {
    const { db, access, rt, alice, bob } = await setup()
    for (let round = 0; round < 5; round++) {
      // своя комната на раунд: чтение не упирается в limit 1000
      const room = `r${round}`
      await db.c.rooms!.insert({ _id: room, participants: [alice.id, bob.id] })
      // писатели работают всё время, пока клиент переподключается
      let stop = false
      const writers = [0, 1, 2].map(async (w) => {
        // новые документы, правки и удаления старых: пропущенное событие не
        // закроется следующим изменением того же документа
        let i = 0
        while (!stop) {
          const id = `w${round}-${w}-${i++}`
          await db.c.messages!.insert({ _id: id, roomId: room, authorId: alice.id, text: `${id} v0` })
          const old = `w${round}-${w}-${i - 3}`
          if (i % 3 === 0 && db.peek('messages', old)) await db.c.messages!.update(old, { $set: { text: `${old} v1` } })
          if (i % 4 === 0 && db.peek('messages', `w${round}-${w}-${i - 2}`)) await db.c.messages!.remove(`w${round}-${w}-${i - 2}`)
        }
      })
      await sleep(5)
      const b = await connected(rt, bob.token)
      await b.send({ type: 'sub', id: 'feed', collection: 'messages', filter: { roomId: room } })
      await sleep(Math.random() * 5)
      const read = await access.forUser({ id: bob.id }).c.messages!.list({ roomId: room }, { limit: 1000 })
      expect(read.items.length).toBeLessThan(1000)
      await sleep(10)
      stop = true
      await Promise.all(writers)
      await rt.settled()
      // клиент: состояние из чтения + изменения с tx больше прочитанного
      const state = new Map(read.items.map((d) => [d._id, d.text]))
      for (const m of b.of('changes')) {
        if (m.tx <= read.tx) continue
        for (const it of m.items) {
          if (it.op === 'removed') state.delete(it.id)
          else state.set(it.doc._id, it.doc.text)
        }
      }
      const truth = new Map((await db.c.messages!.find({ roomId: room })).map((d) => [d._id, d.text]))
      expect([...state].sort()).toEqual([...truth].sort())
      await b.conn.closedByClient()
    }
    await rt.stop()
    await db.close()
  }, 30_000)

  test('93. клиентские события: только объявленные, схема, allow, получатели из to, from ставит сервер, лимит', async () => {
    const { db, rt, alice, bob, carol } = await setup()
    const a = await connected(rt, alice.token)
    const b1 = await connected(rt, bob.token)
    const b2 = await connected(rt, bob.token) // вторая вкладка Боба
    const c = await connected(rt, carol.token)
    const g = await connected(rt)
    await a.send({ type: 'emit', event: 'typing', data: { roomId: 'general', from: 'подделка' } })
    for (const x of [a, b1, b2]) expect(x.of('event')).toEqual([{ type: 'event', event: 'typing', from: alice.id, data: { roomId: 'general' } }])
    expect(c.of('event')).toEqual([]) // не участник

    await c.send({ type: 'emit', event: 'typing', data: { roomId: 'general' } }) // не участник - allow
    expect(c.of('error').at(-1)).toMatchObject({ code: 'forbidden' })
    await a.send({ type: 'emit', event: 'room.renamed', data: { roomId: 'general' } }) // серверное
    expect(a.of('error').at(-1)).toMatchObject({ code: 'forbidden' })
    await a.send({ type: 'emit', event: 'nope', data: {} })
    expect(a.of('error').at(-1)).toMatchObject({ code: 'forbidden' })
    await a.send({ type: 'emit', event: 'typing', data: { roomId: 1 } })
    expect(a.of('error').at(-1)).toMatchObject({ code: 'bad_request', details: [expect.objectContaining({ path: 'roomId' })] })
    await g.send({ type: 'emit', event: 'typing', data: { roomId: 'general' } })
    expect(g.of('error').at(-1)).toMatchObject({ code: 'unauthorized' })
    // лимит 5 в секунду на соединение (2 уже ушли выше)
    for (let i = 0; i < 6; i++) await a.send({ type: 'emit', event: 'typing', data: { roomId: 'general' } })
    expect(a.of('error').filter((e) => e.code === 'too_many_requests').length).toBeGreaterThan(0)
    await rt.stop()
    await db.close()
  })

  test('94. серверные события: to считается один раз, broadcast; без описания - только on() на сервере', async () => {
    const got: string[] = []
    const handlers = new Map<string, Handler[]>([['secret.fact', [({ data }) => void got.push(data.x)]]])
    const { db, rt, bus, alice, bob, carol } = await setup({ handlers })
    const a = await connected(rt, alice.token)
    const b = await connected(rt, bob.token)
    const c = await connected(rt, carol.token)
    const g = await connected(rt)
    await db.transaction(async (tx) => {
      await tx.c.rooms!.update('general', { $set: { name: 'Новое' } })
      tx.emit('room.renamed', { roomId: 'general', name: 'Новое' })
      tx.emit('secret.fact', { x: 'только серверу' })
      tx.emit('announce', { text: 'всем вошедшим' })
    })
    await rt.settled()
    await bus.settled()
    const ev = (x: ReturnType<typeof client>) => x.of('event').map((m) => m.event)
    expect(ev(a)).toEqual(['room.renamed', 'announce'])
    expect(ev(b)).toEqual(['room.renamed', 'announce'])
    expect(ev(c)).toEqual(['announce'])
    expect(ev(g)).toEqual([])
    expect(a.of('event')[0]).toMatchObject({ tx: db.lastTx, eventId: `${db.lastTx}:0`, data: { name: 'Новое' } })
    expect(got).toEqual(['только серверу'])
    await rt.stop()
    await db.close()
  })

  test('95. on(): события записей с doc и prev, ошибка обработчика не мешает, обработчик пишет в базу', async () => {
    const seen: string[] = []
    const handlers = new Map<string, Handler[]>([
      ['notes.created', [async ({ data, db }) => void (await db.notes!.update(data.doc._id, { $set: { seen: true } }))]],
      ['notes.updated', [({ data }) => void seen.push(`${data.prev.text}->${data.doc.text}`)]],
      ['notes.deleted', [({ data }) => void seen.push(`удалена ${data.prev.text}`), () => { throw new Error('упал') }]],
    ])
    const { db, bus, errors, rt } = await setup({ handlers })
    const n = await db.c.notes!.insert({ text: 'раз', ownerId: 'u' })
    await bus.settled()
    expect(db.peek('notes', n._id)!.seen).toBe(true) // обработчик записал новой транзакцией
    await db.c.notes!.update(n._id, { $set: { text: 'два' } })
    await db.c.notes!.remove(n._id)
    await bus.settled()
    expect(seen).toEqual(['раз->раз', 'раз->два', 'удалена два']) // первая правка - от самого обработчика
    expect(errors).toEqual(['on(notes.deleted)'])
    await rt.stop()
    await db.close()
  })

  test('96. сессия соединения: выход закрывает сокет, чужой токен - тоже, роли меняют подписки', async () => {
    const { db, auth, rt, alice, bob } = await setup()
    const b = await connected(rt, bob.token)
    await auth.logout(bob.refresh)
    await waitFor(() => b.closed() !== null) // перепроверка раз в 50 мс
    expect(b.closed()).toMatchObject({ code: 4001 })

    const a = await connected(rt, alice.token)
    await a.send({ type: 'sub', id: 'notes', collection: 'notes' })
    await db.c.notes!.insert({ text: 'чужая', ownerId: 'someone' })
    await db.c.users!.update(alice.id, { $set: { roles: ['admin'] } })
    await waitFor(() => a.of('reset').length === 1) // роль появилась - фильтр стал другим
    await db.c.notes!.insert({ text: 'чужая 2', ownerId: 'someone' })
    await rt.settled()
    expect(ops(a, 'notes')).toEqual([['added', 'чужая 2']])

    const s = await auth.login({ email: 'alice@example.test', password: 'alice-pass-1' })
    await a.send({ type: 'auth', token: s.accessToken }) // новый токен того же пользователя
    expect(a.closed()).toBeNull()
    const bs = await auth.login({ email: 'bob@example.test', password: 'bob-pass-1' })
    await a.send({ type: 'auth', token: bs.accessToken })
    expect(a.closed()).toMatchObject({ code: 4001 })
    await rt.stop()
    await db.close()
  })

  test('97. ошибки и лимиты: фильтр, невидимое поле, повтор id, число подписок, размер, мусор', async () => {
    const { db, access, auth, rt, bob } = await setup()
    const b = await connected(rt, bob.token)
    const errs: string[] = []
    const expectErr = async (m: unknown, code: string) => {
      await b.send(m)
      errs.push(`${b.of('error').at(-1)?.code}`)
      expect(b.of('error').at(-1)?.code).toBe(code)
    }
    await expectErr({ type: 'sub', id: 'x', collection: 'messages', filter: { $where: 'true' } }, 'bad_request')
    await expectErr({ type: 'sub', id: 'x', collection: 'messages', filter: { ip: '1' } }, 'bad_request') // hidden
    await expectErr({ type: 'sub', id: 'x', collection: '_authTokens' }, 'forbidden')
    await b.send({ type: 'sub', id: 'x', collection: 'messages' })
    await expectErr({ type: 'sub', id: 'x', collection: 'messages' }, 'conflict')
    await expectErr('не json', 'bad_request')
    await expectErr({ type: 'what' }, 'bad_request')
    await expectErr(JSON.stringify({ type: 'ping', pad: 'x'.repeat(70_000) }), 'bad_request')
    const g = await connected(rt)
    await g.send({ type: 'sub', id: 'r', collection: 'rooms' })
    expect(g.of('error').at(-1)).toMatchObject({ id: 'r', code: 'unauthorized' })
    const rt2 = new Realtime(access, auth, { maxSubscriptions: 2 })
    const c = client(rt2)
    await c.send({ type: 'hello', token: bob.token })
    for (const id of ['1', '2', '3']) await c.send({ type: 'sub', id, collection: 'rooms' })
    expect(c.of('error')).toEqual([expect.objectContaining({ id: '3', code: 'too_many_requests' })])
    expect(() => new Realtime(access, auth, { events: { e: { from: 'client', to: () => [] } } })).toThrow(/input/)
    expect(() => new Realtime(access, auth, { events: { e: { broadcast: (() => true) as any } } })).toThrow(/broadcast/)
    expect(() => new Realtime(access, auth, { events: { e: {} } })).toThrow(/кому/)
    await rt2.stop()
    await rt.stop()
    await db.close()
  })

  test('98. настоящий WebSocket: hello, подписка, запись по HTTP, presence, tail с holdMs, остановка', async () => {
    const s = await startServer({
      dataDir: tmpDir('rt-srv'),
      port: 0,
      hostname: '127.0.0.1',
      env: {},
      onWarning: () => {},
      db: { fsync: false },
      realtime: true,
      collections: {
        notes: {
          owner: 'ownerId',
          rules: { list: (u) => (u ? { ownerId: u.id } : false), create: (u) => !!u },
          hooks: { beforeCreate: ({ doc, user }) => ({ ...doc, ownerId: user?.id ?? (doc as any).ownerId }) },
        },
      },
    })
    const tailLines: any[] = []
    const tailRes = await fetch(`${s.url}/api/admin/tail`, { headers: { Authorization: `Bearer ${s.adminToken}` } })
    void (async () => {
      let buf = ''
      try {
        for await (const chunk of tailRes.body as unknown as AsyncIterable<Uint8Array>) {
          buf += new TextDecoder().decode(chunk)
          const lines = buf.split('\n')
          buf = lines.pop()!
          for (const l of lines) if (l) tailLines.push(JSON.parse(l))
        }
      } catch {} // сервер остановлен - поток оборвался
    })()
    const reg = await (await fetch(`${s.url}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.test', password: 'alice-pass-1' }) })).json()

    const ws = new WebSocket(s.url.replace('http', 'ws') + '/api/realtime')
    const inbox: any[] = []
    ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)))
    await new Promise((r) => (ws.onopen = r))
    ws.send(JSON.stringify({ type: 'hello', token: reg.accessToken }))
    ws.send(JSON.stringify({ type: 'sub', id: 'n', collection: 'notes' }))
    await waitFor(() => inbox.some((m) => m.type === 'subscribed'), 3000)
    expect(await s.db.c._presence!.count({ userId: reg.user._id })).toBe(1)
    const res = await fetch(`${s.url}/api/c/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reg.accessToken}` }, body: JSON.stringify({ text: 'по HTTP' }) })
    expect(res.status).toBe(200)
    await waitFor(() => inbox.some((m) => m.type === 'changes'), 3000)
    expect(inbox.find((m) => m.type === 'changes').items[0]).toMatchObject({ sub: 'n', op: 'added', doc: { text: 'по HTTP' } })
    const list = await (await fetch(`${s.url}/api/c/notes`, { headers: { Authorization: `Bearer ${reg.accessToken}` } })).json()
    expect(list.tx).toBe(s.db.lastTx) // чтение несёт tx для реконнекта

    await waitFor(() => tailLines.some((l) => l.kind === 'commit' && l.ops?.notes === 1), 3000)
    const commit = tailLines.find((l) => l.kind === 'commit' && l.ops?.notes === 1)
    expect(commit).toMatchObject({ user: reg.user._id, holdMs: expect.any(Number) })
    expect(tailLines.some((l) => l.kind === 'ws' && l.op === 'open')).toBe(true)

    const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)))
    await s.stop()
    expect(await closed).toBe(4500)
    const db = await openDb({ dir: tmpDir('x'), fsync: false }) // база закрыта - presence почищен до закрытия
    await db.close()
  })
})

describe('пример-чат по WebSocket', () => {
  test('99. presence контактов, typing участникам, reset после acceptInvite и kick', async () => {
    const { cpSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { loadProject, parseArgs } = await import('../src/cli')
    const { openApp } = await import('../src/server')
    const root = tmpDir('chat-rt')
    for (const f of ['mabase.config.ts', 'seed.ts', 'mb_hooks']) cpSync(join(import.meta.dir, '..', '..', 'examples', 'chat', f), join(root, f), { recursive: true })
    const { flags } = parseArgs(['serve', '--root', root, '--port', '0', '--host', '127.0.0.1'])
    const { config, seed } = await loadProject(flags, { seed: true })
    config.env = {}
    config.onWarning = () => {}
    config.db = { ...config.db, fsync: false }
    const app = await openApp(config)
    await seed!.seed({ db: app.db.c, auth: app.auth })
    await app.close()
    const s = await startServer(config)
    try {
      const token = async (name: string) =>
        (await (await fetch(`${s.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${name}@example.test`, password: `dev-${name}-1` }) })).json()) as any
      const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map(token))
      const connect = async (t: string) => {
        const ws = new WebSocket(s.url.replace('http', 'ws') + '/api/realtime')
        const inbox: any[] = []
        ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)))
        await new Promise((r) => (ws.onopen = r))
        ws.send(JSON.stringify({ type: 'hello', token: t }))
        await waitFor(() => inbox.some((m) => m.type === 'ready'), 3000)
        return { ws, inbox, send: (m: object) => ws.send(JSON.stringify(m)) }
      }
      const b = await connect(bob.accessToken)
      b.send({ type: 'sub', id: 'feed', collection: 'messages', filter: { roomId: 'general' } })
      b.send({ type: 'sub', id: 'online', collection: '_presence' })
      await waitFor(() => b.inbox.filter((m) => m.type === 'subscribed').length === 2, 3000)

      const a = await connect(alice.accessToken)
      const c = await connect(carol.accessToken)
      const presenceOf = (x: typeof b) => x.inbox.filter((m) => m.type === 'changes').flatMap((m) => m.items.filter((i: any) => i.sub === 'online' && i.op === 'added').map((i: any) => i.doc.userId))
      await waitFor(() => presenceOf(b).includes(alice.user._id), 3000)
      expect(presenceOf(b)).not.toContain(carol.user._id) // нет общей комнаты - не видно

      a.send({ type: 'emit', event: 'typing', data: { roomId: 'general' } })
      c.send({ type: 'emit', event: 'typing', data: { roomId: 'general' } })
      await waitFor(() => b.inbox.some((m) => m.type === 'event') && c.inbox.some((m) => m.type === 'error'), 3000)
      expect(b.inbox.filter((m) => m.type === 'event')).toEqual([{ type: 'event', event: 'typing', from: alice.user._id, data: { roomId: 'general' } }])
      expect(c.inbox.find((m) => m.type === 'error')).toMatchObject({ code: 'forbidden' })

      // Кэрол приняла приглашение: у Боба поменялись контакты - presence перечитать
      const post = (path: string, body: unknown, t: string) =>
        fetch(`${s.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify(body) })
      expect((await post('/api/actions/acceptInvite', { inviteId: 'carol-to-general' }, carol.accessToken)).status).toBe(200)
      await waitFor(() => b.inbox.some((m) => m.type === 'reset' && m.sub === 'online'), 3000)

      // Боба выгнали: reset ленты, следующее сообщение комнаты он не получает
      expect((await post('/api/actions/kick', { roomId: 'general', userId: bob.user._id }, alice.accessToken)).status).toBe(200)
      expect((await post('/api/c/messages', { roomId: 'general', text: 'без Боба' }, alice.accessToken)).status).toBe(200)
      await waitFor(() => b.inbox.some((m) => m.type === 'reset' && m.sub === 'feed'), 3000)
      await s.realtime!.settled()
      const texts = b.inbox.filter((m) => m.type === 'changes').flatMap((m) => m.items.filter((i: any) => i.sub === 'feed').map((i: any) => i.doc?.text))
      expect(texts).not.toContain('без Боба')
      // и REST после reset - пусто
      const reread = await (await fetch(`${s.url}/api/c/messages?filter=${encodeURIComponent('{"roomId":"general"}')}&limit=5`, { headers: { Authorization: `Bearer ${bob.accessToken}` } })).json()
      expect(reread.items).toEqual([])
      for (const x of [a, b, c]) x.ws.close()
    } finally {
      await s.stop()
    }
  }, 30_000)
})

describe('realtime: гонки и отказ', () => {
  test('100. медленное правило: пересчёт по dependsOn идёт раньше следующего коммита - выгнанный ничего не получает', async () => {
    const { db, rt, alice, bob } = await setup()
    const b = await connected(rt, bob.token)
    await b.send({ type: 'sub', id: 's', collection: 'slow' })
    slowMs.value = 30
    await db.c.rooms!.update('general', { $pull: { participants: bob.id } }) // пересчёт правила - 30 мс
    await db.c.slow!.insert({ roomId: 'general', text: 'сразу после kick' }) // коммит, пока правило считается
    await rt.settled()
    slowMs.value = 0
    expect(b.of('changes')).toEqual([])
    // у Боба больше нет комнат - правило отказывает: revoked, подписка снята
    expect(b.of('revoked')).toEqual([{ type: 'revoked', sub: 's' }])
    await db.c.rooms!.update('general', { $push: { participants: bob.id } })
    await db.c.slow!.insert({ roomId: 'general', text: 'после revoked' })
    await rt.settled()
    expect(b.of('changes')).toEqual([]) // снятая подписка молчит
    await rt.stop()
    await db.close()
  })

  test('101. kick во время подписки: правило досчитывается, устаревший фильтр не остаётся', async () => {
    const { db, rt, alice, bob } = await setup()
    await db.c.rooms!.insertMany([{ _id: 'second', participants: [bob.id] }]) // чтобы правило не отказало
    const b = await connected(rt, bob.token)
    slowMs.value = 30
    const sub = b.send({ type: 'sub', id: 's', collection: 'slow' }) // правило прочитало rooms и ждёт
    await sleep(5)
    await db.c.rooms!.update('general', { $pull: { participants: bob.id } })
    await sub
    slowMs.value = 0
    await db.c.slow!.insert({ roomId: 'general', text: 'в чужой уже комнате' })
    await db.c.slow!.insert({ roomId: 'second', text: 'в своей' })
    await rt.settled()
    expect(ops(b, 's')).toEqual([['added', 'в своей']])
    await rt.stop()
    await db.close()
  })
})


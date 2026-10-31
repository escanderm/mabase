// SDK mabase/client против настоящего сервера (design.md §12): вход и
// токены, коллекции, live() с окном и loadMore, реконнект и рестарт сервера,
// reset/revoked, события, OAuth, телефон.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createClient, MabaseError, type KeyValueStorage, type MabaseClient } from '../src/client'
import { openDb, type CollectionApi } from '../src/db'
import { defineAction } from '../src/actions'
import { OAUTH_PROVIDERS } from '../src/oauth'
import { startServer, type ServerConfig } from '../src/server'
import { sleep, tmpDir, waitFor } from './helpers'

const roomIdsOf = async (db: Record<string, CollectionApi>, userId: string) =>
  (await db.rooms!.find({ participants: userId }, { fields: ['_id'] })).map((r) => r._id)

function memory(): KeyValueStorage {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

function config(dataDir: string, extra: Partial<ServerConfig> = {}): ServerConfig {
  return {
    dataDir,
    port: 0,
    hostname: '127.0.0.1',
    env: {},
    onWarning: () => {},
    db: { fsync: false },
    realtime: true,
    collections: {
      rooms: {
        indexes: ['participants'],
        fields: { readonly: ['participants'] },
        rules: { list: (u) => (u ? { participants: u.id } : false), view: (u) => (u ? { participants: u.id } : false) },
      },
      messages: {
        indexes: ['roomId'],
        rules: {
          dependsOn: ['rooms'],
          list: async (u, { db }) => (u ? { roomId: { $in: await roomIdsOf(db, u.id) } } : false),
          view: async (u, { db }) => (u ? { roomId: { $in: await roomIdsOf(db, u.id) } } : false),
          create: async (u, { doc, db }) => !!u && (await roomIdsOf(db, u.id)).includes(doc.roomId as string),
          update: (u) => !!u,
          delete: (u) => !!u,
        },
      },
      // нет ни одной комнаты - правило отказывает целиком: сервер шлёт revoked
      secrets: {
        rules: {
          dependsOn: ['rooms'],
          list: async (u, { db }) => (u && (await roomIdsOf(db, u.id)).length ? true : false),
        },
      },
    },
    actions: [
      defineAction('join', { input: z.object({ roomId: z.string() }), handler: ({ input, user, db }) => db.rooms!.update(input.roomId, { $push: { participants: user.id } }) }),
      defineAction('kick', { input: z.object({ roomId: z.string(), userId: z.string() }), handler: ({ input, db }) => db.rooms!.update(input.roomId, { $pull: { participants: input.userId } }) }),
    ],
    events: {
      typing: {
        from: 'client',
        input: z.object({ roomId: z.string() }),
        allow: async (user, data, { db }) => (await roomIdsOf(db, user.id)).includes(data.roomId),
        to: async (data, { db }) => (await db.rooms!.findOne({ _id: data.roomId }))?.participants ?? [],
      },
    },
    ...extra,
  }
}

const fast = { reconnectMs: { min: 50, max: 200 } }

async function world(extra: Partial<ServerConfig> = {}) {
  const dataDir = tmpDir('sdk')
  const s = await startServer(config(dataDir, extra))
  const mk = (storage = memory()) => createClient(s.url, { storage, sessionStorage: memory(), ...fast })
  const alice = mk()
  const bob = mk()
  await alice.auth.register({ email: 'alice@example.test', password: 'alice-pass-1' })
  await bob.auth.register({ email: 'bob@example.test', password: 'bob-pass-1' })
  await s.db.c.rooms!.insertMany([
    { _id: 'general', name: 'Общая', participants: [alice.auth.user!.id, bob.auth.user!.id] },
    { _id: 'side', name: 'Вторая', participants: [alice.auth.user!.id] },
  ])
  return { s, dataDir, mk, alice, bob }
}

const texts = (list: any[]) => list.map((m) => m.text)

describe('SDK', () => {
  test('102. вход: регистрация, restore из общего хранилища, ошибки с кодом, выход', async () => {
    const { s, mk, alice } = await world()
    expect(alice.auth.user).toMatchObject({ email: 'alice@example.test', id: expect.any(String) })
    const err = await mk().auth.login({ email: 'alice@example.test', password: 'wrong-pass' }).catch((e) => e)
    expect(err).toBeInstanceOf(MabaseError)
    expect(err).toMatchObject({ code: 'invalid_credentials', status: 401 })

    // вторая вкладка с тем же хранилищем
    const storage = memory()
    const tab1 = mk(storage)
    await tab1.auth.login({ email: 'alice@example.test', password: 'alice-pass-1' })
    const tab2 = mk(storage)
    expect(await tab2.auth.restore()).toMatchObject({ email: 'alice@example.test' })
    const changes: Array<string | null> = []
    tab1.auth.onChange((u) => changes.push(u?.email ?? null))
    await tab1.auth.logout()
    expect(changes).toEqual([null])
    expect(tab1.auth.user).toBeNull()
    expect(await mk(storage).auth.restore()).toBeNull()
    for (const c of [alice, tab1, tab2]) c.close()
    await s.stop()
  })

  test('103. токены: обновляются сами до истечения; 401 - обновить и повторить; две вкладки обновляют одновременно', async () => {
    const { s, mk } = await world({ auth: { accessTtl: '2s' } })
    const storage = memory()
    const a = createClient(s.url, { storage, sessionStorage: memory(), refreshBeforeMs: 1000, ...fast })
    await a.auth.login({ email: 'alice@example.test', password: 'alice-pass-1' })
    const first = a.auth.session!.accessToken
    await sleep(2500) // токен на 2 с давно бы истёк
    expect(a.auth.session!.accessToken).not.toBe(first)
    expect(await a.c.rooms!.count()).toBe(2)

    // сервер не принял токен (например, его подменили) - SDK обновит и повторит
    a.auth.session = { ...a.auth.session!, accessToken: 'garbage.token' }
    expect(await a.c.rooms!.count()).toBe(2)

    // две вкладки с общим хранилищем обновляются одновременно: одна получает 409 и берёт токен другой
    const b = createClient(s.url, { storage, sessionStorage: memory(), ...fast })
    await b.auth.restore()
    const r = await Promise.all([a.auth.refresh(), b.auth.refresh()])
    expect(r).toEqual([true, true])
    expect(await a.c.rooms!.count()).toBe(2)
    expect(await b.c.rooms!.count()).toBe(2)
    for (const c of [a, b]) c.close()
    await s.stop()
  }, 20_000)

  test('104. коллекции и действия: find, count, get, insert, update, remove; ошибки', async () => {
    const { s, alice, bob } = await world()
    const m = await alice.c.messages!.insert({ roomId: 'general', text: 'раз' })
    expect(await bob.c.messages!.get(m._id)).toMatchObject({ text: 'раз' })
    await bob.c.messages!.update(m._id, { $set: { text: 'два' } })
    expect(texts(await alice.c.messages!.find({ roomId: 'general' }))).toEqual(['два'])
    expect(await alice.c.messages!.count({ roomId: 'general' })).toBe(1)
    await expect(bob.c.messages!.insert({ roomId: 'side', text: 'чужая' })).rejects.toMatchObject({ code: 'forbidden', status: 403 })
    await expect(bob.c.rooms!.get('side')).rejects.toMatchObject({ code: 'not_found' })
    await expect(alice.action('join', {})).rejects.toMatchObject({ code: 'bad_request', details: [expect.objectContaining({ path: 'roomId' })] })
    await alice.c.messages!.remove(m._id)
    expect(await alice.c.messages!.count()).toBe(0)
    for (const c of [alice, bob]) c.close()
    await s.stop()
  })

  test('105. live(): начальное чтение, изменения, окно sort+limit, loadMore по курсору, close', async () => {
    const { s, alice, bob } = await world()
    for (let i = 1; i <= 7; i++) await s.db.c.messages!.insert({ _id: `m${i}`, roomId: 'general', text: `#${i}` })
    const feed = bob.live('messages', { roomId: 'general' }, { sort: { _id: -1 }, limit: 3 })
    const seen: string[][] = []
    feed.subscribe((list) => seen.push(texts(list)))
    await waitFor(() => feed.loaded, 3000)
    expect(texts(feed.items)).toEqual(['#7', '#6', '#5'])

    await s.db.c.messages!.insert({ _id: 'm8', roomId: 'general', text: '#8' }) // новее - сверху
    await s.db.c.messages!.insert({ _id: 'm0', roomId: 'general', text: '#0' }) // старее окна - не добавляется
    await alice.c.messages!.update('m6', { $set: { text: '#6!' } })
    await alice.c.messages!.remove('m5')
    await waitFor(() => texts(feed.items).join() === '#8,#7,#6!', 3000)

    expect(await feed.loadMore(3)).toBe(3)
    expect(texts(feed.items)).toEqual(['#8', '#7', '#6!', '#4', '#3', '#2'])
    expect(await feed.loadMore(3)).toBe(2) // #1 и #0
    expect(await feed.loadMore(3)).toBe(0) // больше нет
    // всё загружено - теперь и самые старые новые записи попадают в список
    await s.db.c.messages!.insert({ _id: 'm-1', roomId: 'general', text: '#-1' })
    await waitFor(() => feed.items.at(-1)?.text === '#-1', 3000)

    feed.close()
    await alice.c.messages!.insert({ roomId: 'general', text: 'после close' })
    await sleep(100)
    expect(texts(feed.items)).not.toContain('после close')
    expect(seen.length).toBeGreaterThan(3)
    for (const c of [alice, bob]) c.close()
    await s.stop()
  })

  test('106. реконнект: сервер рвёт соединения и перезапускается - SDK переподключается и перечитывает', async () => {
    const { s, dataDir, alice, bob } = await world()
    const states: string[] = []
    bob.on('connection', (st) => states.push(st))
    const feed = bob.live('messages', { roomId: 'general' })
    await waitFor(() => feed.loaded, 3000)
    await alice.c.messages!.insert({ roomId: 'general', text: 'раз' })
    await waitFor(() => feed.items.length === 1, 3000)

    // сервер закрыл все сокеты (4500); пока SDK переподключается - запись
    await s.realtime!.stop()
    await alice.c.messages!.insert({ roomId: 'general', text: 'во время разрыва' })
    await waitFor(() => texts(feed.items).includes('во время разрыва'), 5000)

    // полный рестарт сервера на том же порту; запись, пока сервер лежит
    const port = Number(new URL(s.url).port)
    await s.stop()
    const db = await openDb({ dir: `${dataDir}/db`, fsync: false })
    await db.c.messages!.insert({ roomId: 'general', text: 'пока сервер лежал' })
    await db.close()
    const s2 = await startServer(config(dataDir, { port }))
    await waitFor(() => texts(feed.items).includes('пока сервер лежал'), 10_000)
    await alice.c.messages!.insert({ roomId: 'general', text: 'после рестарта' })
    await waitFor(() => texts(feed.items).includes('после рестарта'), 5000)
    expect(texts(feed.items)).toEqual(['раз', 'во время разрыва', 'пока сервер лежал', 'после рестарта'])
    expect(states).toContain('reconnecting')
    expect(states.at(-1)).toBe('online')
    for (const c of [alice, bob]) c.close()
    await s2.stop()
  }, 30_000)

  test('107. reset и revoked: выгнали - лента пустеет, родитель не виден - revoked; вход другим пользователем', async () => {
    const { s, alice, bob } = await world()
    await alice.c.messages!.insert({ roomId: 'general', text: 'привет' })
    const feed = bob.live('messages', { roomId: 'general' }, { parent: ['rooms', 'general'] })
    const all = bob.live('messages', {})
    const events: string[] = []
    feed.on('reset', () => events.push('reset'))
    feed.on('revoked', () => events.push('revoked'))
    await waitFor(() => feed.loaded && all.loaded, 3000)
    expect(texts(feed.items)).toEqual(['привет'])

    await s.db.c.secrets!.insert({ text: 'только для участников' })
    const secrets = bob.live('secrets', {})
    let secretsRevoked = false
    secrets.on('revoked', () => (secretsRevoked = true))
    await waitFor(() => secrets.items.length === 1, 3000)
    await alice.action('kick', { roomId: 'general', userId: bob.auth.user!.id })
    await waitFor(() => events.includes('revoked') && secretsRevoked, 3000)
    expect(secrets.items).toEqual([]) // revoked от сервера - список очищен
    expect(events).toEqual(['reset', 'revoked'])
    expect(feed.items).toEqual([])
    await waitFor(() => all.items.length === 0, 3000) // без parent - просто перечитана
    await alice.c.messages!.insert({ roomId: 'general', text: 'без Боба' })
    await sleep(100)
    expect(all.items).toEqual([])

    // Боб вышел и вошёл Алисой в том же клиенте - соединение и выборки с её правами
    await bob.auth.logout()
    await bob.auth.login({ email: 'alice@example.test', password: 'alice-pass-1' })
    await waitFor(() => all.items.length === 2, 3000)
    for (const c of [alice, bob]) c.close()
    await s.stop()
  })

  test('108. события: on/emit, from от сервера, ошибки в on(error), соединение закрывается без подписчиков', async () => {
    const { s, alice, bob } = await world()
    const got: any[] = []
    const errors: MabaseError[] = []
    const off = bob.on('typing', (e) => got.push(e))
    alice.on('error', (e) => errors.push(e))
    const offA = alice.on('typing', () => {})
    await waitFor(() => bob.socket.state === 'online' && alice.socket.state === 'online', 3000)
    alice.emit('typing', { roomId: 'general' })
    alice.emit('typing', { roomId: 'side' }) // Боба там нет
    alice.emit('typing', { roomId: 1 })
    await waitFor(() => got.length === 1 && errors.length === 1, 3000)
    expect(got[0]).toMatchObject({ event: 'typing', from: alice.auth.user!.id, data: { roomId: 'general' } })
    expect(errors[0]).toMatchObject({ code: 'bad_request' })
    off()
    expect(bob.socket.state).toBe('offline') // никто не слушает - сокет закрыт
    offA()
    for (const c of [alice, bob]) c.close()
    await s.stop()
  })

  test('109. OAuth и телефон через SDK', async () => {
    const issued = new Map<string, string>()
    const serverFetch = async (url: string, init: RequestInit) => {
      if (url === OAUTH_PROVIDERS.google.tokenUrl) return Response.json({ access_token: issued.get(new URLSearchParams(String(init.body)).get('code')!) })
      if (url.endsWith('/auth')) return Response.json(JSON.parse(String(init.body)).code === '123456' ? { status: 'ok' } : { status: 'error' }, { status: 200 })
      return Response.json({ sub: 'g-1', email: 'g@example.test', email_verified: true, name: 'Гугл' })
    }
    const { s } = await world({
      auth: { providers: ['password', 'google', 'authphone'], oauth: { google: { clientId: 'c', clientSecret: 's' } }, appUrl: 'https://app.example.test', fetch: serverFetch },
    })
    const sessionStorage = memory()
    const mb = createClient(s.url, { storage: memory(), sessionStorage, ...fast })
    const url = await mb.auth.oauth('google', { returnTo: '/rooms' })
    expect(sessionStorage.getItem(`mabase:${s.url}:oauth`)).toBeString()
    const u = new URL(url)
    issued.set('c1', 'tok')
    const cb = await fetch(`${s.url}/api/auth/oauth/google/callback?code=c1&state=${u.searchParams.get('state')}`, { redirect: 'manual' })
    const loc = cb.headers.get('location')!
    expect(loc).toStartWith('https://app.example.test/rooms#mb_oauth=')
    const user = await mb.auth.completeOAuth(new URL(loc).hash)
    expect(user).toMatchObject({ email: 'g@example.test', name: 'Гугл' })
    expect(sessionStorage.getItem(`mabase:${s.url}:oauth`)).toBeNull()
    expect(await mb.auth.completeOAuth('')).toBeNull()
    await expect(mb.auth.completeOAuth('#mb_oauth_error=denied')).rejects.toMatchObject({ code: 'denied' })

    // телефон: код запрашивает браузер прямо у authphone, проверяет сервер
    const asked: string[] = []
    const phone = createClient(s.url, {
      storage: memory(),
      sessionStorage: memory(),
      authphoneUrl: 'https://authphone.example.test',
      fetch: (async (input: any, init?: RequestInit) => {
        if (String(input).startsWith('https://authphone.example.test')) {
          asked.push(`${input} ${init?.body}`)
          return Response.json({ status: 'ok' })
        }
        return fetch(input, init)
      }) as typeof fetch,
    })
    await phone.auth.phone.start('+79991234567')
    expect(asked).toEqual(['https://authphone.example.test/generate-code {"phoneNumber":"+79991234567"}'])
    await expect(phone.auth.phone.verify('+79991234567', '000000')).rejects.toMatchObject({ code: 'invalid_credentials' })
    expect(await phone.auth.phone.verify('+79991234567', '123456')).toMatchObject({ phone: '+79991234567' })
    for (const c of [mb, phone]) c.close()
    await s.stop()
  })
})

// fetch, который считает запросы и может придержать ответ.
function spyFetch() {
  const calls: Array<{ url: string; status: number }> = []
  let gate: { match: (url: string) => boolean; wait: Promise<void>; hit: () => void } | null = null
  const f = (async (input: any, init?: RequestInit) => {
    const res = await fetch(input, init)
    calls.push({ url: String(input), status: res.status })
    if (gate?.match(String(input))) {
      const g = gate
      gate = null
      g.hit()
      await g.wait // ответ уже посчитан сервером, но клиент его ещё не видит
    }
    return res
  }) as typeof fetch
  const hold = (match: (url: string) => boolean) => {
    let release!: () => void
    let hit!: () => void
    const wait = new Promise<void>((r) => (release = r))
    const reached = new Promise<void>((r) => (hit = r))
    gate = { match, wait, hit }
    return { release, reached }
  }
  return { fetch: f, calls, hold }
}

describe('SDK: гонки', () => {
  test('110. live() под нагрузкой: подключение во время записи - список = база (пять раз)', async () => {
    const { s, alice, bob, mk } = await world()
    for (let round = 0; round < 5; round++) {
      const room = `r${round}`
      await s.db.c.rooms!.insert({ _id: room, participants: [alice.auth.user!.id, bob.auth.user!.id] })
      const c = mk()
      await c.auth.login({ email: 'bob@example.test', password: 'bob-pass-1' }) // до записи: подключение должно попасть на запись
      let stop = false
      const writer = (async () => {
        let i = 0
        while (!stop && i < 400) { // меньше окна live: сравниваем всю комнату
          const id = `${room}-${i++}`
          await s.db.c.messages!.insert({ _id: id, roomId: room, text: `${id} v0` })
          if (i % 3 === 0 && s.db.peek('messages', `${room}-${i - 3}`)) await s.db.c.messages!.update(`${room}-${i - 3}`, { $set: { text: `${room}-${i - 3} v1` } })
          if (i % 4 === 0) await s.db.c.messages!.remove(`${room}-${i - 2}`).catch(() => {})
        }
      })()
      await sleep(2)
      const feed = c.live('messages', { roomId: room }, { limit: 1000 })
      await waitFor(() => feed.loaded, 5000)
      stop = true
      await writer
      await s.realtime!.settled()
      const truth = (await s.db.c.messages!.find({ roomId: room })).map((d) => `${d._id}:${d.text}`)
      await waitFor(() => feed.items.map((d) => `${d._id}:${d.text}`).join() === truth.join(), 3000).catch(() => {})
      expect(feed.items.map((d) => `${d._id}:${d.text}`)).toEqual(truth)
      c.close()
    }
    for (const c of [alice, bob]) c.close()
    await s.stop()
  }, 30_000)

  test('111. токены: одно обновление на все запросы; истёкший токен из хранилища обновляется до запроса; 401 - обновить и повторить', async () => {
    const { s } = await world()
    const spy = spyFetch()
    const storage = memory()
    const a = createClient(s.url, { storage, sessionStorage: memory(), fetch: spy.fetch, ...fast })
    await a.auth.login({ email: 'alice@example.test', password: 'alice-pass-1' })
    a.close()
    // ноутбук спал: токен в хранилище истёк, таймер не сработал
    const saved = JSON.parse(storage.getItem(`mabase:${s.url}`)!)
    storage.setItem(`mabase:${s.url}`, JSON.stringify({ ...saved, accessExpiresAt: Date.now() - 1000 }))
    const b = createClient(s.url, { storage, sessionStorage: memory(), fetch: spy.fetch, ...fast })
    spy.calls.length = 0
    await Promise.all(Array.from({ length: 5 }, () => b.c.rooms!.count()))
    expect(spy.calls.filter((c) => c.url.endsWith('/api/auth/refresh'))).toHaveLength(1) // одно на всех
    expect(spy.calls.filter((c) => c.status === 401)).toEqual([]) // обновлён до запроса, а не после отказа

    // сервер не принял токен - обновить и повторить
    b.auth.session = { ...b.auth.session!, accessToken: 'garbage.token' }
    spy.calls.length = 0
    expect(await b.c.rooms!.count()).toBe(2)
    expect(spy.calls.map((c) => c.status)).toEqual([401, 200, 200])
    b.close()
    await s.stop()
  })

  test('112. loadMore: правка записи страницы, пока страница едет к клиенту, не теряется', async () => {
    const { s, alice } = await world()
    for (let i = 1; i <= 6; i++) await s.db.c.messages!.insert({ _id: `m${i}`, roomId: 'general', text: `#${i}` })
    const spy = spyFetch()
    const c = createClient(s.url, { storage: memory(), sessionStorage: memory(), fetch: spy.fetch, ...fast })
    await c.auth.login({ email: 'bob@example.test', password: 'bob-pass-1' })
    const feed = c.live('messages', { roomId: 'general' }, { limit: 3 })
    await waitFor(() => feed.loaded, 3000)
    expect(texts(feed.items)).toEqual(['#1', '#2', '#3'])
    const gate = spy.hold((url) => url.includes('/api/c/messages') && url.includes('%24gt'))
    const more = feed.loadMore(3)
    await gate.reached // страница прочитана сервером
    await alice.c.messages!.update('m5', { $set: { text: '#5 правка' } })
    await waitFor(() => c.socket.state === 'online', 1000)
    await s.realtime!.settled()
    await sleep(50) // изменение дошло до клиента раньше страницы
    gate.release()
    await more
    expect(texts(feed.items)).toEqual(['#1', '#2', '#3', '#4', '#5 правка', '#6'])
    for (const x of [c, alice]) x.close()
    await s.stop()
  })

  test('159. выход очищает живые выборки: данные прошлого пользователя не остаются на экране', async () => {
    const { s, mk, alice } = await world()
    await s.db.c.messages!.insertMany([{ roomId: 'general', text: '#1' }, { roomId: 'general', text: '#2' }])
    const feed = alice.live('messages', { roomId: 'general' }, { sort: { _id: 1 }, limit: 10 })
    const seen: number[] = []
    feed.subscribe((items) => seen.push(items.length))
    await waitFor(() => feed.items.length === 2, 2000)

    await alice.auth.logout()
    // Окно чистится сразу, не дожидаясь ответа сокета: иначе на общем
    // компьютере следующий человек увидит чужие сообщения.
    expect(feed.items).toEqual([])
    expect(seen.at(-1)).toBe(0)
    alice.close()
    await s.stop()
  })
})

void createHash


// Пользователи и вход (design.md §11): пароль, токены, authphone.su.
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { Access } from '../src/access'
import { Auth, normalizePhone, type AuthOptions } from '../src/auth'
import { openDb } from '../src/db'
import { DefinitionError } from '../src/errors'
import { sleep, tmpDir } from './helpers'

const SECRET = 'test-secret-'.padEnd(48, 'x')

async function setup(opts: Partial<AuthOptions> = {}, dir = tmpDir('auth')) {
  const db = await openDb({ dir, fsync: false, compactMinBytes: 0 })
  const access = new Access(db, {})
  const auth = new Auth(access, { secret: SECRET, providers: ['password', 'authphone'], ...opts })
  return { db, access, auth, dir }
}

// Подделка authphone.su: /auth отвечает ok, если код совпал.
function fakeAuthphone(codes: Record<string, string>) {
  const calls: Array<{ url: string; body: any }> = []
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    calls.push({ url, body })
    if (codes[body.phoneNumber] === body.code) return Response.json({ status: 'ok', message: 'success' })
    return Response.json({ status: 'error', message: 'invalid code' }, { status: 400 })
  }
  return { fetch, calls }
}

const alice = { email: 'alice@example.test', password: 'alice-pass-1' }

describe('пароль', () => {
  test('55. регистрация и вход: пароль хранится как argon2id, наружу хэш не уходит', async () => {
    const { db, auth } = await setup()
    const s = await auth.register({ ...alice, data: { name: 'Алиса' } })
    expect(s.user).toMatchObject({ email: alice.email, name: 'Алиса', verified: false, roles: [] })
    expect(s.user.passwordHash).toBeUndefined()
    expect(db.peek('users', s.user._id)!.passwordHash).toStartWith('$argon2id$')

    const l = await auth.login(alice)
    expect(l.user._id).toBe(s.user._id)
    expect(await auth.verify(l.accessToken)).toEqual({ id: s.user._id, roles: [] })

    // неверный пароль и неизвестный email - одна и та же ошибка
    const wrong = await auth.login({ ...alice, password: 'nope-nope' }).catch((e) => e)
    const unknown = await auth.login({ email: 'ghost@example.test', password: 'nope-nope' }).catch((e) => e)
    expect(wrong).toMatchObject({ code: 'invalid_credentials', status: 401 })
    expect(unknown).toMatchObject({ code: wrong.code, message: wrong.message })

    await expect(auth.register({ email: 'b@example.test', password: 'short' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(auth.register({ email: 'not-an-email', password: 'long-enough' })).rejects.toMatchObject({ code: 'bad_request' })
    await db.close()
  })

  test('56. email и телефон приводятся к одному виду и уникальны - кто бы ни писал', async () => {
    const { db, auth } = await setup()
    const s = await auth.register({ email: '  Alice@Example.TEST ', password: alice.password })
    expect(s.user.email).toBe('alice@example.test')
    await expect(auth.register(alice)).rejects.toMatchObject({ code: 'conflict', message: 'Этот email уже занят' })

    // серверный код идёт мимо правил, но не мимо уникальности
    await expect(db.c.users!.insert({ email: 'ALICE@example.test' })).rejects.toMatchObject({ code: 'conflict' })
    const bob = await db.c.users!.insert({ email: 'bob@example.test', phone: '8 (999) 123-45-67' })
    expect(bob.phone).toBe('+79991234567')
    await expect(db.c.users!.update(bob._id, { $set: { email: 'alice@example.test' } })).rejects.toMatchObject({ code: 'conflict' })
    await expect(db.c.users!.insert({ phone: '+79991234567' })).rejects.toMatchObject({ code: 'conflict' })
    // в одной транзакции - тоже: вторая запись видит первую
    await expect(
      db.transaction(async (tx) => {
        await tx.c.users!.insert({ email: 'carol@example.test' })
        await tx.c.users!.insert({ email: 'Carol@example.test' })
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await db.c.users!.count({ email: 'carol@example.test' })).toBe(0)
    // своё значение - не конфликт
    await db.c.users!.update(bob._id, { $set: { email: 'BOB@example.test', name: 'Боб' } })

    expect(normalizePhone('89991234567')).toBe('+79991234567')
    expect(normalizePhone('79991234567')).toBe('+79991234567')
    expect(normalizePhone('9991234567')).toBe('+79991234567')
    expect(normalizePhone('+1 202 555 0123')).toBe('+12025550123')
    for (const bad of ['12345', '+0123456789', 'abc', '+7999123456789012']) expect(() => normalizePhone(bad)).toThrow()
    await db.close()
  })

  test('57. регистрация не задаёт служебные поля; схема users расширяется, а не заменяется', async () => {
    const users = { schema: z.object({ name: z.string().min(1) }), indexes: ['name'] }
    const { db, auth } = await setup({ users })
    for (const data of [{ name: 'A', roles: ['admin'] }, { name: 'A', verified: true }, { name: 'A', passwordHash: 'x' }, { name: 'A', _id: 'me' }]) {
      await expect(auth.register({ ...alice, data })).rejects.toMatchObject({ code: 'forbidden' })
    }
    // своя схема проверяется: нет name - 400 с подробностями
    await expect(auth.register(alice)).rejects.toMatchObject({ code: 'bad_request', details: [{ path: 'name' }] })
    const s = await auth.register({ ...alice, data: { name: 'Алиса', junk: 1 } })
    expect(s.user).toMatchObject({ name: 'Алиса', email: alice.email, roles: [] })
    expect(s.user.junk).toBeUndefined()
    await db.close()

    const db2 = await openDb({ dir: tmpDir('auth'), fsync: false })
    const bad = { schema: z.object({ email: z.string() }) }
    expect(() => new Auth(new Access(db2, {}), { secret: SECRET, users: bad })).toThrow(DefinitionError)
    expect(() => new Auth(new Access(db2, {}), { secret: 'short' })).toThrow(/32/)
    await db2.close()
  })

  test('58. access-токен: подпись, срок, закрытая сессия, удалённый пользователь, рестарт', async () => {
    let now = Date.now()
    const { db, auth, dir } = await setup({ now: () => now })
    const s = await auth.register(alice)
    const [h, p, sig] = s.accessToken.split('.') as [string, string, string]
    expect(await auth.verify(s.accessToken)).toMatchObject({ id: s.user._id })

    const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
    const forged = Buffer.from(JSON.stringify({ ...payload, sub: 'someone' })).toString('base64url')
    expect(await auth.verify(`${h}.${forged}.${sig}`)).toBeNull()
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    expect(await auth.verify(`${none}.${p}.`)).toBeNull()
    expect(await auth.verify(`${h}.${p}.${sig.slice(0, -2)}xx`)).toBeNull()
    expect(await auth.verify('мусор')).toBeNull()
    // даже с верной подписью (секрет утёк в тест): чужой заголовок и чужой sid не проходят
    const sign = (header: object, body: object) => {
      const hb = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(body)).toString('base64url')}`
      return `${hb}.${createHmac('sha256', SECRET).update(hb).digest('base64url')}`
    }
    expect(await auth.verify(sign({ alg: 'HS256', typ: 'JWT' }, payload))).toMatchObject({ id: s.user._id }) // контроль
    expect(await auth.verify(sign({ alg: 'HS512', typ: 'JWT' }, payload))).toBeNull()
    const bob = await auth.register({ email: 'bob@example.test', password: 'bob-pass-1' })
    expect(await auth.verify(sign({ alg: 'HS256', typ: 'JWT' }, { ...payload, sub: bob.user._id }))).toBeNull()

    // рестарт: тот же секрет - токен работает, сессия сохранена в базе
    await db.close()
    const r = await setup({ now: () => now }, dir)
    expect(await r.auth.verify(s.accessToken)).toMatchObject({ id: s.user._id })

    now += 15 * 60_000 + 1000
    expect(await r.auth.verify(s.accessToken)).toBeNull() // истёк
    const s2 = await r.auth.refresh(s.refreshToken)
    expect(await r.auth.verify(s2.accessToken)).toMatchObject({ id: s.user._id })

    // выход действует сразу, а не через 15 минут
    await r.auth.logout(s2.refreshToken)
    expect(await r.auth.verify(s2.accessToken)).toBeNull()
    await expect(r.auth.refresh(s2.refreshToken)).rejects.toMatchObject({ code: 'unauthorized' })

    // удалили пользователя - его сессии удалились в той же транзакции
    const s3 = await r.auth.login(alice)
    await r.db.c.users!.remove(s3.user._id)
    expect(await r.auth.verify(s3.accessToken)).toBeNull()
    expect(await r.db.c._authTokens!.count({ userId: s3.user._id })).toBe(0)
    await r.db.close()
  })

  test('59. refresh: новый токен на каждое обновление; старый после обновления закрывает сессию', async () => {
    let now = Date.now()
    const { db, auth } = await setup({ now: () => now })
    const s = await auth.register(alice)
    const s2 = await auth.refresh(s.refreshToken)
    expect(s2.refreshToken).not.toBe(s.refreshToken)
    expect(s2.refreshToken.split('.')[0]).toBe(s.refreshToken.split('.')[0]) // та же сессия

    // другая вкладка пришла со старым токеном сразу после обновления - 409, сессия жива
    await expect(auth.refresh(s.refreshToken)).rejects.toMatchObject({ code: 'conflict' })
    expect(await auth.verify(s2.accessToken)).not.toBeNull()

    // старый токен через минуту - его украли: сессия закрыта, новый токен тоже не работает
    now += 60_000
    await expect(auth.refresh(s.refreshToken)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(await auth.verify(s2.accessToken)).toBeNull()
    await expect(auth.refresh(s2.refreshToken)).rejects.toMatchObject({ code: 'unauthorized' })

    // чужой секрет при верном id сессии, мусор, истёкшая сессия
    const s3 = await auth.login(alice)
    const sid = s3.refreshToken.split('.')[0]
    await expect(auth.refresh(`${sid}.AAAA`)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(auth.refresh('мусор')).rejects.toMatchObject({ code: 'unauthorized' })
    now += 31 * 86_400_000
    await expect(auth.refresh(s3.refreshToken)).rejects.toMatchObject({ code: 'unauthorized' })
    // при следующем входе истёкшие сессии пользователя удаляются
    await auth.login(alice)
    expect(await db.c._authTokens!.count({ userId: s.user._id })).toBe(1)
    await db.close()
  })

  test('60. два обновления одним токеном одновременно: одно проходит, второе - 409', async () => {
    const { db, auth } = await setup()
    const s = await auth.register(alice)
    const r = await Promise.allSettled([auth.refresh(s.refreshToken), auth.refresh(s.refreshToken)])
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' })
    await db.close()
  })

  test('61. смена пароля закрывает все сессии, кроме новой', async () => {
    const { db, auth } = await setup()
    const s = await auth.register(alice)
    const other = await auth.login(alice) // второе устройство
    const user = (await auth.verify(s.accessToken))!
    await expect(auth.changePassword(user, { oldPassword: 'wrong-pass', newPassword: 'alice-pass-2' })).rejects.toMatchObject({
      code: 'invalid_credentials',
    })
    await expect(auth.changePassword(null, { oldPassword: alice.password, newPassword: 'alice-pass-2' })).rejects.toMatchObject({
      code: 'unauthorized',
    })
    const n = await auth.changePassword(user, { oldPassword: alice.password, newPassword: 'alice-pass-2' })
    expect(await auth.verify(n.accessToken)).not.toBeNull()
    expect(await auth.verify(s.accessToken)).toBeNull()
    expect(await auth.verify(other.accessToken)).toBeNull()
    await expect(auth.refresh(other.refreshToken)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(auth.login(alice)).rejects.toMatchObject({ code: 'invalid_credentials' })
    await auth.login({ ...alice, password: 'alice-pass-2' })
    await db.close()
  })

  test('62. лимит попыток: 10 неудач на email и IP - 429, даже с верным паролем', async () => {
    let now = Date.now()
    const { db, auth } = await setup({ now: () => now, loginLimit: { attempts: 3, windowMs: 60_000 } })
    await auth.register(alice)
    const ip = { ip: '1.2.3.4' }
    // параллельные попытки тоже считаются: попытка учитывается до проверки пароля
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => auth.login({ ...alice, password: 'wrong-pass' }, ip)))
    expect(r.map((x) => (x as PromiseRejectedResult).reason.code).sort()).toEqual([
      'invalid_credentials',
      'invalid_credentials',
      'invalid_credentials',
      'too_many_requests',
      'too_many_requests',
    ])
    await expect(auth.login(alice, ip)).rejects.toMatchObject({ code: 'too_many_requests', status: 429 })
    await auth.login(alice, { ip: '5.6.7.8' }) // с другого IP - можно
    // удачный вход сбрасывает счёт: две неудачи, вход, ещё две - не 429
    const ip2 = { ip: '9.9.9.9' }
    for (let i = 0; i < 2; i++) await expect(auth.login({ ...alice, password: 'wrong-pass' }, ip2)).rejects.toMatchObject({ code: 'invalid_credentials' })
    await auth.login(alice, ip2)
    for (let i = 0; i < 2; i++) await expect(auth.login({ ...alice, password: 'wrong-pass' }, ip2)).rejects.toMatchObject({ code: 'invalid_credentials' })
    now += 60_001
    await auth.login(alice, ip) // окно прошло
    await db.close()
  })

  test('63. хэши argon2id: не больше hashConcurrency сразу; неизвестный email тоже считает хэш', async () => {
    const real = Bun.password.hash
    const realVerify = Bun.password.verify
    const fixed = await real('fixed-pass', { algorithm: 'argon2id' })
    let active = 0
    let max = 0
    ;(Bun.password as any).hash = async () => {
      max = Math.max(max, ++active)
      await sleep(10)
      active--
      return fixed
    }
    try {
      const { db, auth } = await setup({ hashConcurrency: 2 })
      await Promise.all(Array.from({ length: 6 }, (_, i) => auth.register({ email: `u${i}@example.test`, password: 'long-enough' })))
      expect(max).toBe(2)
      // неизвестный email: хэш всё равно проверяется - время ответа не выдаёт, есть ли пользователь
      const verified: string[] = []
      ;(Bun.password as any).verify = async (_: string, hash: string) => (verified.push(hash), false)
      await expect(auth.login({ email: 'ghost@example.test', password: 'whatever-1' })).rejects.toMatchObject({ code: 'invalid_credentials' })
      expect(verified).toHaveLength(1)
      expect(verified[0]).toStartWith('$argon2id$') // настоящий хэш той же цены, а не пустая строка
      await db.close()
    } finally {
      ;(Bun.password as any).hash = real
      ;(Bun.password as any).verify = realVerify
    }
  })

  test('64. upsertUser для сида: тот же пароль - хэш и сессии не меняются', async () => {
    const { db, auth } = await setup()
    const u = await auth.upsertUser({ ...alice, name: 'Алиса' })
    expect(u).toMatchObject({ email: alice.email, name: 'Алиса', roles: [] })
    expect(u.passwordHash).toBeUndefined()
    const hash = db.peek('users', u._id)!.passwordHash
    const s = await auth.login(alice)

    const again = await auth.upsertUser({ ...alice, name: 'Алиса Л.' })
    expect(again._id).toBe(u._id)
    expect(db.peek('users', u._id)).toMatchObject({ passwordHash: hash, name: 'Алиса Л.' })
    expect(await auth.verify(s.accessToken)).not.toBeNull()

    await auth.upsertUser({ ...alice, password: 'alice-pass-2' })
    expect(await auth.verify(s.accessToken)).toBeNull() // новый пароль закрыл сессии
    await auth.login({ ...alice, password: 'alice-pass-2' })
    await expect(auth.upsertUser({ ...alice, passwordHash: 'x' } as any)).rejects.toThrow(/password/)
    await db.close()
  })
})

describe('authphone.su', () => {
  test('65. вход по коду: код проверяет сервер, пользователь создаётся по номеру', async () => {
    const ap = fakeAuthphone({ '+79991234567': '123456' })
    const { db, auth } = await setup({ fetch: ap.fetch })
    const s = await auth.loginWithPhone({ phone: '8 999 123-45-67', code: '123456' })
    expect(s.user).toMatchObject({ phone: '+79991234567', roles: [] })
    expect(ap.calls).toEqual([{ url: 'https://authphone.su/auth', body: { phoneNumber: '+79991234567', code: '123456' } }])

    const again = await auth.loginWithPhone({ phone: '+79991234567', code: '123456' })
    expect(again.user._id).toBe(s.user._id)
    expect(await db.c.users!.count({})).toBe(1)

    await expect(auth.loginWithPhone({ phone: '+79991234567', code: '000000' })).rejects.toMatchObject({ code: 'invalid_credentials' })
    // неверный формат кода - до authphone не доходит
    const before = ap.calls.length
    await expect(auth.loginWithPhone({ phone: '+79991234567', code: '12ab' })).rejects.toMatchObject({ code: 'bad_request' })
    expect(ap.calls.length).toBe(before)
    // по паролю такой пользователь не входит: пароля нет
    await db.close()
  })

  test('66. authphone недоступен - 503, а не "неверный код"; регистрация и способ входа выключаются', async () => {
    for (const fetch of [
      async () => {
        throw new TypeError('ECONNREFUSED')
      },
      async () => new Response('oops', { status: 502 }),
      async () => new Response('<html>', { status: 200 }),
    ]) {
      const { db, auth } = await setup({ fetch })
      await expect(auth.loginWithPhone({ phone: '+79991234567', code: '123456' })).rejects.toMatchObject({ code: 'unavailable', status: 503 })
      await db.close()
    }
    const ap = fakeAuthphone({ '+79991234567': '123456' })
    const closed = await setup({ fetch: ap.fetch, signup: false })
    await expect(closed.auth.loginWithPhone({ phone: '+79991234567', code: '123456' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(closed.auth.register(alice)).rejects.toMatchObject({ code: 'forbidden' })
    await closed.auth.upsertUser({ phone: '+79991234567' }) // сервер создать может
    await closed.auth.loginWithPhone({ phone: '+79991234567', code: '123456' })
    await closed.db.close()

    const pwOnly = await setup({ fetch: ap.fetch, providers: ['password'] })
    await expect(pwOnly.auth.loginWithPhone({ phone: '+79991234567', code: '123456' })).rejects.toMatchObject({ code: 'forbidden' })
    await pwOnly.db.close()
  })
})

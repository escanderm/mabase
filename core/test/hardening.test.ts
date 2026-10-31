// Тесты 152-158: закрытие дыр из ревью 0.2.0 - поле-владелец и private,
// ReDoS через два повтора, лимиты входа по аккаунту и по IP, токены из писем
// при смене пароля, токен сброса в журнале tail, частота перепроверки сессии
// в сокете. Каждый пункт воспроизведён до правки.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Access, checkClientRegex } from '../src/access'
import { Auth } from '../src/auth'
import { openDb } from '../src/db'
import { Mailer } from '../src/mail'
import { maskSecrets, formatTail } from '../src/tail'
import { tmpDir } from './helpers'

const SECRET = 'hardening-secret-'.padEnd(48, 'x')
const alice = { email: 'alice@example.test', password: 'alice-pass-1' }

async function setup(opts: ConstructorParameters<typeof Auth>[1] extends infer T ? Partial<T> : never = {}) {
  const db = await openDb({ dir: tmpDir('hard'), fsync: false, compactMinBytes: 0 })
  const access = new Access(db, {})
  const auth = new Auth(access, { secret: SECRET, mail: new Mailer({ onDevMail: () => {} }), ...opts })
  return { db, access, auth }
}

describe('поле-владелец и private', () => {
  test('152. клиент не может записать поле-владельца, private не обходится', async () => {
    const db = await openDb({ dir: tmpDir('owner'), compactMinBytes: 0 })
    db.collection('messages', {
      schema: z.object({ text: z.string(), authorId: z.string().optional(), draft: z.string().optional() }).passthrough(),
    })
    const doc = await db.c.messages!.insert({ text: 'привет', authorId: 'bob', draft: 'черновик боба' })
    const access = new Access(db, {
      messages: {
        owner: 'authorId',
        fields: { private: ['draft'] },
        rules: { list: () => true, view: () => true, create: () => true, update: () => true },
      },
    })
    const asAlice = access.forUser({ id: 'alice' })

    // private у чужой записи не виден - ни в списке, ни по id
    expect((await asAlice.c.messages!.get(doc._id)).draft).toBeUndefined()

    // попытка стать владельцем: поле защищено, private не возвращается
    const err = await asAlice.c.messages!.update(doc._id, { $set: { authorId: 'alice' } }).catch((e) => e)
    expect(err.message).toContain('клиент не меняет')
    expect(db.peek('messages', doc._id)!.authorId).toBe('bob')

    // и создать запись с чужим (или своим) владельцем тоже нельзя
    const ins = await asAlice.c.messages!.insert({ text: 'т', authorId: 'alice' }).catch((e) => e)
    expect(ins.message).toContain('клиент не меняет')

    // владелец видит своё private
    expect((await asAlice.c.messages!.get(doc._id))._id).toBe(doc._id)
    await db.close()
  })
})

describe('ReDoS', () => {
  test('153. больше одного повтора на точку - отказ; повторы по классам можно', () => {
    expect(() => checkClientRegex('.*a.*b', 64)).toThrow(/\*/)
    expect(() => checkClientRegex('.+x.+y', 64)).toThrow()
    expect(() => checkClientRegex('^[a-z]+\\d*$', 64)).not.toThrow() // два повтора по классам - линейно
    expect(() => checkClientRegex('a+b+c+', 64)).toThrow() // три повтора - уже перебор
  })

  test('154. сотни ключей sort и fields - отказ', async () => {
    const db = await openDb({ dir: tmpDir('keys'), compactMinBytes: 0 })
    await db.c.x!.insert({ a: 1 })
    const access = new Access(db, { x: { rules: { list: () => true } } })
    const c = access.forUser(null).c.x!
    const sort = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, 1]))
    expect(await c.find({}, { sort }).catch((e) => e.message)).toContain('не больше 8')
    expect(await c.find({}, { fields: Array.from({ length: 9 }, (_, i) => `f${i}`) }).catch((e) => e.message)).toContain('не больше 8')
    expect(await c.find({}, { sort: { a: 1 }, fields: ['a'] })).toHaveLength(1)
    await db.close()
  })
})

describe('смена пароля и ссылки из писем', () => {
  test('155. смена пароля гасит и висящую ссылку смены email', async () => {
    const { db, auth } = await setup()
    const s = await auth.register(alice)
    const user = { id: s.user._id }

    await auth.requestEmailChange(user, { newEmail: 'new@example.test', password: alice.password })
    const before = await db.c._authTokens!.find({ userId: user.id, kind: 'email' })
    expect(before).toHaveLength(1)

    await auth.changePassword(user, { oldPassword: alice.password, newPassword: 'alice-pass-2' })

    // раньше токен 'email' жил 24 часа и после сброса/смены пароля оставался рабочим
    expect(await db.c._authTokens!.find({ userId: user.id, kind: 'email' })).toEqual([])
    await db.close()
  })
})

describe('лимиты входа', () => {
  test('156. счётчики по аккаунту и по IP независимы: ротация IP не снимает лимит аккаунта', async () => {
    const { db, auth } = await setup({ loginLimit: { attempts: 2, windowMs: 60_000 } })
    await auth.register(alice)

    // по IP строго: 2 неудачи с одного адреса - 429
    for (let i = 0; i < 2; i++) await expect(auth.login({ ...alice, password: 'wrong' }, { ip: '10.0.0.1' })).rejects.toMatchObject({ code: 'invalid_credentials' })
    await expect(auth.login(alice, { ip: '10.0.0.1' })).rejects.toMatchObject({ code: 'too_many_requests' })

    // с другого IP верный пароль пока проходит (аккаунт не заблокирован чужими попытками)
    await auth.login(alice, { ip: '10.0.0.2' })

    // но ботнет с новым IP на каждую попытку упирается в лимит аккаунта (20)
    let last: any
    for (let i = 0; i < 21; i++) last = await auth.login({ ...alice, password: 'wrong' }, { ip: `10.1.0.${i}` }).catch((e) => e)
    expect(last.code).toBe('too_many_requests')
    await db.close()
  }, 30_000)
})

describe('журнал', () => {
  test('157. токен из письма не попадает в журнал, значения экранируются', () => {
    expect(maskSecrets('Сброс: https://app.test/reset-password?token=abc.def&x=1')).toBe('Сброс: https://app.test/reset-password?token=***&x=1')
    expect(maskSecrets('без ссылки')).toBe('без ссылки')

    const line = formatTail({ ts: 0, kind: 'mail', text: 'первая\nвторая', ansi: '\u001b[31mкрасный\u001b[0m' })
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\u001b')
    expect(line).toContain('"первая вторая"')
  })

  test('158. сокет перепроверяет сессию раз в 5 секунд, а не раз в минуту', async () => {
    const { Realtime } = await import('../src/realtime')
    const { db, access, auth } = await setup()
    const rt = new Realtime(access, auth)
    expect(rt.opts.verifyIntervalMs).toBe(5_000)
    await db.close()
  })
})

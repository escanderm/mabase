// Почта (design.md §11): отправка, подтверждение email, сброс пароля, смена email.
import { describe, expect, test } from 'bun:test'
import { Access } from '../src/access'
import { Auth, type AuthOptions } from '../src/auth'
import { openDb } from '../src/db'
import { Mailer, type MailMessage } from '../src/mail'
import { fakeSmtp, mailBody, tmpDir, waitFor } from './helpers'

const SECRET = 'test-secret-'.padEnd(48, 'x')
const alice = { email: 'alice@example.test', password: 'alice-pass-1' }

// Письма собираются в inbox; ссылка - первая строка с token=.
async function setup(opts: Partial<AuthOptions> = {}) {
  const inbox: MailMessage[] = []
  const db = await openDb({ dir: tmpDir('mail'), fsync: false, compactMinBytes: 0 })
  const auth = new Auth(new Access(db, {}), {
    secret: SECRET,
    mail: new Mailer({ appName: 'Чат', onDevMail: (m) => inbox.push(m) }),
    ...opts,
  })
  const tokenOf = (m: MailMessage | undefined) => decodeURIComponent(/token=([^\s]+)/.exec(m!.text)![1]!)
  return { db, auth, inbox, tokenOf }
}

describe('отправка', () => {
  test('67. режим разработки, своя отправка, SMTP через nodemailer; адрес и тема без переводов строк', async () => {
    const dev: MailMessage[] = []
    const m = new Mailer({ onDevMail: (x) => dev.push(x) })
    expect(m.mode).toBe('dev')
    await m.send({ to: 'a@example.test', subject: 'тема', text: 'текст' })
    expect(dev).toHaveLength(1)

    const sent: any[] = []
    const custom = new Mailer({ from: 'Чат <no-reply@chat.example.test>', send: async (x) => void sent.push(x) })
    await custom.send({ to: 'a@example.test', subject: 'две\r\nBcc: evil@example.test', text: 'т' })
    expect(sent[0]).toMatchObject({ from: 'Чат <no-reply@chat.example.test>', subject: 'две Bcc: evil@example.test' })
    for (const to of ['a@example.test\r\nBcc: evil@example.test', 'a@example.test, evil@example.test', 'нет-собаки']) {
      await expect(custom.send({ to, subject: 's', text: 't' })).rejects.toThrow(TypeError)
    }

    const smtp = fakeSmtp()
    try {
      const real = new Mailer({ from: 'Чат <no-reply@chat.example.test>', smtp: { host: '127.0.0.1', port: smtp.port }, timeoutMs: 2000 })
      await real.send({ to: 'bob@example.test', subject: 'Привет, Боб', text: 'Ссылка: https://chat.example.test/reset-password?token=abc.def' })
      expect(smtp.mails).toHaveLength(1)
      expect(smtp.mails[0]).toMatchObject({ from: 'no-reply@chat.example.test', to: ['bob@example.test'] })
      expect(mailBody(smtp.mails[0]!.raw)).toContain('https://chat.example.test/reset-password?token=abc.def')
      expect(smtp.mails[0]!.raw).toMatch(/^Subject: =\?UTF-8\?/m) // кириллица в теме закодирована

      smtp.state.reject = true
      await expect(real.send({ to: 'bob@example.test', subject: 's', text: 't' })).rejects.toThrow()
    } finally {
      smtp.stop()
    }

    expect(() => new Mailer({ smtp: { host: 'h' }, send: async () => {} })).toThrow(TypeError)
    const db = await openDb({ dir: tmpDir('mail'), fsync: false })
    // настоящая почта без appUrl - ошибка при старте: ссылки в письмах никуда бы не вели
    expect(() => new Auth(new Access(db, {}), { secret: SECRET, mail: custom })).toThrow(/appUrl/)
    await db.close()
  })

  test('68. письмо уходит после коммита, вне транзакции; не ушло - 503, токен удалён, можно сразу ещё раз', async () => {
    let fail = true
    let hold: Promise<void> | null = null
    const seen: Array<{ inTx: boolean; tokenSaved: boolean }> = []
    let db!: Awaited<ReturnType<typeof openDb>>
    const mail = new Mailer({
      send: async (m) => {
        const id = decodeURIComponent(/token=([^\s]+)/.exec(m.text)![1]!).split('.')[0]!
        seen.push({ inTx: db._currentTx() !== null, tokenSaved: db.peek('_authTokens', id) !== null })
        if (hold) await hold
        if (fail) throw new Error('SMTP недоступен')
      },
    })
    const errors: string[] = []
    const s = await setup({ mail, appUrl: 'https://chat.example.test', onError: (_, where) => errors.push(where) })
    db = s.db
    const r = await s.auth.register(alice)
    const user = (await s.auth.verify(r.accessToken))!
    await expect(s.auth.requestVerification(user)).rejects.toMatchObject({ code: 'unavailable', status: 503 })
    expect(seen).toEqual([{ inTx: false, tokenSaved: true }])
    expect(await db.c._authTokens!.count({ kind: 'verify' })).toBe(0)
    expect(errors).toEqual(['письмо verify'])
    fail = false
    await s.auth.requestVerification(user) // не 429: неудачное письмо не считается
    expect(await db.c._authTokens!.count({ kind: 'verify' })).toBe(1)

    // сброс пароля: ошибка отправки в фоне - в onError, клиенту всё равно ok
    fail = true
    await s.auth.requestPasswordReset({ email: alice.email })
    await s.auth.settled()
    expect(errors).toEqual(['письмо verify', 'requestPasswordReset'])
    expect(await db.c._authTokens!.count({ kind: 'reset' })).toBe(0)

    // ответ на сброс не ждёт письма: по времени не понять, есть ли такой email
    fail = false
    let release!: () => void
    hold = new Promise((r) => (release = r))
    const sent = seen.length
    let answered = false
    const req = s.auth.requestPasswordReset({ email: alice.email }).then(() => (answered = true))
    await waitFor(() => seen.length === sent + 1) // письмо отправляется и висит
    expect(answered).toBe(true) // а клиент уже получил ответ
    release()
    await req
    await s.auth.settled()
    // неизвестный email - не ошибка и в журнале
    await s.auth.requestPasswordReset({ email: 'ghost@example.test' })
    await s.auth.settled()
    expect(errors).toHaveLength(2)
    await db.close()
  })
})

describe('письма со ссылкой', () => {
  test('69. подтверждение email: ссылка одноразовая, не чаще раза в минуту, новая отменяет старую', async () => {
    let now = Date.now()
    const { db, auth, inbox, tokenOf } = await setup({ now: () => now })
    const r = await auth.register(alice)
    const user = (await auth.verify(r.accessToken))!
    await expect(auth.requestVerification(null)).rejects.toMatchObject({ code: 'unauthorized' })
    await auth.requestVerification(user)
    expect(inbox[0]).toMatchObject({ to: alice.email, subject: 'Подтвердите email - Чат' })
    expect(inbox[0]!.text).toContain('/verify-email?token=') // режим разработки без appUrl - путь
    await expect(auth.requestVerification(user)).rejects.toMatchObject({ code: 'too_many_requests' })

    now += 61_000
    await auth.requestVerification(user)
    await expect(auth.confirmVerification(tokenOf(inbox[0]))).rejects.toMatchObject({ code: 'bad_request' }) // старая отменена
    expect(db.peek('_authTokens', tokenOf(inbox[0]).split('.')[0]!)).toBeNull()
    // чужой секрет при верном id - нет
    await expect(auth.confirmVerification(tokenOf(inbox[1]).split('.')[0] + '.AAAA')).rejects.toMatchObject({ code: 'bad_request' })
    await auth.confirmVerification(tokenOf(inbox[1]))
    expect(db.peek('users', r.user._id)!.verified).toBe(true)
    await expect(auth.confirmVerification(tokenOf(inbox[1]))).rejects.toMatchObject({ code: 'bad_request' }) // одноразовая
    await expect(auth.requestVerification(user)).rejects.toMatchObject({ code: 'bad_request' }) // уже подтверждён

    // ссылка подтверждения не годится для сброса пароля
    const r2 = await auth.register({ email: 'bob@example.test', password: 'bob-pass-1' })
    await auth.requestVerification((await auth.verify(r2.accessToken))!)
    await expect(auth.confirmPasswordReset({ token: tokenOf(inbox[2]), password: 'hacked-pass' })).rejects.toMatchObject({ code: 'bad_request' })
    now += 24 * 3_600_000 + 1
    await expect(auth.confirmVerification(tokenOf(inbox[2]))).rejects.toMatchObject({ code: 'bad_request' }) // истекла
    await db.close()
  })

  test('70. сброс пароля: ответ один для любого email; новый пароль закрывает сессии; ссылка на 1 час', async () => {
    let now = Date.now()
    const { db, auth, inbox, tokenOf } = await setup({ now: () => now, appUrl: 'https://chat.example.test/' })
    const r = await auth.register(alice)

    expect(await auth.requestPasswordReset({ email: 'ghost@example.test' })).toBeUndefined()
    expect(await auth.requestPasswordReset({ email: 'ALICE@example.test' })).toBeUndefined()
    await auth.settled()
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.to).toBe(alice.email)
    expect(inbox[0]!.text).toContain('https://chat.example.test/reset-password?token=')
    // повтор через секунду - тот же ответ, письма нет
    await auth.requestPasswordReset({ email: alice.email })
    await auth.settled()
    expect(inbox).toHaveLength(1)

    await expect(auth.confirmPasswordReset({ token: 'мусор', password: 'new-pass-1' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(auth.confirmPasswordReset({ token: tokenOf(inbox[0]), password: 'short' })).rejects.toMatchObject({ code: 'bad_request' })
    await auth.confirmPasswordReset({ token: tokenOf(inbox[0]), password: 'new-pass-1' })
    expect(await auth.verify(r.accessToken)).toBeNull() // сессии закрыты
    expect(db.peek('users', r.user._id)!.verified).toBe(true) // письмо дошло - адрес подтверждён
    await expect(auth.login(alice)).rejects.toMatchObject({ code: 'invalid_credentials' })
    await auth.login({ ...alice, password: 'new-pass-1' })
    await expect(auth.confirmPasswordReset({ token: tokenOf(inbox[0]), password: 'new-pass-2' })).rejects.toMatchObject({ code: 'bad_request' })

    // ссылка живёт час
    now += 61_000
    await auth.requestPasswordReset({ email: alice.email })
    await auth.settled()
    now += 3_600_001
    await expect(auth.confirmPasswordReset({ token: tokenOf(inbox[1]), password: 'new-pass-2' })).rejects.toMatchObject({ code: 'bad_request' })

    // смена пароля гасит отправленную ссылку сброса
    await auth.requestPasswordReset({ email: alice.email })
    await auth.settled()
    const s = await auth.login({ ...alice, password: 'new-pass-1' })
    await auth.changePassword((await auth.verify(s.accessToken))!, { oldPassword: 'new-pass-1', newPassword: 'new-pass-3' })
    await expect(auth.confirmPasswordReset({ token: tokenOf(inbox[2]), password: 'new-pass-4' })).rejects.toMatchObject({ code: 'bad_request' })
    await db.close()
  })

  test('71. смена email: нужен пароль; письмо на новый адрес; после - вход по новому email', async () => {
    const ap = async () => Response.json({ status: 'ok', message: 'success' })
    const { db, auth, inbox, tokenOf } = await setup({ providers: ['password', 'authphone'], fetch: ap })
    const r = await auth.register(alice)
    await auth.register({ email: 'bob@example.test', password: 'bob-pass-1' })
    const user = (await auth.verify(r.accessToken))!

    await expect(auth.requestEmailChange(user, { newEmail: 'alice@new.example.test' })).rejects.toMatchObject({ code: 'invalid_credentials' })
    await expect(auth.requestEmailChange(user, { newEmail: 'alice@new.example.test', password: 'wrong-pass' })).rejects.toMatchObject({
      code: 'invalid_credentials',
    })
    await expect(auth.requestEmailChange(user, { newEmail: 'bob@example.test', password: alice.password })).rejects.toMatchObject({ code: 'conflict' })
    await expect(auth.requestEmailChange(user, { newEmail: alice.email, password: alice.password })).rejects.toMatchObject({ code: 'bad_request' })
    await auth.requestEmailChange(user, { newEmail: 'Alice@New.example.test', password: alice.password })
    expect(inbox.at(-1)).toMatchObject({ to: 'alice@new.example.test', subject: 'Подтвердите новый email - Чат' })
    expect(db.peek('users', r.user._id)!.email).toBe(alice.email) // до подтверждения - старый

    await auth.confirmEmailChange(tokenOf(inbox.at(-1)))
    expect(db.peek('users', r.user._id)).toMatchObject({ email: 'alice@new.example.test', verified: true })
    expect(await auth.verify(r.accessToken)).toBeNull() // email - логин: сессии закрыты
    await expect(auth.login(alice)).rejects.toMatchObject({ code: 'invalid_credentials' })
    await auth.login({ email: 'alice@new.example.test', password: alice.password })
    await expect(auth.confirmEmailChange(tokenOf(inbox.at(-1)))).rejects.toMatchObject({ code: 'bad_request' })

    // вошёл по телефону, пароля нет - email добавляется без пароля
    const p = await auth.loginWithPhone({ phone: '+79991234567', code: '123456' })
    await auth.requestEmailChange((await auth.verify(p.accessToken))!, { newEmail: 'phone@example.test' })
    await auth.confirmEmailChange(tokenOf(inbox.at(-1)))
    expect(db.peek('users', p.user._id)).toMatchObject({ email: 'phone@example.test', phone: '+79991234567', verified: true })
    await db.close()
  })

  test('72. ссылка на прежний адрес не работает, если email уже другой', async () => {
    const { db, auth, inbox, tokenOf } = await setup()
    const r = await auth.register(alice)
    const user = (await auth.verify(r.accessToken))!
    await auth.requestVerification(user)
    await auth.requestPasswordReset({ email: alice.email })
    await auth.settled()
    // email сменил сервер (действие): письма на старый адрес больше не действуют
    await db.c.users!.update(r.user._id, { $set: { email: 'other@example.test' } })
    await expect(auth.confirmVerification(tokenOf(inbox[0]))).rejects.toMatchObject({ code: 'bad_request' })
    await expect(auth.confirmPasswordReset({ token: tokenOf(inbox[1]), password: 'new-pass-1' })).rejects.toMatchObject({ code: 'bad_request' })
    expect(db.peek('users', r.user._id)!.verified).toBe(false)
    await db.close()
  })
})

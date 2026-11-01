// Админка /_/ (design.md §17): первичная настройка, вход суперпользователя,
// документы мимо правил, схема по данным, правила из конфига, страница.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { analyze } from '../src/admin-api'
import { parseRelaxed } from '../src/admin/relaxed'
import { startServer, type RunningServer } from '../src/server'
import { tmpDir } from './helpers'

let s: RunningServer
let su = '' // токен суперпользователя

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${s.url}${path}`, {
    method,
    headers: { ...(opts.token && { Authorization: `Bearer ${opts.token}` }), ...(opts.body !== undefined && { 'Content-Type': 'application/json' }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  })
  const text = await res.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: res.status, body, headers: res.headers }
}

const tail: any[] = []

beforeAll(async () => {
  s = await startServer({
    dataDir: tmpDir('admin'),
    port: 0,
    hostname: '127.0.0.1',
    env: {},
    onWarning: () => {},
    db: { fsync: false },
    admin: { superusers: { loginLimit: { attempts: 5, windowMs: 60_000 } } },
    collections: {
      notes: {
        schema: z.object({ text: z.string().min(1), ownerId: z.string().optional(), n: z.number().optional(), tags: z.array(z.string()).optional(), stamp: z.string().optional(), secret: z.string().optional() }),
        indexes: ['ownerId'],
        owner: 'ownerId',
        fields: { hidden: ['secret'] as any, readonly: ['ownerId'] },
        rules: { list: (u) => (u ? { ownerId: u.id } : false), dependsOn: ['users'] },
        hooks: { beforeCreate: ({ doc }) => ({ ...doc, stamp: 'хук' }) },
      },
    },
  })
  s.tail.listen((e) => tail.push(e))
})
afterAll(() => s.stop())

describe('админка', () => {
  test('127. первичная настройка: ссылка из консоли, только один раз, пароль от 10 символов', async () => {
    expect(s.setupUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/_\/#\/setup\/[\w-]{20,}$/)
    const token = s.setupUrl!.split('/setup/')[1]!
    expect((await call('GET', '/api/_/setup')).body).toEqual({ needed: true })
    // без входа - ничего, кроме setup и login
    expect((await call('GET', '/api/_/info')).status).toBe(401)

    expect(await call('POST', '/api/_/setup', { body: { token: 'чужой', email: 'a@example.test', password: 'admin-pass-1' } })).toMatchObject({ status: 403 })
    expect(await call('POST', '/api/_/setup', { body: { token, email: 'a@example.test', password: 'short' } })).toMatchObject({ status: 400 })
    expect(await call('POST', '/api/_/setup', { body: { token, email: 'не почта', password: 'admin-pass-1' } })).toMatchObject({ status: 400 })
    const ok = await call('POST', '/api/_/setup', { body: { token, email: 'Admin@Example.test', password: 'admin-pass-1' } })
    expect(ok.status).toBe(200)
    expect(ok.body.superuser).toEqual({ id: expect.any(String), email: 'admin@example.test' })
    su = ok.body.token
    // второй раз по той же ссылке - нельзя: токен настройки сгорел
    expect((await call('POST', '/api/_/setup', { body: { token, email: 'b@example.test', password: 'admin-pass-2' } })).status).toBe(403)
    expect((await call('GET', '/api/_/setup')).body).toEqual({ needed: false })
    expect(await s.superusers.installToken()).toBeNull()
    expect((await call('GET', '/api/_/me', { token: su })).body).toEqual({ id: expect.any(String), email: 'admin@example.test' })
  })

  test('128. вход: неверный пароль, лимит попыток, выход, смена пароля закрывает сессии, последнего не удалить', async () => {
    expect(await call('POST', '/api/_/login', { body: { email: 'admin@example.test', password: 'wrong-password' } })).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    expect(await call('POST', '/api/_/login', { body: { email: 'nobody@example.test', password: 'wrong-password' } })).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    const login = await call('POST', '/api/_/login', { body: { email: 'admin@example.test', password: 'admin-pass-1' } })
    expect(login.status).toBe(200)
    const t2 = login.body.token
    expect((await call('GET', '/api/_/me', { token: t2 })).status).toBe(200)
    expect((await call('POST', '/api/_/logout', { token: t2 })).status).toBe(204)
    expect((await call('GET', '/api/_/me', { token: t2 })).status).toBe(401)
    // живая сессия, но секрет чужой - не пускать
    const [sid] = su.split('.')
    expect((await call('GET', '/api/_/me', { token: `${sid}.${'x'.repeat(43)}` })).status).toBe(401)
    expect((await call('GET', '/api/_/me', { token: su })).status).toBe(200)

    for (let i = 0; i < 5; i++) await call('POST', '/api/_/login', { body: { email: 'admin@example.test', password: `wrong-${i}-pass` } })
    expect((await call('POST', '/api/_/login', { body: { email: 'admin@example.test', password: 'admin-pass-1' } })).status).toBe(429)

    // второй администратор; смена его пароля закрывает его сессии
    expect((await call('POST', '/api/_/superusers', { token: su, body: { email: 'b@example.test', password: 'second-pass-1' } })).body).toMatchObject({ created: true })
    const tb = (await call('POST', '/api/_/login', { body: { email: 'b@example.test', password: 'second-pass-1' } })).body.token
    expect((await call('POST', '/api/_/superusers', { token: su, body: { email: 'b@example.test', password: 'second-pass-2' } })).body).toMatchObject({ created: false })
    expect((await call('GET', '/api/_/me', { token: tb })).status).toBe(401)
    const list = (await call('GET', '/api/_/superusers', { token: su })).body
    expect(list.map((x: any) => x.email).sort()).toEqual(['admin@example.test', 'b@example.test'])
    expect(list[0]).not.toHaveProperty('passwordHash')
    const b = list.find((x: any) => x.email === 'b@example.test')
    expect((await call('DELETE', `/api/_/superusers/${b.id}`, { token: su })).status).toBe(204)
    const me = list.find((x: any) => x.email === 'admin@example.test')
    expect(await call('DELETE', `/api/_/superusers/${me.id}`, { token: su })).toMatchObject({ status: 409 })
    expect(tail.some((e) => e.kind === 'admin' && e.op === 'superuser.delete' && e.by === 'admin@example.test')).toBe(true)
  })

  test('129. чужие токены не подходят; коллекции суперпользователей не видны ни админке, ни клиенту', async () => {
    const reg = await call('POST', '/api/auth/register', { body: { email: 'u@example.test', password: 'user-pass-1' } })
    expect((await call('GET', '/api/_/info', { token: reg.body.accessToken })).status).toBe(401)
    expect((await call('GET', '/api/_/info', { token: s.adminToken })).status).toBe(401)
    expect((await call('GET', '/api/_/c/_superusers', { token: su })).status).toBe(404)
    expect((await call('GET', '/api/_/c/_superuserSessions', { token: su })).status).toBe(404)
    expect((await call('GET', '/api/c/_superusers', { token: reg.body.accessToken })).status).toBe(403)
    const info = (await call('GET', '/api/_/info', { token: su })).body
    const names = info.collections.map((c: any) => c.name)
    expect(names).toContain('notes')
    expect(names).toContain('users')
    expect(names).not.toContain('_superusers')
    expect(names).not.toContain('_superuserSessions')
    expect(info.collections.find((c: any) => c.name === '_authTokens').system).toBe(true)
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('130. документы мимо правил: поиск с фильтром, сортировкой, страницами и explain; вставка с хуком и схемой; замена; удаление', async () => {
    for (let i = 1; i <= 30; i++) await s.db.c.notes!.insert({ text: `заметка ${i}`, n: i, ownerId: i % 2 ? 'u1' : 'u2', tags: i % 3 ? ['a'] : ['a', 'b'], secret: `s${i}` })
    const q = (p: Record<string, unknown>) => call('GET', `/api/_/c/notes?${new URLSearchParams(Object.entries(p).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))}`, { token: su })

    const page1 = (await q({ filter: { ownerId: 'u1' }, sort: { n: -1 }, limit: '5' })).body
    expect(page1.total).toBe(15)
    expect(page1.items.map((d: any) => d.n)).toEqual([29, 27, 25, 23, 21])
    expect(page1.items[0]).not.toHaveProperty('secret') // hidden не видит и админка
    expect(page1.explain).toMatchObject({ plan: expect.stringContaining('ownerId'), scanned: expect.any(Number) })
    const page2 = (await q({ filter: { ownerId: 'u1' }, sort: { n: -1 }, limit: '5', skip: '5' })).body
    expect(page2.items.map((d: any) => d.n)).toEqual([19, 17, 15, 13, 11])
    expect((await q({ filter: { n: { $gt: 27 } }, fields: { text: 1 } })).body.items.map((d: any) => Object.keys(d).sort())).toEqual([
      ['_id', 'text'],
      ['_id', 'text'],
      ['_id', 'text'],
    ])
    expect((await q({ filter: { text: { $regex: 'заметка 1', $options: 'i' } } })).body.total).toBe(11)
    expect(await q({ filter: { $where: '1' } })).toMatchObject({ status: 400 })
    expect(await q({ filter: '{нет' })).toMatchObject({ status: 400 })
    expect(await q({ sort: { n: 2 } })).toMatchObject({ status: 400 })

    // вставка: правило create не мешает (его нет), хук и схема работают
    const ins = await call('POST', '/api/_/c/notes', { token: su, body: { text: 'от админа', ownerId: 'u9' } })
    expect(ins.body).toMatchObject({ text: 'от админа', ownerId: 'u9', stamp: 'хук' })
    expect(await call('POST', '/api/_/c/notes', { token: su, body: { text: '' } })).toMatchObject({ status: 400, body: { details: [expect.objectContaining({ path: 'text' })] } })
    expect(await call('POST', '/api/_/c/notes', { token: su, body: { text: 'x', secret: 'нельзя' } })).toMatchObject({ status: 400 })

    // замена целиком: убранные поля удаляются, скрытые остаются, _id не меняется
    const victim = page1.items[0]
    const rep = await call('PUT', `/api/_/c/notes/${victim._id}`, { token: su, body: { _id: victim._id, text: 'заменено', ownerId: victim.ownerId } })
    expect(rep.status).toBe(200)
    expect(rep.body).not.toHaveProperty('n')
    expect(rep.body).not.toHaveProperty('tags')
    expect(rep.body.text).toBe('заменено')
    const raw = await s.db.c.notes!.findOne({ _id: victim._id })
    expect(raw!.secret).toBe('s29')
    expect(raw!._createdAt).toBe(victim._createdAt)
    expect(await call('PUT', `/api/_/c/notes/${victim._id}`, { token: su, body: { _id: 'другой', text: 'x' } })).toMatchObject({ status: 400 })
    expect(await call('PUT', `/api/_/c/notes/нет-такого`, { token: su, body: { text: 'x' } })).toMatchObject({ status: 404 })
    expect((await call('GET', `/api/_/c/notes/${victim._id}`, { token: su })).body.text).toBe('заменено')

    expect((await call('DELETE', `/api/_/c/notes/${victim._id}`, { token: su })).status).toBe(204)
    expect(await s.db.c.notes!.findOne({ _id: victim._id })).toBeNull()
    expect((await call('POST', '/api/_/c/notes/delete-many', { token: su, body: { filter: { ownerId: 'u2' } } })).body).toEqual({ deleted: 15 })
    expect(await call('POST', '/api/_/c/notes/delete-many', { token: su, body: {} })).toMatchObject({ status: 400 })
    expect(await s.db.c.notes!.count()).toBe(15)
    expect(tail.filter((e) => e.kind === 'admin').map((e) => e.op)).toEqual(expect.arrayContaining(['insert', 'replace', 'delete', 'delete-many']))

    // users: passwordHash скрыт и в админке
    const users = (await call('GET', '/api/_/c/users', { token: su })).body.items
    expect(users[0].email).toBe('u@example.test')
    expect(users[0]).not.toHaveProperty('passwordHash')
  })

  test('131. схема по данным и что объявлено в конфиге: индексы, zod, правила исходным кодом, виды полей', async () => {
    const sch = (await call('GET', '/api/_/c/notes/schema', { token: su })).body
    expect(sch.sampled).toBe(15)
    const f = Object.fromEntries(sch.fields.map((x: any) => [x.path, x]))
    expect(f._id.count).toBe(15)
    expect(f.n).toMatchObject({ types: { int: 14 }, min: 1, max: 27 })
    expect(f['tags[]'].types).toEqual({ string: expect.any(Number) })
    expect(f.secret).toBeUndefined()

    const meta = (await call('GET', '/api/_/c/notes/meta', { token: su })).body
    expect(meta.indexes).toEqual(['ownerId'])
    expect(meta.schema.properties.text).toMatchObject({ type: 'string', minLength: 1 })
    expect(meta.rules.list).toContain('ownerId: u.id')
    expect(meta.rules.create).toBeNull()
    expect(meta.dependsOn).toEqual(['users'])
    expect(meta.fields).toMatchObject({ hidden: ['secret'], readonly: ['ownerId'] })

    expect(analyze([{ _id: '1', a: { b: 1.5 }, c: null }, { _id: '2', a: { b: 'x' } }] as any)).toEqual([
      { path: '_id', count: 2, types: { string: 2 }, examples: ['1', '2'] },
      { path: 'a', count: 2, types: { object: 2 }, examples: [] },
      { path: 'a.b', count: 2, types: { double: 1, string: 1 }, examples: [1.5, 'x'], min: 1.5, max: 1.5 },
      { path: 'c', count: 1, types: { null: 1 }, examples: [null] },
    ])
  })

  test('132. страница /_/: свои скрипт и стили, CSP, без встраивания; /_ -> /_/', async () => {
    const page = await call('GET', '/_/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(page.body).toContain('/_/app.js')
    const js = await call('GET', '/_/app.js')
    expect(js.headers.get('content-type')).toContain('javascript')
    expect(js.body.length).toBeGreaterThan(10_000)
    expect((await call('GET', '/_/app.css')).headers.get('content-type')).toContain('text/css')
    expect((await call('GET', '/_')).headers.get('location')).toBe('/_/')
    expect((await call('GET', '/_/../secret.key')).status).toBe(404)
    expect((await call('POST', '/_/')).status).toBe(405)
  })

  test('133. нестрогий JSON строки фильтра: ключи без кавычек, одинарные кавычки, регулярки; ничего не выполняется', () => {
    expect(parseRelaxed(`{ roomId: 'general', n: { $gt: -5.5 }, "a.b": [1, true, null,], }`)).toEqual({ roomId: 'general', n: { $gt: -5.5 }, 'a.b': [1, true, null] })
    expect(parseRelaxed('{ text: /при[/]вет\\//i }')).toEqual({ text: { $regex: 'при[/]вет\\/', $options: 'i' } })
    expect(parseRelaxed(`{ s: 'it\\'s \\u0041' } // комментарий`)).toEqual({ s: "it's A" })
    expect(parseRelaxed('[]')).toEqual([])
    for (const bad of ['{ a: }', '{ a 1 }', "{ a: 'x }", '{ a: 1 } x', '{ a: alert(1) }', '{ a: undefined }', '', '/x']) expect(() => parseRelaxed(bad)).toThrow()
  })
})

describe('админка: настройки и коллекции', () => {
  test('135. настройки входа: на ходу, секреты зашифрованы и не уходят наружу, ошибка - ничего не меняется', async () => {
    const get = async () => (await call('GET', '/api/_/settings', { token: su })).body
    const before = await get()
    expect(before.fixed).toEqual({ auth: false, mail: false, storage: false, profile: false })
    expect(before.db.systemFields.map((f: any) => f.name)).toEqual(['_id', '_createdAt', '_updatedAt'])
    expect(before.callbacks.google).toBe(`${s.url}/api/auth/oauth/google/callback`)

    // Google без адреса приложения - нельзя; вход остаётся прежним
    const noApp = await call('PUT', '/api/_/settings', { token: su, body: { auth: { google: { enabled: true, clientId: 'cid', clientSecret: 'top-secret' } } } })
    expect(noApp).toMatchObject({ status: 400, body: { message: expect.stringContaining('appUrl') } })
    expect(s.auth.settings.providers).toEqual(['password'])

    const ok = await call('PUT', '/api/_/settings', {
      token: su,
      body: { auth: { password: true, signup: false, minPasswordLength: 12, google: { enabled: true, clientId: 'cid', clientSecret: 'top-secret' }, appUrl: 'https://app.example.test' } },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.auth.google).toEqual({ enabled: true, clientId: 'cid', clientSecret: '***' })
    expect(JSON.stringify(ok.body)).not.toContain('top-secret')
    expect(s.auth.settings).toMatchObject({ providers: ['password', 'google'], signup: false, minPasswordLength: 12, appUrl: 'https://app.example.test' })
    // в базе - шифр, не секрет
    const raw = await s.db.c._settings!.findOne({ _id: 'app' })
    expect(raw!.auth.google.clientSecret).toMatch(/^enc:v1:/)
    expect(JSON.stringify(raw)).not.toContain('top-secret')
    // регистрация закрыта - сразу
    expect((await call('POST', '/api/auth/register', { body: { email: 'new@example.test', password: 'long-password-1' } })).status).toBe(403)
    // вход через Google включился: старт OAuth отдаёт адрес провайдера
    const start = await call('POST', '/api/auth/oauth/google/start', { body: { challenge: 'x'.repeat(43) } })
    expect(start.body.url).toContain('client_id=cid')

    // "***" - оставить секрет; выключить Google - выключился
    await call('PUT', '/api/_/settings', { token: su, body: { auth: { signup: true, google: { enabled: false, clientId: 'cid', clientSecret: '***' }, appUrl: 'https://app.example.test' } } })
    expect(s.auth.settings.providers).toEqual(['password'])
    expect((await s.db.c._settings!.findOne({ _id: 'app' }))!.auth.google.clientSecret).toMatch(/^enc:v1:/)
    expect((s.settings as any).current.auth.google.clientSecret).toBe('top-secret') // под шифром - прежний
    // _settings не видна в документах админки
    expect((await call('GET', '/api/_/c/_settings', { token: su })).status).toBe(404)
  })

  test('136. почта из настроек: SMTP без сервера - нет; с сервером - проверочное письмо доходит; обратно в консоль', async () => {
    const { fakeSmtp } = await import('./helpers')
    const smtp = fakeSmtp()
    try {
      expect(await call('PUT', '/api/_/settings', { token: su, body: { mail: { mode: 'smtp', smtp: {} } } })).toMatchObject({ status: 400 })
      expect(s.mail.mode).toBe('dev')
      // почта верная, вход нет - не меняется ничего, в том числе почта
      const half = await call('PUT', '/api/_/settings', { token: su, body: { mail: { mode: 'smtp', smtp: { host: '127.0.0.1', port: smtp.port } }, auth: { github: { enabled: true, clientId: 'x', clientSecret: 'y' }, appUrl: '' } } })
      expect(half.status).toBe(400)
      expect(s.mail.mode).toBe('dev')
      expect(s.auth.settings.providers).not.toContain('github')
      const r = await call('PUT', '/api/_/settings', { token: su, body: { mail: { mode: 'smtp', from: 'Тест <no-reply@app.example.test>', smtp: { host: '127.0.0.1', port: smtp.port } } } })
      expect(r.status).toBe(200)
      expect(s.mail.mode).toBe('smtp')
      expect((await call('POST', '/api/_/settings/test-mail', { token: su, body: { to: 'admin@example.test' } })).body).toEqual({ mode: 'smtp' })
      expect(smtp.mails).toHaveLength(1)
      expect(smtp.mails[0]!.to).toEqual(['admin@example.test'])
      await call('PUT', '/api/_/settings', { token: su, body: { mail: { mode: 'dev' } } })
      expect(s.mail.mode).toBe('dev')
    } finally {
      smtp.stop()
    }
  })

  test('137. коллекции из админки: создать с индексами, клиентам закрыта, индексы, удалить; код и служебные - нельзя', async () => {
    expect(await call('POST', '/api/_/collections', { token: su, body: { name: '1bad' } })).toMatchObject({ status: 400 })
    expect(await call('POST', '/api/_/collections', { token: su, body: { name: 'notes' } })).toMatchObject({ status: 409 })
    expect(await call('POST', '/api/_/collections', { token: su, body: { name: 'orders', indexes: ['_id'] } })).toMatchObject({ status: 400 })
    expect((await call('POST', '/api/_/collections', { token: su, body: { name: 'orders', indexes: ['status'] } })).body).toEqual({ name: 'orders', source: 'admin' })
    const info = (await call('GET', '/api/_/info', { token: su })).body
    expect(info.collections.find((c: any) => c.name === 'orders')).toMatchObject({ count: 0, indexes: ['status'], source: 'admin' })
    expect(info.collections.find((c: any) => c.name === 'notes').source).toBe('code')
    expect(info.collections.map((c: any) => c.name)).not.toContain('_collections')

    for (let i = 0; i < 20; i++) await call('POST', '/api/_/c/orders', { token: su, body: { status: i % 4 ? 'new' : 'paid', n: i } })
    const paid = (await call('GET', `/api/_/c/orders?filter=${encodeURIComponent('{"status":"paid"}')}`, { token: su })).body
    expect(paid.total).toBe(5)
    expect(paid.explain.plan).toContain('status')
    // клиентам закрыта: правил нет
    const user = await call('POST', '/api/auth/login', { body: { email: 'u@example.test', password: 'user-pass-1' } })
    expect((await call('GET', '/api/c/orders', { token: user.body.accessToken })).status).toBe(403)

    expect((await call('PUT', '/api/_/collections/orders', { token: su, body: { indexes: ['status', 'n'] } })).status).toBe(200)
    expect((await call('GET', '/api/_/c/orders/meta', { token: su })).body).toMatchObject({ indexes: ['status', 'n'], source: 'admin' })
    expect(await call('PUT', '/api/_/collections/notes', { token: su, body: { indexes: ['x'] } })).toMatchObject({ status: 409 })
    expect(await call('DELETE', '/api/_/collections/notes', { token: su })).toMatchObject({ status: 409 })
    expect(await call('DELETE', '/api/_/collections/_presence', { token: su })).toMatchObject({ status: 403 })

    // коллекция без описания (пишет код) - удалить можно
    await s.db.c.leftovers!.insert({ x: 1 })
    expect((await call('GET', '/api/_/c/leftovers/meta', { token: su })).body.source).toBe('data')
    expect((await call('DELETE', '/api/_/collections/leftovers', { token: su })).body).toEqual({ deleted: 1 })
    expect((await call('GET', '/api/_/info', { token: su })).body.collections.map((c: any) => c.name)).not.toContain('leftovers')
    expect(tail.filter((e) => e.kind === 'admin').map((e) => e.op)).toEqual(expect.arrayContaining(['collection.create', 'collection.indexes', 'collection.drop', 'settings']))
  })

  test('138. после перезапуска: коллекции из админки с индексами и настройки на месте; сменили секрет сервера - секреты настроек не читаются', async () => {
    await call('PUT', '/api/_/settings', { token: su, body: { auth: { phone: true, signup: false } } })
    const dataDir = s.db.stats.dir.replace(/\/db$/, '')
    await s.stop()
    s = await startServer({ dataDir, port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false } })
    expect(s.auth.settings).toMatchObject({ providers: ['password', 'authphone'], signup: false })
    expect(s.registry.source('orders')).toBe('admin')
    expect((await s.db.c.orders!.explain({ n: 3 })).plan).toContain('n')
    expect(await s.db.c.orders!.count()).toBe(20)
    await s.stop()

    // другой секрет - сервер стартует, секрет Google не расшифровался (пусто)
    const warns: string[] = []
    // и orders теперь объявлена в коде - код главнее, админка предупреждает
    s = await startServer({ dataDir, port: 0, hostname: '127.0.0.1', env: { MABASE_SECRET: 'x'.repeat(40) }, onWarning: (m) => warns.push(m), db: { fsync: false }, collections: { orders: { indexes: ['status'] } } })
    expect(s.settings.view().auth?.google).toMatchObject({ clientSecret: '' })
    expect(s.registry.source('orders')).toBe('code')
    expect((await s.db.c.orders!.explain({ n: 3 })).plan).not.toContain('n')
    expect(warns.join('\n')).toContain('orders объявлена и в mabase.config.ts, и в админке')
  })

  test('139. мастер в терминале: администратор, способы входа, почта; Enter на первом вопросе - пропустить', async () => {
    const { runWizard } = await import('../src/wizard')
    const fresh = await startServer({ dataDir: tmpDir('wizard'), port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false } })
    try {
      const io = (answers: string[]) => {
        const printed: string[] = []
        return { printed, io: { ask: async () => answers.shift() ?? '', secret: async () => answers.shift() ?? '', print: (l: string) => printed.push(l) } }
      }
      const skip = io([''])
      expect(await runWizard(skip.io, { superusers: fresh.superusers, settings: fresh.settings, url: fresh.url })).toBe(false)
      expect(await fresh.superusers.count()).toBe(0)

      const run = io(['Boss@Example.test', 'short', 'wizard-pass-1', 'wizard-pass-2', 'wizard-pass-1', 'wizard-pass-1', '1, 4', 'gh-id', 'gh-secret', 'н', 'https://app.example.test', '1'])
      expect(await runWizard(run.io, { superusers: fresh.superusers, settings: fresh.settings, url: fresh.url })).toBe(true)
      expect(run.printed.join('\n')).toContain('Короче 10')
      expect(run.printed.join('\n')).toContain('не совпали')
      expect(run.printed.join('\n')).toContain(`${fresh.url}/api/auth/oauth/github/callback`)
      expect((await fresh.superusers.list()).map((x) => x.email)).toEqual(['boss@example.test'])
      expect(fresh.auth.settings).toMatchObject({ providers: ['password', 'github'], signup: false, appUrl: 'https://app.example.test' })
      expect(await fresh.superusers.installToken()).toBeNull() // ссылка из консоли больше не работает
    } finally {
      await fresh.stop()
    }
  })

  test('151. hidden поле не пишется ключом с точкой: админка отвечает 400, значение в базе цело', async () => {
    // Свой сервер: предыдущие тесты перезапускают общий s с другим конфигом,
    // и коллекции notes с hidden там уже нет.
    const fresh = await startServer({
      dataDir: tmpDir('hidden'),
      port: 0,
      hostname: '127.0.0.1',
      env: {},
      onWarning: () => {},
      db: { fsync: false },
      // Без схемы: со схемой ('secret' - строка) испортить поле не дал бы zod,
      // а бессхемная коллекция - обычный случай, и там дыра была настоящей.
      collections: { notes: { fields: { hidden: ['secret'] as any } } },
    })
    try {
      const setup = await fetch(`${fresh.url}/api/_/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fresh.setupUrl!.split('/setup/')[1]!, email: 'hidden@example.test', password: 'admin-pass-12345' }),
      }).then((r) => r.json())
      const doc = await fresh.db.c.notes!.insert({ text: 'секретная заметка', secret: 'исходное' })
      for (const body of [{ text: 'секретная заметка', 'secret.x': 1 }, { text: 'секретная заметка', secret: 'новое' }]) {
        const res = await fetch(`${fresh.url}/api/_/c/notes/${doc._id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${setup.token}` },
          body: JSON.stringify(body),
        })
        // Ключ 'secret.x' раньше проходил проверку (сравнивалось полное имя) и через
        // setPath превращал скаляр в объект - то есть перезаписывал скрытое поле.
        expect(res.status).toBe(400)
        expect(fresh.db.peek('notes', doc._id)!.secret).toBe('исходное')
      }
    } finally {
      await fresh.stop()
    }
  })
})

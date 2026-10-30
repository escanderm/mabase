// HTTP API (design.md §17): коллекции, действия, вход, ошибки, CORS, admin, статика, запуск.
import { describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Access } from '../src/access'
import { Actions, defineAction } from '../src/actions'
import { Auth, type AuthOptions } from '../src/auth'
import { openDb } from '../src/db'
import { ActionError } from '../src/errors'
import { createHandler, type HttpOptions } from '../src/http'
import { Mailer, type MailMessage } from '../src/mail'
import { OAUTH_PROVIDERS } from '../src/oauth'
import { startServer } from '../src/server'
import { sleep, tmpDir } from './helpers'

const SECRET = 'test-secret-'.padEnd(48, 'x')
const alice = { email: 'alice@example.test', password: 'alice-pass-1' }
const bob = { email: 'bob@example.test', password: 'bob-pass-1' }

async function setup(o: { http?: Partial<HttpOptions>; auth?: Partial<AuthOptions>; txTimeoutMs?: number } = {}) {
  const db = await openDb({ dir: tmpDir('http'), fsync: false, compactMinBytes: 0, txTimeoutMs: o.txTimeoutMs })
  db.collection('notes', {
    schema: z.object({ text: z.string(), ownerId: z.string(), secret: z.string().optional(), mine: z.string().optional() }),
    indexes: ['ownerId'],
    hooks: { beforeCreate: ({ doc, user }) => ({ ...doc, ownerId: user?.id ?? (doc as any).ownerId, secret: 'скрыто' }) }, // сервер (импорт) задаёт владельца сам
  })
  const access = new Access(db, {
    notes: {
      owner: 'ownerId',
      fields: { readonly: ['ownerId'], hidden: ['secret'], private: ['mine'] },
      rules: {
        list: (u) => (u ? { ownerId: u.id } : false),
        view: (u) => (u ? { ownerId: u.id } : false),
        create: (u) => !!u,
        update: (u, { before }) => u?.id === before.ownerId,
        delete: (u, { before }) => u?.id === before.ownerId,
      },
    },
  })
  const inbox: MailMessage[] = []
  const auth = new Auth(access, { secret: SECRET, mail: new Mailer({ onDevMail: (m) => inbox.push(m) }), ...o.auth })
  const errors: string[] = []
  const actions = new Actions(
    db,
    [
      defineAction('countMine', { handler: ({ user, db }) => db.notes!.count({ ownerId: user.id }) }),
      defineAction('fail', { public: true, handler: () => { throw new Error('секретная подробность') } }),
      defineAction('conflict', { public: true, handler: () => { throw new ActionError('conflict', 'Занято', { field: 'name' }) } }),
      defineAction('slow', {
        public: true,
        handler: async ({ db }) => {
          await db.notes!.count()
          await sleep(300)
        },
      }),
    ],
    { onError: () => void errors.push('action') },
  )
  const h = createHandler({ access, auth, actions, onError: (_, i) => void errors.push(`${i.method} ${i.path}`), ...o.http })
  const call = async (method: string, path: string, opt: { body?: unknown; token?: string; headers?: Record<string, string>; ip?: string } = {}) => {
    const headers: Record<string, string> = { ...(opt.body !== undefined && { 'Content-Type': 'application/json' }), ...(opt.token && { Authorization: `Bearer ${opt.token}` }), ...opt.headers }
    const body = opt.body === undefined ? undefined : typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body)
    const res = await h(new Request(`http://localhost${path}`, { method, headers, body }), { ip: opt.ip ?? '203.0.113.5' })
    const text = await res.text()
    let parsed: any = text
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {}
    return { status: res.status, body: parsed, headers: res.headers }
  }
  return { db, access, auth, h, call, inbox, errors }
}

const q = (o: Record<string, unknown>) => '?' + new URLSearchParams(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))

describe('HTTP', () => {
  test('79. коллекции: правила, фильтр, сортировка, limit, fields, count, запись, чужое - 404', async () => {
    const { db, call } = await setup()
    expect((await call('GET', '/api/c/notes')).status).toBe(401)
    const a = (await call('POST', '/api/auth/register', { body: alice })).body
    const b = (await call('POST', '/api/auth/register', { body: bob })).body
    for (const text of ['в', 'а', 'б']) expect((await call('POST', '/api/c/notes', { token: a.accessToken, body: { text } })).status).toBe(200)
    const bobs = (await call('POST', '/api/c/notes', { token: b.accessToken, body: { text: 'Боба' } })).body
    expect(bobs).toMatchObject({ text: 'Боба', ownerId: b.user._id })
    expect(bobs.secret).toBeUndefined() // hidden

    const list = await call('GET', '/api/c/notes' + q({ sort: { text: 1 }, limit: '2', fields: 'text' }), { token: a.accessToken })
    expect(list.status).toBe(200)
    expect(list.body.items.map((n: any) => n.text)).toEqual(['а', 'б'])
    expect(Object.keys(list.body.items[0]).sort()).toEqual(['_id', 'text'])
    expect((await call('GET', '/api/c/notes' + q({ filter: { text: { $in: ['а', 'Боба'] } } }), { token: a.accessToken })).body.items).toHaveLength(1)
    expect((await call('GET', '/api/c/notes' + q({ count: '1' }), { token: a.accessToken })).body).toEqual({ count: 3 })

    const id = list.body.items[0]._id
    expect((await call('GET', `/api/c/notes/${id}`, { token: a.accessToken })).body.text).toBe('а')
    expect((await call('GET', `/api/c/notes/${id}`, { token: b.accessToken })).status).toBe(404) // чужое не видно
    expect((await call('PATCH', `/api/c/notes/${id}`, { token: a.accessToken, body: { $set: { text: 'А!' } } })).body.text).toBe('А!')
    expect((await call('PATCH', `/api/c/notes/${id}`, { token: a.accessToken, body: { $set: { ownerId: 'x' } } })).status).toBe(403)
    expect((await call('PATCH', `/api/c/notes/${id}`, { token: a.accessToken, body: { text: 'без оператора' } })).status).toBe(400)
    expect((await call('DELETE', `/api/c/notes/${id}`, { token: b.accessToken })).status).toBe(404)
    expect((await call('DELETE', `/api/c/notes/${id}`, { token: a.accessToken })).status).toBe(204)
    expect(db.peek('notes', id)).toBeNull()

    // неверные запросы - 400, а не 500
    for (const path of [
      '/api/c/notes?filter={плохо',
      '/api/c/notes' + q({ filter: { $where: 'true' } }),
      '/api/c/notes' + q({ filter: { secret: 'скрыто' } }),
      '/api/c/notes?limit=0',
      '/api/c/notes?limit=5000',
      '/api/c/notes?page=2',
    ]) {
      expect([path, (await call('GET', path, { token: a.accessToken })).status]).toEqual([path, 400])
    }
    // служебные коллекции снаружи закрыты
    expect((await call('GET', '/api/c/_authTokens', { token: a.accessToken })).status).toBe(403)
    expect((await call('GET', '/api/c/users', { token: a.accessToken })).body.items).toEqual([expect.objectContaining({ email: alice.email })])
    await db.close()
  })

  test('80. ошибки: неверный токен - 401; тело, тип, размер; 404/405; 500 без подробностей; таймаут - 503', async () => {
    const { db, call, errors } = await setup({ http: { maxBodyBytes: 1000 }, txTimeoutMs: 100 })
    const a = (await call('POST', '/api/auth/register', { body: alice })).body
    expect(await call('GET', '/api/c/notes', { token: 'garbage.token' })).toMatchObject({ status: 401, body: { code: 'unauthorized' } })
    expect((await call('GET', '/api/c/notes', { headers: { Authorization: 'Basic abc' } })).status).toBe(401)
    // даже там, где гостю можно: неверный токен - не гость, SDK должен его обновить
    expect((await call('POST', '/api/actions/conflict', { token: 'garbage.token' })).status).toBe(401)
    expect((await call('POST', '/api/c/notes', { token: a.accessToken, body: '{"text":' })).body.code).toBe('bad_request')
    expect((await call('POST', '/api/c/notes', { token: a.accessToken, body: 'text=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status).toBe(415)
    expect((await call('POST', '/api/c/notes', { token: a.accessToken, body: { text: 'x'.repeat(2000) } })).status).toBe(413)
    expect(await call('GET', '/api/nope')).toMatchObject({ status: 404, body: { code: 'not_found' } })
    expect((await call('PUT', '/api/c/notes/1', { token: a.accessToken })).status).toBe(405)
    expect((await call('POST', '/api/c/notes', { token: a.accessToken, body: { text: 1 } })).body).toMatchObject({ code: 'bad_request', details: [expect.objectContaining({ path: 'text' })] })

    expect(await call('POST', '/api/actions/countMine', { token: a.accessToken })).toMatchObject({ status: 200, body: 0 })
    expect((await call('POST', '/api/actions/countMine')).status).toBe(401)
    expect((await call('POST', '/api/actions/nope', { token: a.accessToken })).status).toBe(404)
    expect(await call('POST', '/api/actions/conflict')).toMatchObject({ status: 409, body: { code: 'conflict', message: 'Занято', details: { field: 'name' } } })
    const fail = await call('POST', '/api/actions/fail')
    expect(fail).toMatchObject({ status: 500, body: { code: 'internal', message: 'Внутренняя ошибка сервера' } })
    expect(JSON.stringify(fail.body)).not.toContain('секретная')
    expect(errors).toEqual(['action']) // записано один раз - в Actions
    expect(await call('POST', '/api/actions/slow')).toMatchObject({ status: 503, body: { code: 'unavailable' } })
    expect(fail.headers.get('cache-control')).toBe('no-store')
    await db.close()
  })

  test('81. вход по HTTP: регистрация, me, refresh, logout, смена пароля, письма; IP для лимита', async () => {
    const { db, call, inbox, auth } = await setup({ auth: { loginLimit: { attempts: 2, windowMs: 60_000 } }, http: { trustProxy: true } })
    const r = await call('POST', '/api/auth/register', { body: { ...alice, data: { name: 'Алиса' } } })
    expect(r.status).toBe(200)
    expect(r.body.user.passwordHash).toBeUndefined()
    expect((await call('GET', '/api/auth/me', { token: r.body.accessToken })).body).toMatchObject({ email: alice.email, name: 'Алиса' })
    expect((await call('GET', '/api/auth/me')).status).toBe(401)
    const s2 = (await call('POST', '/api/auth/refresh', { body: { refreshToken: r.body.refreshToken } })).body
    expect(s2.accessToken).toBeString()
    expect((await call('POST', '/api/auth/logout', { body: { refreshToken: s2.refreshToken } })).status).toBe(204)
    expect((await call('GET', '/api/auth/me', { token: s2.accessToken })).status).toBe(401)

    const l = (await call('POST', '/api/auth/login', { body: alice })).body
    const changed = await call('POST', '/api/auth/password', { token: l.accessToken, body: { oldPassword: alice.password, newPassword: 'alice-pass-2' } })
    expect(changed.status).toBe(200)
    expect((await call('POST', '/api/auth/verify-email/request', { token: changed.body.accessToken })).status).toBe(204)
    const vt = decodeURIComponent(/token=(\S+)/.exec(inbox.at(-1)!.text)![1]!)
    expect((await call('POST', '/api/auth/verify-email/confirm', { body: { token: vt } })).status).toBe(204)
    expect((await call('POST', '/api/auth/reset-password/request', { body: { email: 'ghost@example.test' } })).status).toBe(204)
    expect((await call('POST', '/api/auth/reset-password/request', { body: { email: alice.email } })).status).toBe(204)
    await auth.settled()
    const rt = decodeURIComponent(/token=(\S+)/.exec(inbox.at(-1)!.text)![1]!)
    expect((await call('POST', '/api/auth/reset-password/confirm', { body: { token: rt, password: 'alice-pass-3' } })).status).toBe(204)
    expect((await call('POST', '/api/auth/login', { body: { ...alice, password: 'alice-pass-3' } })).status).toBe(200)

    // лимит попыток - по IP клиента; за прокси - последний адрес в X-Forwarded-For
    const wrong = { ...alice, password: 'wrong-pass' }
    const viaProxy = (ip: string) => ({ body: wrong, ip: '127.0.0.1', headers: { 'X-Forwarded-For': `6.6.6.6, ${ip}` } })
    for (let i = 0; i < 2; i++) expect((await call('POST', '/api/auth/login', viaProxy('1.1.1.1'))).status).toBe(401)
    expect((await call('POST', '/api/auth/login', viaProxy('1.1.1.1'))).status).toBe(429)
    expect((await call('POST', '/api/auth/login', viaProxy('2.2.2.2'))).status).toBe(401) // другой клиент за тем же прокси
    await db.close()

    // без trustProxy заголовок X-Forwarded-For ничего не значит: его пишет кто угодно
    const direct = await setup({ auth: { loginLimit: { attempts: 1, windowMs: 60_000 } } })
    await direct.call('POST', '/api/auth/register', { body: alice })
    const spoof = (ip: string) => ({ body: wrong, ip: '203.0.113.7', headers: { 'X-Forwarded-For': ip } })
    expect((await direct.call('POST', '/api/auth/login', spoof('1.1.1.1'))).status).toBe(401)
    expect((await direct.call('POST', '/api/auth/login', spoof('9.9.9.9'))).status).toBe(429)
    await direct.db.close()
  })

  test('82. OAuth по HTTP: start -> провайдер -> callback (302) -> exchange', async () => {
    const issued = new Map<string, string>()
    const fetch = async (url: string, init: RequestInit) => {
      if (url === OAUTH_PROVIDERS.google.tokenUrl) {
        const f = new URLSearchParams(String(init.body))
        expect(f.get('redirect_uri')).toBe('https://api.chat.example.test/api/auth/oauth/google/callback')
        return Response.json({ access_token: issued.get(f.get('code')!) })
      }
      return Response.json({ sub: 'g-1', email: 'g@example.test', email_verified: true, name: 'Гугл' })
    }
    const { db, call, h } = await setup({
      auth: { providers: ['password', 'google'], oauth: { google: { clientId: 'cid', clientSecret: 'cs' } }, appUrl: 'https://chat.example.test', fetch },
      http: { serverUrl: 'https://api.chat.example.test/' },
    })
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const start = await call('POST', '/api/auth/oauth/google/start', { body: { challenge, returnTo: '/rooms' } })
    expect(start.status).toBe(200)
    const u = new URL(start.body.url)
    expect(u.searchParams.get('redirect_uri')).toBe('https://api.chat.example.test/api/auth/oauth/google/callback')
    issued.set('c1', 'tok1')
    const cb = await h(new Request(`https://api.chat.example.test/api/auth/oauth/google/callback?code=c1&state=${u.searchParams.get('state')}`))
    expect(cb.status).toBe(302)
    const loc = cb.headers.get('location')!
    expect(loc).toStartWith('https://chat.example.test/rooms#mb_oauth=')
    const code = new URLSearchParams(new URL(loc).hash.slice(1)).get('mb_oauth')
    const s = await call('POST', '/api/auth/oauth/exchange', { body: { code, verifier } })
    expect(s.body.user).toMatchObject({ email: 'g@example.test', name: 'Гугл', verified: true })
    expect((await call('POST', '/api/auth/oauth/github/start', { body: { challenge } })).status).toBe(404)
    await db.close()
  })

  test('83. CORS: только разрешённые адреса; preflight', async () => {
    const plain = await setup()
    const r0 = await plain.call('GET', '/api/health', { headers: { Origin: 'https://chat.example.test' } })
    expect(r0.headers.get('access-control-allow-origin')).toBeNull()
    await plain.db.close()

    const { db, call } = await setup({ http: { cors: ['https://chat.example.test'] } })
    const ok = await call('GET', '/api/health', { headers: { Origin: 'https://chat.example.test' } })
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://chat.example.test')
    expect((await call('GET', '/api/health', { headers: { Origin: 'https://evil.example.test' } })).headers.get('access-control-allow-origin')).toBeNull()
    const pre = await call('OPTIONS', '/api/c/notes', { headers: { Origin: 'https://chat.example.test', 'Access-Control-Request-Method': 'POST' } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-headers')).toContain('Authorization')
    await db.close()
  })

  test('84. admin: только localhost и токен; compact, backup, импорт NDJSON', async () => {
    const adminToken = randomBytes(32).toString('base64url')
    const { db, call } = await setup({ http: { adminToken } })
    const local = { ip: '127.0.0.1', token: adminToken }
    expect((await call('POST', '/api/admin/compact', { ip: '127.0.0.1' })).status).toBe(404) // без токена
    expect((await call('POST', '/api/admin/compact', { ip: '203.0.113.5', token: adminToken })).status).toBe(404) // не с этой машины
    expect((await call('POST', '/api/admin/compact', { ...local, token: adminToken.slice(1) + 'x' })).status).toBe(404)

    const ndjson = ['{"_id":"n1","text":"раз","ownerId":"u1"}', '{"_id":"n2","text":"два","ownerId":"u1"}', '', '{"text":"без id","ownerId":"u2"}'].join('\n')
    const imp = await call('POST', '/api/admin/import/notes', { ...local, body: ndjson, headers: { 'Content-Type': 'application/x-ndjson' } })
    expect(imp).toMatchObject({ status: 200, body: { inserted: 3, skipped: 0 } })
    expect(db.peek('notes', 'n1')).toMatchObject({ text: 'раз', ownerId: 'u1', secret: 'скрыто' }) // хуки работают, user = null
    const again = await call('POST', '/api/admin/import/notes', { ...local, body: ndjson.split('\n').slice(0, 2).join('\n') })
    expect(again.body).toEqual({ inserted: 0, skipped: 2 })
    expect((await call('POST', '/api/admin/import/notes', { ...local, body: '{"text":1}' })).body.code).toBe('bad_request') // схема
    expect((await call('POST', '/api/admin/import/notes', { ...local, body: 'не json' })).body).toMatchObject({ code: 'bad_request', message: 'строка 1: не JSON' })

    expect((await call('POST', '/api/admin/compact', local)).status).toBe(200)
    await db.c.notes!.insert({ _id: 'late', text: 'после компактирования', ownerId: 'u1' }) // должна попасть в бэкап
    const dest = join(tmpDir('http-backup'), 'db')
    const bk = await call('POST', '/api/admin/backup', { ...local, body: { dir: dest } })
    expect(bk).toMatchObject({ status: 200, body: { tx: db.lastTx } })
    expect((await call('POST', '/api/admin/backup', { ...local, body: { dir: dest } })).status).toBe(500) // папка не пустая
    const restored = await openDb({ dir: dest, fsync: false })
    expect(await restored.c.notes!.count()).toBe(4)
    expect(restored.peek('notes', 'late')).not.toBeNull()
    await restored.close()
    await db.close()
  })

  test('85. статика: файлы, SPA, выход за папку не проходит', async () => {
    const dir = tmpDir('public')
    const pub = join(dir, 'public')
    mkdirSync(join(pub, 'assets'), { recursive: true })
    writeFileSync(join(pub, 'index.html'), '<h1>чат</h1>')
    writeFileSync(join(pub, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(dir, 'secret.key'), 'СЕКРЕТ')
    symlinkSync(join(dir, 'secret.key'), join(pub, 'link.txt'))
    const { db, call } = await setup({ http: { publicDir: pub } })
    expect(await call('GET', '/')).toMatchObject({ status: 200, body: '<h1>чат</h1>' })
    expect(await call('GET', '/assets/app.js')).toMatchObject({ status: 200, body: 'console.log(1)' })
    expect(await call('GET', '/rooms/42')).toMatchObject({ status: 200, body: '<h1>чат</h1>' }) // SPA
    expect((await call('GET', '/assets/missing.js')).status).toBe(404)
    for (const p of ['/../secret.key', '/%2e%2e/secret.key', '/assets/..%2f..%2fsecret.key', '/link.txt']) {
      const r = await call('GET', p)
      expect([p, r.status, String(r.body).includes('СЕКРЕТ')]).toEqual([p, 404, false])
    }
    expect((await call('POST', '/')).status).toBe(404)
    await db.close()
  })

  test('86. запуск: настоящий порт, секрет в файле переживает рестарт, MABASE_SECRET, admin.token', async () => {
    const dataDir = tmpDir('server')
    const warnings: string[] = []
    const cfg = { dataDir, port: 0, hostname: '127.0.0.1', env: {}, onWarning: (m: string) => void warnings.push(m), db: { fsync: false } }
    const s1 = await startServer(cfg)
    expect(await (await fetch(`${s1.url}/api/health`)).json()).toEqual({ ok: true })
    const reg = await (await fetch(`${s1.url}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alice) })).json()
    expect(statSync(join(dataDir, 'secret.key')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, 'admin.json')).mode & 0o777).toBe(0o600)
    const admin1 = JSON.parse(readFileSync(join(dataDir, 'admin.json'), 'utf8')).token
    expect(admin1).toBe(s1.adminToken)
    // admin с этой машины по токену из файла
    expect((await fetch(`${s1.url}/api/admin/compact`, { method: 'POST', headers: { Authorization: `Bearer ${admin1}` } })).status).toBe(200)
    expect(warnings.some((w) => w.includes('secret.key'))).toBe(true)
    expect(warnings.some((w) => w.includes('Почта не настроена'))).toBe(true)
    await s1.stop()

    const s2 = await startServer(cfg)
    const me = await fetch(`${s2.url}/api/auth/me`, { headers: { Authorization: `Bearer ${reg.accessToken}` } })
    expect(me.status).toBe(200) // тот же секрет - вход пережил рестарт
    expect(s2.adminToken).not.toBe(admin1) // токен admin новый на каждый старт
    await s2.stop()

    const s3 = await startServer({ ...cfg, env: { MABASE_SECRET: 'env-secret-'.padEnd(40, 'y') } })
    expect((await fetch(`${s3.url}/api/auth/me`, { headers: { Authorization: `Bearer ${reg.accessToken}` } })).status).toBe(401) // другой секрет
    await s3.stop()
  })
})

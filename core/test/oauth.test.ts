// Вход через Google и GitHub (design.md §11): PKCE, state, одноразовый код, кто это.
import { describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { Access } from '../src/access'
import { Auth, type AuthOptions } from '../src/auth'
import { openDb } from '../src/db'
import { OAUTH_PROVIDERS } from '../src/oauth'
import { tmpDir } from './helpers'

const SECRET = 'test-secret-'.padEnd(48, 'x')
const APP = 'https://chat.example.test'
const REDIRECT = 'https://api.chat.example.test/api/auth/oauth/cb'
const b64sha256 = (s: string) => createHash('sha256').update(s).digest('base64url')

type Grant = { provider: string; challenge: string; redirectUri: string; profile: any; emails?: any[] }

// Поддельные Google и GitHub: выдают code, меняют его на токен (проверяя
// секрет, redirect_uri и PKCE, как настоящие), отдают профиль по токену.
function fakeProviders() {
  const issued = new Map<string, Grant>()
  const tokens = new Map<string, Grant>()
  const fail = { token: false, profile: false }
  let n = 0
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url === OAUTH_PROVIDERS.google.tokenUrl || url === OAUTH_PROVIDERS.github.tokenUrl) {
      const f = new URLSearchParams(String(init.body))
      const g = issued.get(f.get('code')!)
      issued.delete(f.get('code')!)
      const ok =
        !fail.token &&
        g &&
        f.get('client_secret') === `secret-${g.provider}` &&
        f.get('redirect_uri') === g.redirectUri &&
        b64sha256(f.get('code_verifier') ?? '') === g.challenge
      if (!ok) return url.includes('github') ? Response.json({ error: 'bad_verification_code' }) : Response.json({ error: 'invalid_grant' }, { status: 400 })
      const t = `tok-${++n}`
      tokens.set(t, g!)
      return Response.json({ access_token: t, token_type: 'bearer' })
    }
    const g = tokens.get(String((init.headers as Record<string, string>).Authorization).slice('Bearer '.length))
    if (!g || fail.profile) return new Response('no', { status: g ? 500 : 401 })
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo' || url === 'https://api.github.com/user') return Response.json(g.profile)
    if (url === 'https://api.github.com/user/emails') return Response.json(g.emails ?? [])
    return new Response('?', { status: 404 })
  }
  // Пользователь у провайдера согласился: провайдер возвращает code и state.
  const consent = (authUrl: string, provider: string, profile: any, emails?: any[]) => {
    const u = new URL(authUrl)
    const code = `code-${++n}`
    issued.set(code, { provider, challenge: u.searchParams.get('code_challenge')!, redirectUri: u.searchParams.get('redirect_uri')!, profile, emails })
    return { code, state: u.searchParams.get('state')! }
  }
  return { fetch, consent, fail }
}

async function setup(opts: Partial<AuthOptions> = {}) {
  const fp = fakeProviders()
  const errors: string[] = []
  const reasons: string[] = []
  const db = await openDb({ dir: tmpDir('oauth'), fsync: false, compactMinBytes: 0 })
  const auth = new Auth(new Access(db, {}), {
    secret: SECRET,
    providers: ['password', 'google', 'github'],
    oauth: { google: { clientId: 'id-google', clientSecret: 'secret-google' }, github: { clientId: 'id-github', clientSecret: 'secret-github' } },
    appUrl: APP,
    fetch: fp.fetch,
    onError: (err, where) => (errors.push(where), reasons.push(String(err))),
    ...opts,
  })
  // Весь путь глазами SDK: start -> провайдер -> callback -> exchange.
  const login = async (provider: string, profile: any, o: { emails?: any[]; returnTo?: string; user?: any } = {}) => {
    const verifier = randomBytes(32).toString('base64url')
    const { url } = auth.oauthStart(provider, { redirectUri: REDIRECT, challenge: b64sha256(verifier), returnTo: o.returnTo, user: o.user })
    const { code, state } = fp.consent(url, provider, profile, o.emails)
    const { redirect } = await auth.oauthCallback(provider, { code, state })
    const h = new URLSearchParams(new URL(redirect).hash.slice(1))
    if (h.get('mb_oauth_error')) return { error: h.get('mb_oauth_error')!, redirect }
    return { session: await auth.oauthExchange({ code: h.get('mb_oauth'), verifier }), redirect, code: h.get('mb_oauth')!, verifier }
  }
  return { db, auth, fp, login, errors, reasons }
}

const googleAlice = { sub: 'g-111', email: 'Alice@Example.test', email_verified: true, name: 'Алиса', picture: 'https://pic/a' }

describe('OAuth', () => {
  test('73. Google: новый пользователь; адрес провайдера с PKCE; state и код одноразовые; verifier обязателен', async () => {
    let now = Date.now()
    const { db, auth, fp, login } = await setup({ now: () => now })
    const verifier = randomBytes(32).toString('base64url')
    const { url } = auth.oauthStart('google', { redirectUri: REDIRECT, challenge: b64sha256(verifier), returnTo: '/rooms?x=1' })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe(OAUTH_PROVIDERS.google.authUrl)
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'id-google',
      redirect_uri: REDIRECT,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    })
    expect(u.searchParams.get('code_challenge')).not.toBe(b64sha256(verifier)) // у сервера свой PKCE-ключ
    expect(url).not.toContain('secret-google')

    const { code, state } = fp.consent(url, 'google', googleAlice)
    const { redirect } = await auth.oauthCallback('google', { code, state })
    expect(redirect).toStartWith(`${APP}/rooms?x=1#mb_oauth=`)
    // повтор колбэка с тем же state - нет
    expect((await auth.oauthCallback('google', { code, state })).redirect).toBe(`${APP}/#mb_oauth_error=invalid_state`)

    const oneTime = new URLSearchParams(new URL(redirect).hash.slice(1)).get('mb_oauth')!
    await expect(auth.oauthExchange({ code: oneTime, verifier: 'чужой' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(auth.oauthExchange({ code: oneTime, verifier })).rejects.toMatchObject({ code: 'bad_request' }) // сгорел на неверном verifier

    // пользователь создан на колбэке; вход тем же аккаунтом Google - он же
    const r = await login('google', googleAlice)
    expect(r.session!.user).toMatchObject({ email: 'alice@example.test', verified: true, name: 'Алиса', roles: [] })
    expect(await auth.verify(r.session!.accessToken)).toMatchObject({ id: r.session!.user._id })
    expect(await db.c.users!.count({})).toBe(1)
    expect(await db.c._externalAuths!.find({}, { fields: ['provider', 'providerId', 'userId'] })).toEqual([
      expect.objectContaining({ provider: 'google', providerId: 'g-111', userId: r.session!.user._id }),
    ])
    await expect(auth.oauthExchange({ code: r.code, verifier: r.verifier })).rejects.toMatchObject({ code: 'bad_request' }) // одноразовый
    const again = await login('google', { ...googleAlice, name: 'Другое имя' })
    expect(again.session!.user).toMatchObject({ _id: r.session!.user._id, name: 'Алиса' }) // профиль при входе не переписывается

    // код живёт минуту, state - 10 минут
    const v2 = randomBytes(32).toString('base64url')
    const s2 = auth.oauthStart('google', { redirectUri: REDIRECT, challenge: b64sha256(v2) })
    const g2 = fp.consent(s2.url, 'google', googleAlice)
    const c2 = new URLSearchParams(new URL((await auth.oauthCallback('google', g2)).redirect).hash.slice(1)).get('mb_oauth')!
    now += 61_000
    await expect(auth.oauthExchange({ code: c2, verifier: v2 })).rejects.toMatchObject({ code: 'bad_request' })
    const s3 = auth.oauthStart('google', { redirectUri: REDIRECT, challenge: b64sha256(v2) })
    now += 10 * 60_000 + 1
    expect((await auth.oauthCallback('google', fp.consent(s3.url, 'google', googleAlice))).redirect).toBe(`${APP}/#mb_oauth_error=invalid_state`)
    await db.close()
  })

  test('74. GitHub: email - основной из /user/emails; неподтверждённый email не сохраняется', async () => {
    const { db, login } = await setup()
    const r = await login('github', { id: 42, login: 'bob-gh', name: null, avatar_url: 'https://pic/b', email: 'public@example.test' }, {
      emails: [
        { email: 'other@example.test', primary: false, verified: true },
        { email: 'bob@example.test', primary: true, verified: true },
      ],
    })
    expect(r.session!.user).toMatchObject({ email: 'bob@example.test', verified: true, name: 'bob-gh' })
    expect(await db.c._externalAuths!.count({ provider: 'github', providerId: '42' })).toBe(1)

    // email у провайдера не подтверждён: пользователь создаётся без email - чужой адрес не занять
    const u = await login('github', { id: 43, login: 'carol' }, { emails: [{ email: 'carol@example.test', primary: true, verified: false }] })
    expect(u.session!.user.email).toBeUndefined()
    expect(u.session!.user.verified).toBe(false)
    await db.close()

    // свои поля нового пользователя из профиля - без зарезервированных
    const own = await setup({ oauthFields: (p) => ({ nick: p.name, avatar: p.avatar, roles: ['admin'], verified: true, email: 'x@evil.test', _id: 'me' }) })
    const o = await own.login('github', { id: 44, login: 'dave', avatar_url: 'https://pic/d' }, { emails: [{ email: 'dave@example.test', primary: true, verified: false }] })
    expect(o.session!.user).toMatchObject({ nick: 'dave', avatar: 'https://pic/d', roles: [], verified: false })
    expect(o.session!.user.email).toBeUndefined()
    expect(o.session!.user._id).not.toBe('me')
    await own.db.close()
  })

  test('75. привязка по подтверждённому email; захват заранее: пароль чужака стирается', async () => {
    const { db, auth, login } = await setup()
    // Алиса зарегистрировалась паролем и подтвердила email
    const a = await auth.register({ email: 'alice@example.test', password: 'alice-pass-1' })
    await db.c.users!.update(a.user._id, { $set: { verified: true } })
    const r = await login('google', googleAlice)
    expect(r.session!.user._id).toBe(a.user._id)
    await auth.login({ email: 'alice@example.test', password: 'alice-pass-1' }) // пароль остался
    expect(await auth.verify(a.accessToken)).not.toBeNull()

    // Мэллори заранее зарегистрировалась паролем на адрес Боба, адрес не подтверждён
    const m = await auth.register({ email: 'bob@example.test', password: 'mallory-pass' })
    const b = await login('google', { sub: 'g-222', email: 'bob@example.test', email_verified: true, name: 'Боб' })
    expect(b.session!.user._id).toBe(m.user._id)
    expect(db.peek('users', m.user._id)).toMatchObject({ verified: true })
    expect(db.peek('users', m.user._id)!.passwordHash).toBeUndefined()
    expect(await auth.verify(m.accessToken)).toBeNull() // сессия Мэллори закрыта
    await expect(auth.login({ email: 'bob@example.test', password: 'mallory-pass' })).rejects.toMatchObject({ code: 'invalid_credentials' })
    expect(await auth.verify(b.session!.accessToken)).not.toBeNull()
    await db.close()
  })

  test('76. неподтверждённый email, который уже занят, - email_taken; signup: false - только существующие', async () => {
    const { db, auth, login } = await setup({ signup: false })
    await auth.upsertUser({ email: 'alice@example.test', password: 'alice-pass-1' })
    const r = await login('google', { ...googleAlice, email_verified: false })
    expect(r).toMatchObject({ error: 'email_taken', redirect: `${APP}/#mb_oauth_error=email_taken` })
    expect(await login('google', { sub: 'g-new', email: 'new@example.test', email_verified: true })).toMatchObject({ error: 'signup_closed' })
    // регистрация закрыта, но существующего пользователя по подтверждённому email вход находит
    const ok = await login('google', googleAlice)
    expect(ok.session!.user.email).toBe('alice@example.test')
    expect(await db.c.users!.count({})).toBe(1)
    await db.close()
  })

  test('77. привязка из профиля, чужой аккаунт провайдера, отвязка последнего способа входа', async () => {
    const { db, auth, login } = await setup()
    const a = await auth.register({ email: 'alice@example.test', password: 'alice-pass-1' })
    const alice = (await auth.verify(a.accessToken))!
    // у Алисы в GitHub другой email - привязка идёт к вошедшему, а не по email
    const l = await login('github', { id: 7, login: 'alice-gh' }, { user: alice, emails: [{ email: 'gh@example.test', primary: true, verified: true }] })
    expect(l.session!.user._id).toBe(a.user._id)
    expect((await login('github', { id: 7, login: 'alice-gh' })).session!.user._id).toBe(a.user._id)

    // этот GitHub уже у Алисы - Боб привязать его не может
    const b = await auth.register({ email: 'bob@example.test', password: 'bob-pass-1' })
    const bob = (await auth.verify(b.accessToken))!
    expect(await login('github', { id: 7, login: 'alice-gh' }, { user: bob })).toMatchObject({ error: 'already_linked' })

    await auth.oauthUnlink(alice, 'github') // пароль есть - можно
    expect(await db.c._externalAuths!.count({ userId: a.user._id })).toBe(0)
    await expect(auth.oauthUnlink(alice, 'github')).rejects.toMatchObject({ code: 'not_found' })
    await expect(auth.oauthUnlink(null, 'github')).rejects.toMatchObject({ code: 'unauthorized' })

    // вошёл только через Google - отвязать нельзя, иначе не войти
    const g = await login('google', { sub: 'g-only', email: 'only@example.test', email_verified: true })
    await expect(auth.oauthUnlink((await auth.verify(g.session!.accessToken))!, 'google')).rejects.toMatchObject({ code: 'bad_request' })

    // удалили пользователя - привязки удалены
    await db.c.users!.remove(g.session!.user._id)
    expect(await db.c._externalAuths!.count({ providerId: 'g-only' })).toBe(0)
    await db.close()
  })

  test('78. отказ, сбой провайдера, чужой провайдер в колбэке, неверные параметры и конфиг', async () => {
    const { db, auth, fp, login, errors, reasons } = await setup()
    const ch = b64sha256('v')
    // пользователь нажал "отмена"
    const s1 = auth.oauthStart('google', { redirectUri: REDIRECT, challenge: ch })
    const st1 = new URL(s1.url).searchParams.get('state')!
    expect((await auth.oauthCallback('google', { error: 'access_denied', state: st1 })).redirect).toBe(`${APP}/#mb_oauth_error=denied`)
    const s0 = auth.oauthStart('google', { redirectUri: REDIRECT, challenge: ch })
    const g0 = fp.consent(s0.url, 'google', googleAlice) // код выдан, но провайдер сообщает отказ - верим отказу
    expect((await auth.oauthCallback('google', { ...g0, error: 'access_denied' })).redirect).toBe(`${APP}/#mb_oauth_error=denied`)
    // state от Google в колбэке GitHub
    const s2 = auth.oauthStart('google', { redirectUri: REDIRECT, challenge: ch })
    expect((await auth.oauthCallback('github', fp.consent(s2.url, 'github', {}))).redirect).toBe(`${APP}/#mb_oauth_error=invalid_state`)

    fp.fail.token = true
    expect(await login('github', { id: 1 })).toMatchObject({ error: 'provider_error' }) // GitHub: 200 и { error }
    expect(await login('google', googleAlice)).toMatchObject({ error: 'provider_error' })
    fp.fail.token = false
    fp.fail.profile = true
    expect(await login('google', googleAlice)).toMatchObject({ error: 'provider_error' })
    fp.fail.profile = false
    expect(await login('google', { email: 'x@example.test' })).toMatchObject({ error: 'provider_error' }) // нет sub
    expect(errors).toEqual(['oauth github', 'oauth google', 'oauth google', 'oauth google'])
    expect(reasons[0]).toContain('bad_verification_code') // GitHub: 200 с { error } - ошибка обмена, а не "нет токена"
    expect(await db.c.users!.count({})).toBe(0)

    for (const returnTo of ['//evil.example.test', 'https://evil.example.test', '/\\evil', 'rooms', '/a#b']) {
      expect(() => auth.oauthStart('google', { redirectUri: REDIRECT, challenge: ch, returnTo })).toThrow(expect.objectContaining({ code: 'bad_request' }))
    }
    expect(() => auth.oauthStart('google', { redirectUri: REDIRECT, challenge: 'короткий' })).toThrow(expect.objectContaining({ code: 'bad_request' }))
    expect(() => auth.oauthStart('yandex', { redirectUri: REDIRECT, challenge: ch })).toThrow(expect.objectContaining({ code: 'not_found' }))
    await db.close()

    const db2 = await openDb({ dir: tmpDir('oauth'), fsync: false })
    const acc = new Access(db2, {})
    const pwOnly = new Auth(acc, { secret: SECRET, appUrl: APP, oauth: { google: { clientId: 'i', clientSecret: 's' } } })
    expect(() => pwOnly.oauthStart('google', { redirectUri: REDIRECT, challenge: ch })).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => new Auth(acc, { secret: SECRET, appUrl: APP, providers: ['google'] })).toThrow(/clientSecret/)
    expect(() => new Auth(acc, { secret: SECRET, providers: ['google'], oauth: { google: { clientId: 'i', clientSecret: 's' } } })).toThrow(/appUrl/)
    expect(() => new Auth(acc, { secret: SECRET, providers: ['vk' as any] })).toThrow(/неизвестный/)
    await db2.close()
  })
})

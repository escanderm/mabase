// Тест 211: публичный список способов входа и запуск OAuth.
// Фронтенду нужно знать, какие кнопки рисовать; проверяем и отказ провайдера.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { startServer } from '../src/server'
import { tmpDir } from './helpers'

const call = async (base: string, method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  return { status: r.status, location: r.headers.get('location'), json: await r.json().catch(() => null) }
}

describe('способы входа', () => {
  test('211. проверка типов', () => {
    expect(createHash('sha256').update('v'.repeat(43)).digest('base64url')).toHaveLength(43)
  })

  test('215. телефон: ссылки на ботов AuthPhone в /api/auth/providers, свой сервис может их убрать', async () => {
    const s = await startServer({ dataDir: tmpDir('bots'), port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false } })
    try {
      const setup = await call(s.url, 'POST', '/api/_/setup', undefined, { token: s.setupUrl!.split('/setup/')[1]!, email: 'admin@example.test', password: 'admin-pass-12345' })
      const token = setup.json.token
      // пока телефон выключен, ссылок нет
      expect((await call(s.url, 'GET', '/api/auth/providers')).json.authphone).toBeUndefined()
      const auth = { password: true, signup: true, minPasswordLength: 8, appUrl: 'http://127.0.0.1:8090', phone: true }
      expect((await call(s.url, 'PUT', '/api/_/settings', token, { auth })).status).toBe(200)
      const p = (await call(s.url, 'GET', '/api/auth/providers')).json
      expect(p.providers).toContain('authphone')
      expect(p.authphone).toEqual({ telegram: 'https://t.me/myauth_superbot', max: 'https://max.ru/id773001707708_1_bot?start=start' })
    } finally {
      await s.stop()
    }

    // свой сервис: пустая ссылка - кнопки нет
    const own = await startServer({ dataDir: tmpDir('bots2'), port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false }, auth: { providers: ['authphone'], authphone: { bots: { telegram: 'https://t.me/own_bot', max: '' } } } })
    try {
      const p = (await call(own.url, 'GET', '/api/auth/providers')).json
      expect(p.authphone).toEqual({ telegram: 'https://t.me/own_bot' })
    } finally {
      await own.stop()
    }
  }, 30_000)

  test('214. обязательные поля профиля: из настроек, с проверкой имён и приоритетом кода', async () => {
    const s = await startServer({ dataDir: tmpDir('profile'), port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false } })
    try {
      expect((await call(s.url, 'GET', '/api/auth/providers')).json.profile).toEqual({ required: [] })
      const setup = await call(s.url, 'POST', '/api/_/setup', undefined, { token: s.setupUrl!.split('/setup/')[1]!, email: 'admin@example.test', password: 'admin-pass-12345' })
      const token = setup.json.token
      expect((await call(s.url, 'PUT', '/api/_/settings', token, { profile: { required: ['name', 'avatarUrl'] } })).status).toBe(200)
      expect((await call(s.url, 'GET', '/api/auth/providers')).json.profile).toEqual({ required: ['name', 'avatarUrl'] })
      // мусор в имени поля - 400, настройки не меняются
      expect((await call(s.url, 'PUT', '/api/_/settings', token, { profile: { required: ['name.x'] } })).status).toBe(400)
      expect((await call(s.url, 'GET', '/api/auth/providers')).json.profile).toEqual({ required: ['name', 'avatarUrl'] })
    } finally {
      await s.stop()
    }

    // код главнее: раздел в админке только показывается
    const fixed = await startServer({ dataDir: tmpDir('profile2'), port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false }, auth: { profile: { required: ['name'] } } })
    try {
      const setup = await call(fixed.url, 'POST', '/api/_/setup', undefined, { token: fixed.setupUrl!.split('/setup/')[1]!, email: 'admin@example.test', password: 'admin-pass-12345' })
      expect((await call(fixed.url, 'GET', '/api/auth/providers')).json.profile).toEqual({ required: ['name'] })
      const view = await call(fixed.url, 'GET', '/api/_/settings', setup.json.token)
      expect(view.json.fixed.profile).toBe(true)
      expect((await call(fixed.url, 'PUT', '/api/_/settings', setup.json.token, { profile: { required: [] } })).status).toBe(409)
    } finally {
      await fixed.stop()
    }
  }, 30_000)

  test('213. Яндекс и VK ID включаются в настройках; VK без секрета допустим, Яндекс без секрета - нет', async () => {
    const s = await startServer({ dataDir: tmpDir('providers2'), port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false } })
    try {
      const setup = await call(s.url, 'POST', '/api/_/setup', undefined, { token: s.setupUrl!.split('/setup/')[1]!, email: 'admin@example.test', password: 'admin-pass-12345' })
      const token = setup.json.token
      const base = { password: true, signup: true, minPasswordLength: 8, appUrl: 'http://127.0.0.1:8090' }
      // Яндекс без секрета - отказ с понятным текстом
      expect((await call(s.url, 'PUT', '/api/_/settings', token, { auth: { ...base, yandex: { enabled: true, clientId: 'yandex-id', clientSecret: '' } } })).status).toBe(400)
      // VK ID публичному приложению секрет не нужен
      const ok = await call(s.url, 'PUT', '/api/_/settings', token, {
        auth: { ...base, yandex: { enabled: true, clientId: 'yandex-id', clientSecret: 'yandex-secret' }, vk: { enabled: true, clientId: 'vk-id', clientSecret: '' } },
      })
      expect(ok.status).toBe(200)
      expect((await call(s.url, 'GET', '/api/auth/providers')).json.providers).toEqual(['password', 'yandex', 'vk'])
      expect(ok.json.fixed.storage).toBe(false)
      // вернуть как было
      expect((await call(s.url, 'PUT', '/api/_/settings', token, { auth: { ...base, yandex: { enabled: false, clientId: 'yandex-id', clientSecret: 'yandex-secret' }, vk: { enabled: false, clientId: 'vk-id', clientSecret: '' } } })).status).toBe(200)
      expect((await call(s.url, 'GET', '/api/auth/providers')).json.providers).toEqual(['password'])
    } finally {
      await s.stop()
    }
  }, 30_000)

  test('212. /api/auth/providers: пароль по умолчанию, Google после включения, отказ провайдера', async () => {
    const s = await startServer({ dataDir: tmpDir('providers'), port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false } })
    try {
      expect((await call(s.url, 'GET', '/api/auth/providers')).json).toMatchObject({ providers: ['password'], signup: true, profile: { required: [] } })
      const setup = await call(s.url, 'POST', '/api/_/setup', undefined, { token: s.setupUrl!.split('/setup/')[1]!, email: 'admin@example.test', password: 'admin-pass-12345' })
      expect(setup.status).toBe(200)
      const token = setup.json.token
      const auth = { password: true, signup: true, minPasswordLength: 8, appUrl: 'http://127.0.0.1:8090', google: { enabled: true, clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' } }
      expect((await call(s.url, 'PUT', '/api/_/settings', token, { auth })).status).toBe(200)
      expect((await call(s.url, 'GET', '/api/auth/providers')).json.providers).toEqual(['password', 'google'])

      const challenge = createHash('sha256').update('v'.repeat(43)).digest('base64url')
      const start = await call(s.url, 'POST', '/api/auth/oauth/google/start', undefined, { challenge })
      expect(start.status).toBe(200)
      const u = new URL(start.json.url)
      expect(u.host).toBe('accounts.google.com')
      expect(u.searchParams.get('redirect_uri')).toBe(`${s.url}/api/auth/oauth/google/callback`)
      expect(u.searchParams.get('code_challenge')).toHaveLength(43)
      expect(u.searchParams.get('state')).toBeTruthy()

      // кривой state: браузер возвращается в приложение с ошибкой, не 500
      const back = await call(s.url, 'GET', '/api/auth/oauth/google/callback?state=bad&code=x')
      expect(back.status).toBe(302)
      // возврат идёт на адрес приложения из настроек, а не на случайный порт теста
      expect(back.location).toBe('http://127.0.0.1:8090/#mb_oauth_error=invalid_state')

      // выключили - кнопка пропала
      expect((await call(s.url, 'PUT', '/api/_/settings', token, { auth: { ...auth, google: { ...auth.google, enabled: false } } })).status).toBe(200)
      expect((await call(s.url, 'GET', '/api/auth/providers')).json.providers).toEqual(['password'])
    } finally {
      await s.stop()
    }
  }, 30_000)
})

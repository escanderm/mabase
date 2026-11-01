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

  test('212. /api/auth/providers: пароль по умолчанию, Google после включения, отказ провайдера', async () => {
    const s = await startServer({ dataDir: tmpDir('providers'), port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false } })
    try {
      expect((await call(s.url, 'GET', '/api/auth/providers')).json).toEqual({ providers: ['password'], signup: true })
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

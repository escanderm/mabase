// Тесты 208-210: файлы (S3) в настройках админки (design.md §11, §16, §17).
// Переключение хранилища без перезапуска, шифрование секрета, проверка
// соединения и отказ на неполных настройках.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { startServer, type ServerConfig } from '../src/server'
import { fakeS3, KEY, SECRET } from './fake-s3'
import { tmpDir } from './helpers'

const png = (n = 6) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: n }, (_, i) => i)])

async function world(opts: { cfg?: Partial<ServerConfig> } = {}) {
  const s = await startServer({
    dataDir: tmpDir('settings-s3'),
    port: 0,
    hostname: '127.0.0.1',
    env: {},
    onWarning: () => {},
    db: { fsync: false },
    collections: {
      docs: {
        schema: z.object({ title: z.string(), avatar: z.string().optional() }).passthrough(),
        files: { avatar: { accept: ['image/'] } },
        rules: { list: () => true, view: () => true, create: () => true },
      },
    },
    ...opts.cfg,
  })
  const r = await fetch(`${s.url}/api/_/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: s.setupUrl!.split('/setup/')[1]!, email: 'admin@example.test', password: 'admin-pass-12345' }),
  })
  const { token } = await r.json()
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${s.url}/api/_/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: (await res.json().catch(() => null)) as any }
  }
  const upload = async (title: string) => {
    const form = new FormData()
    form.append('title', JSON.stringify(title))
    form.append('avatar', new File([png() as unknown as BlobPart], 'a.png', { type: 'image/png' }))
    return (await fetch(`${s.url}/api/c/docs`, { method: 'POST', body: form })).json()
  }
  return { s, token, api, upload }
}

const s3cfg = (port: number, prefix = 'app') => ({ bucket: 'files', region: 'us-east-1', accessKeyId: KEY, secretAccessKey: SECRET, endpoint: `http://127.0.0.1:${port}`, prefix, forcePathStyle: true })

describe('файлы в настройках', () => {
  test('208. переключение на S3 без перезапуска, секрет замаскирован и сохраняется по «***»', async () => {
    const s3 = fakeS3({ accessKeyId: KEY, secretAccessKey: SECRET, region: 'us-east-1', bucket: 'files' })
    const { s, api, upload } = await world()
    try {
      // сначала локально
      const local = await upload('локально')
      expect(local.avatar).toBeString()
      expect(s3.objects.size).toBe(0)

      // включаем S3: файлы начинают идти в облако сразу
      const saved = await api('PUT', 'settings', { storage: { s3: s3cfg(s3.port) } })
      expect(saved.status).toBe(200)
      expect(saved.body.storage.s3.secretAccessKey).toBe('***')
      expect(saved.body.storage.s3.bucket).toBe('files')

      const cloud = await upload('в облако')
      expect(s3.objects.size).toBe(1)
      expect([...s3.objects.keys()][0]).toBe(`/files/app/docs/${cloud._id}/${cloud.avatar}-a.png`)
      const got = await fetch(`${s.url}/api/files/${cloud.avatar}`)
      expect(got.status).toBe(200)
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(png())

      // смена префикса с «***» вместо секрета: ключ не потерялся
      const again = await api('PUT', 'settings', { storage: { s3: { ...s3cfg(s3.port), prefix: 'app2', secretAccessKey: '***' } } })
      expect(again.status).toBe(200)
      const moved = await upload('после смены префикса')
      expect([...s3.objects.keys()].some((k) => k.startsWith(`/files/app2/docs/${moved._id}/`))).toBe(true)

      // обратно локально
      const off = await api('PUT', 'settings', { storage: {} })
      expect(off.status).toBe(200)
      const count = s3.objects.size
      const back = await upload('снова локально')
      expect(s3.objects.size).toBe(count)
      expect(s.db.peek('docs', back._id)!.avatar).toBe(back.avatar)
    } finally {
      await s.stop()
      s3.stop()
    }
  }, 40_000)

  test('209. неполные настройки S3 - 400 и старые продолжают работать; конфиг главнее админки', async () => {
    const s3 = fakeS3({ accessKeyId: KEY, secretAccessKey: SECRET, region: 'us-east-1', bucket: 'files' })
    const { s, api, upload } = await world()
    try {
      expect((await api('PUT', 'settings', { storage: { s3: s3cfg(s3.port) } })).status).toBe(200)
      const bad = await api('PUT', 'settings', { storage: { s3: { ...s3cfg(s3.port), secretAccessKey: '', bucket: '' } } })
      expect(bad.status).toBe(400)
      expect(bad.body.message).toMatch(/bucket|secretAccessKey/i)
      // старые настройки не сломались: файл всё ещё идёт в облако
      const doc = await upload('после отказа')
      expect([...s3.objects.keys()].some((k) => k.includes(doc.avatar))).toBe(true)
    } finally {
      await s.stop()
      s3.stop()
    }

    // конфиг задаёт S3 - админка менять не может
    const fixed = await world({ cfg: { storage: { s3: s3cfg(s3.port) } } })
    try {
      const view = await fixed.api('GET', 'settings')
      expect(view.body.fixed.storage).toBe(true)
      expect(view.body.storage.s3.bucket).toBe('files')
      expect(view.body.storage.s3.secretAccessKey).toBe('***')
      const res = await fixed.api('PUT', 'settings', { storage: {} })
      expect(res.status).toBe(409)
      expect(res.body.message).toMatch(/mabase\.config\.ts/)
    } finally {
      await fixed.s.stop()
      s3.stop()
    }
  }, 40_000)

  test('210. проверка хранилища: S3 отвечает, локальная папка пишется, кривой endpoint - ошибка', async () => {
    const s3 = fakeS3({ accessKeyId: KEY, secretAccessKey: SECRET, region: 'us-east-1', bucket: 'files' })
    const { s, api } = await world()
    try {
      const local = await api('POST', 'settings/storage/test')
      expect(local.status).toBe(200)
      expect(local.body).toMatchObject({ ok: true, kind: 'local' })

      expect((await api('PUT', 'settings', { storage: { s3: s3cfg(s3.port) } })).status).toBe(200)
      const cloud = await api('POST', 'settings/storage/test')
      expect(cloud.status).toBe(200)
      expect(cloud.body).toMatchObject({ ok: true, kind: 's3' })

      // порт, на котором никто не слушает: честная ошибка, а не «сохранено»
      expect((await api('PUT', 'settings', { storage: { s3: { ...s3cfg(s3.port), endpoint: 'http://127.0.0.1:1' } } })).status).toBe(200)
      const broken = await api('POST', 'settings/storage/test')
      expect(broken.status).toBe(400)
      expect(broken.body.message).toMatch(/хранилище не работает/)
    } finally {
      await s.stop()
      s3.stop()
    }
  }, 40_000)
})

// Тесты 204-205: файлы в админке (design.md §16). Админка видит файлы любой
// коллекции: загрузка в поле записи, скачивание с Range, удаление.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { startServer } from '../src/server'
import { tmpDir } from './helpers'

const png = (n = 8) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: n }, (_, i) => i)])

async function setup() {
  const s = await startServer({
    dataDir: tmpDir('admin-files'),
    port: 0,
    hostname: '127.0.0.1',
    env: {},
    onWarning: () => {},
    db: { fsync: false },
    collections: {
      docs: {
        schema: z.object({ title: z.string(), avatar: z.string().optional(), photos: z.array(z.string()).optional() }).passthrough(),
        files: { avatar: { accept: ['image/'] }, photos: { accept: ['image/'], many: true } },
      },
    },
  })
  const setupRes = await fetch(`${s.url}/api/_/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: s.setupUrl!.split('/setup/')[1]!, email: 'admin@example.test', password: 'admin-pass-12345' }),
  })
  const { token } = await setupRes.json()
  return { s, token }
}

const form = (bytes: Uint8Array) => {
  const f = new FormData()
  f.append('file', new File([bytes as unknown as BlobPart], 'a.png', { type: 'image/png' }))
  return f
}

describe('файлы в админке', () => {
  test('204. загрузка в поле, скачивание с Range, удаление файла и поля', async () => {
    const { s, token } = await setup()
    try {
      const doc = await s.db.c.docs!.insert({ title: 'с файлом' })
      const up = await fetch(`${s.url}/api/_/files/docs/${doc._id}/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form(png()) })
      expect(up.status).toBe(200)
      const created = await up.json()
      const fileId = created.values.avatar as string
      expect(typeof fileId).toBe('string')
      expect(s.db.peek('docs', doc._id)!.avatar).toBe(fileId)
      expect(await s.db.c._files!.count()).toBe(1)

      // скачивание: только superuser, Range работает
      expect((await fetch(`${s.url}/api/_/files/${fileId}`)).status).toBe(401)
      const full = await fetch(`${s.url}/api/_/files/${fileId}`, { headers: { Authorization: `Bearer ${token}` } })
      expect(full.status).toBe(200)
      expect(full.headers.get('content-type')).toBe('image/png')
      expect(new Uint8Array(await full.arrayBuffer())).toEqual(png())
      const part = await fetch(`${s.url}/api/_/files/${fileId}`, { headers: { Authorization: `Bearer ${token}`, Range: 'bytes=2-5' } })
      expect(part.status).toBe(206)
      expect(part.headers.get('content-range')).toBe('bytes 2-5/12')
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(png().slice(2, 6))

      // много: второй файл добавляется в массив
      const up2 = await fetch(`${s.url}/api/_/files/docs/${doc._id}/photos`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form(png(1)) })
      expect(up2.status).toBe(200)
      const photos = s.db.peek('docs', doc._id)!.photos as string[]
      expect(photos).toHaveLength(1)
      const up3 = await fetch(`${s.url}/api/_/files/docs/${doc._id}/photos`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form(png(2)) })
      expect(up3.status).toBe(200)
      expect((s.db.peek('docs', doc._id)!.photos as string[]).length).toBe(2)

      // удаление файла: убирает и из записи, и из _files, и байты
      const del = await fetch(`${s.url}/api/_/files/${fileId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      expect(del.status).toBe(204)
      expect(s.db.peek('docs', doc._id)!.avatar).toBeUndefined()
      expect(await s.db.c._files!.count()).toBe(2) // только photos
      expect((await fetch(`${s.url}/api/files/${fileId}`)).status).toBe(404)

      // поле не объявлено файлом - отказ
      const bad = await fetch(`${s.url}/api/_/files/docs/${doc._id}/title`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form(png()) })
      expect(bad.status).toBe(400)
    } finally {
      await s.stop()
    }
  }, 30_000)

  test('205. meta коллекции отдаёт объявленные поля-файлы', async () => {
    const { s, token } = await setup()
    try {
      const m = await (await fetch(`${s.url}/api/_/c/docs/meta`, { headers: { Authorization: `Bearer ${token}` } })).json()
      expect(m.files).toEqual({ avatar: { accept: ['image/'] }, photos: { accept: ['image/'], many: true } })
    } finally {
      await s.stop()
    }
  }, 20_000)
})

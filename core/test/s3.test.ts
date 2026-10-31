// Тесты 191-193: файлы в S3 (design.md §16). Облако не нужно: поднимаем
// S3-совместимый сервер на Bun.serve, который сам проверяет подпись AWS SigV4
// и хранит объекты в памяти. Тест проверяет не только «загрузилось», но и что
// подпись верна - иначе с настоящим S3 было бы 403.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { S3Storage } from '../src/files'
import { startServer } from '../src/server'
import { fakeS3, KEY, SECRET } from './fake-s3'
import { tmpDir, waitFor } from './helpers'

const png = (n = 8) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: n }, (_, i) => i)])

describe('файлы в S3', () => {
  test('191. загрузка/отдача/удаление через S3, подпись SigV4 верна', async () => {
    const s3 = fakeS3({ accessKeyId: KEY, secretAccessKey: SECRET, region: 'us-east-1', bucket: 'files' })
    const s = await startServer({
      dataDir: tmpDir('s3'),
      port: 0,
      hostname: '127.0.0.1',
      env: {},
      onWarning: () => {},
      db: { fsync: false },
      storage: { s3: { bucket: 'files', region: 'us-east-1', accessKeyId: KEY, secretAccessKey: SECRET, endpoint: `http://127.0.0.1:${s3.port}`, forcePathStyle: true, prefix: 'app' } },
      collections: {
        docs: {
          schema: z.object({ title: z.string(), avatar: z.string().optional() }).passthrough(),
          files: { avatar: { accept: ['image/'] } },
          rules: { list: () => true, view: () => true, create: () => true, update: () => true, delete: () => true },
        },
      },
    })
    try {
      const bytes = png()
      const form = new FormData()
      form.append('title', JSON.stringify('в облаке'))
      form.append('avatar', new File([bytes], 'a.png', { type: 'image/png' }))
      const created = await (await fetch(`${s.url}/api/c/docs`, { method: 'POST', body: form })).json()
      expect(typeof created.avatar).toBe('string')

      // объект ушёл в S3 под ключом prefix/collection/record/file
      const put = s3.calls.find((c) => c.method === 'PUT')
      expect(put).toBeDefined()
      expect(put!.signed).toBe(true)
      expect(put!.path).toBe(`/files/app/docs/${created._id}/${created.avatar}-a.png`)
      expect(s3.objects.get(put!.path)).toEqual(bytes)

      // отдача: сервер берёт байты из S3
      const got = await fetch(`${s.url}/api/files/${created.avatar}`)
      expect(got.status).toBe(200)
      expect(got.headers.get('content-type')).toBe('image/png')
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes)

      // удаление записи: S3 получает DELETE, метаданные убраны
      expect((await fetch(`${s.url}/api/c/docs/${created._id}`, { method: 'DELETE' })).status).toBe(204)
      await waitFor(() => s3.calls.some((c) => c.method === 'DELETE'), 3000)
      expect(s3.calls.find((c) => c.method === 'DELETE')!.signed).toBe(true)
      await waitFor(async () => (await s.db.c._files!.count()) === 0, 2000)
      expect((await fetch(`${s.url}/api/files/${created.avatar}`)).status).toBe(404)
    } finally {
      await s.stop()
      s3.stop()
    }
  }, 30_000)

  test('192. настройки S3 проверяются при старте; без них - локальная папка', async () => {
    expect(() => new S3Storage({ bucket: '', region: 'us-east-1', accessKeyId: KEY, secretAccessKey: SECRET })).toThrow(/bucket/)
    expect(() => new S3Storage({ bucket: 'b', region: 'us-east-1', accessKeyId: '', secretAccessKey: '' })).toThrow(/accessKeyId, secretAccessKey/)

    // без storage сервер стартует и пишет файлы локально, как раньше
    const s = await startServer({ dataDir: tmpDir('s3-local'), port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false } })
    try {
      expect(s.url).toStartWith('http://127.0.0.1')
    } finally {
      await s.stop()
    }
  })

  test('193. ключи объектов: префикс, коллекция, запись, id и безопасное имя', () => {
    const s3 = new S3Storage({ bucket: 'b', region: 'ru-central1', accessKeyId: KEY, secretAccessKey: SECRET, prefix: '/uploads/' })
    const meta = { _id: 'f1', collection: 'docs', recordId: 'r1', field: 'avatar', name: 'фото 1.png', size: 1, mime: 'image/png', createdAt: 0 }
    expect(s3.key(meta)).toBe('uploads/docs/r1/f1-фото_1.png')
    const plain = new S3Storage({ bucket: 'b', region: 'ru-central1', accessKeyId: KEY, secretAccessKey: SECRET })
    expect(plain.key(meta)).toBe('docs/r1/f1-фото_1.png')

    // умолчание: IP/localhost - path-style (MinIO), домен - virtual-host (облака);
    // Beget на path-style + ru1 рвёт соединение, поэтому это важно
    const minio = new S3Storage({ bucket: 'b', region: 'ru1', accessKeyId: KEY, secretAccessKey: SECRET, endpoint: 'http://127.0.0.1:9000' })
    expect(minio.pathStyle).toBe(true)
    const cloud = new S3Storage({ bucket: 'b', region: 'ru1', accessKeyId: KEY, secretAccessKey: SECRET, endpoint: 'https://s3.ru1.storage.beget.cloud' })
    expect(cloud.pathStyle).toBe(false)
    expect(new S3Storage({ bucket: 'b', region: 'ru1', accessKeyId: KEY, secretAccessKey: SECRET, endpoint: 'https://s3.example.test', forcePathStyle: true }).pathStyle).toBe(true)
  })
})

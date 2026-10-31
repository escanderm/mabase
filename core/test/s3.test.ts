// Тесты 191-193: файлы в S3 (design.md §16). Облако не нужно: поднимаем
// S3-совместимый сервер на Bun.serve, который сам проверяет подпись AWS SigV4
// и хранит объекты в памяти. Тест проверяет не только «загрузилось», но и что
// подпись верна - иначе с настоящим S3 было бы 403.
import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'
import { S3Storage } from '../src/files'
import { startServer } from '../src/server'
import { tmpDir, waitFor } from './helpers'

const png = (n = 8) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: n }, (_, i) => i)])
const hex = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex')
const hmac = (key: string | Buffer, d: string) => createHmac('sha256', key).update(d).digest()
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

type Call = { method: string; path: string; signed: boolean; payloadHash: string }

// S3 на память: понимает PUT/GET/DELETE объекта, проверяет SigV4.
function fakeS3(cfg: { accessKeyId: string; secretAccessKey: string; region: string; bucket: string }) {
  const objects = new Map<string, Uint8Array>()
  const calls: Call[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const body = new Uint8Array(await req.arrayBuffer())
      const payloadHash = req.headers.get('x-amz-content-sha256') ?? ''
      const signed = verify(req, url, cfg)
      calls.push({ method: req.method, path: url.pathname, signed, payloadHash })
      if (!signed) return new Response('SignatureDoesNotMatch', { status: 403 })
      if (req.method === 'PUT') {
        objects.set(url.pathname, body)
        return new Response(null, { status: 200 })
      }
      if (req.method === 'DELETE') {
        objects.delete(url.pathname)
        return new Response(null, { status: 204 })
      }
      const obj = objects.get(url.pathname)
      return obj ? new Response(obj) : new Response('NoSuchKey', { status: 404 })
    },
  })
  return { port: server.port, objects, calls, stop: () => server.stop(true) }
}

function verify(req: Request, url: URL, cfg: { accessKeyId: string; secretAccessKey: string; region: string }): boolean {
  const auth = req.headers.get('authorization') ?? ''
  const amzDate = req.headers.get('x-amz-date') ?? ''
  const host = req.headers.get('host') ?? ''
  const payloadHash = req.headers.get('x-amz-content-sha256') ?? ''
  const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]
  const given = /Signature=([0-9a-f]+)/.exec(auth)?.[1]
  const scope = /Credential=([^,]+)/.exec(auth)?.[1]?.split('/').slice(1).join('/')
  if (!signed || !given || !scope || !amzDate) return false
  if (!auth.includes(`Credential=${cfg.accessKeyId}/`)) return false
  const date = amzDate.slice(0, 8)
  if (scope !== `${date}/${cfg.region}/s3/aws4_request`) return false
  const canonicalHeaders = signed
    .split(';')
    .map((k) => `${k}:${req.headers.get(k) ?? ''}\n`)
    .join('')
  const canonicalRequest = `${req.method}\n${url.pathname.split('/').map(enc).join('/')}\n\n${canonicalHeaders}\n${signed}\n${payloadHash}`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(canonicalRequest)}`
  const key = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, date), cfg.region), 's3'), 'aws4_request')
  return createHmac('sha256', key).update(stringToSign).digest('hex') === given
}

const KEY = 'AKIDEXAMPLE'
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'

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
  })
})

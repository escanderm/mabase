// Тесты 166-175: файлы (design.md §16). Загрузка в той же записи, метаданные в
// _files, отдача через правило view, лимиты, замена и удаление, SDK.
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Access } from '../src/access'
import { Auth } from '../src/auth'
import { createClient } from '../src/client'
import { openDb } from '../src/db'
import { attachFileCleanup, FILES, FileStore, LocalStorage } from '../src/files'
import { createHandler } from '../src/http'
import { Mailer } from '../src/mail'
import { startServer } from '../src/server'
import { sleep, tmpDir, waitFor } from './helpers'

const SECRET = 'files-secret-'.padEnd(48, 'x')
const png = (n = 8) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: n }, (_, i) => i)])

async function setup(opts: { rules?: Record<string, unknown>; maxUploadBytes?: number; fieldMax?: number } = {}) {
  const dir = tmpDir('files')
  const db = await openDb({ dir, fsync: false, compactMinBytes: 0 })
  db.collection('docs', { schema: z.object({ title: z.string(), avatar: z.string().optional(), photos: z.array(z.string()).optional() }).passthrough() })
  db.collection(FILES, { indexes: ['recordId'] })
  const files = new FileStore(new LocalStorage(join(dir, 'files')), opts.maxUploadBytes ?? 1 << 20)
  const defs = {
    docs: {
      files: { avatar: { accept: ['image/'], maxBytes: opts.fieldMax ?? 100_000 }, photos: { many: true } },
      rules: { list: () => true, view: () => true, create: () => true, update: () => true, delete: () => true, ...opts.rules },
    },
  }
  const access = new Access(db, defs as any, {}, { files })
  attachFileCleanup({ db, files, defs: (c) => (defs as any)[c]?.files, onError: () => {} })
  const auth = new Auth(access, { secret: SECRET, mail: new Mailer({ onDevMail: () => {} }) })
  const h = createHandler({ access, auth, maxUploadBytes: opts.maxUploadBytes ?? 1 << 20 })
  const call = (method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) =>
    h(new Request(`http://localhost${path}`, { method, headers, body }), { ip: '127.0.0.1' })

  // Загрузить запись с файлами: поля - JSON-строками, файлы - частями формы.
  const post = async (fields: Record<string, unknown>, uploads: Record<string, File | File[]>) => {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, JSON.stringify(v))
    for (const [k, v] of Object.entries(uploads)) for (const f of Array.isArray(v) ? v : [v]) form.append(k, f, f.name)
    const res = await call('POST', '/api/c/docs', form)
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  return { db, files, access, auth, h, call, post, dir }
}

const fileOf = (bytes: Uint8Array, name = 'a.png', type = 'image/png') => new File([bytes], name, { type })

describe('файлы', () => {
  test('166. загрузка в записи: id в документе, метаданные в _files, байты на диске', async () => {
    const { db, post, call, dir } = await setup()
    const bytes = png()
    const r = await post({ title: 'с аватаром' }, { avatar: fileOf(bytes) })
    expect(r.status).toBe(200)
    expect(typeof r.body.avatar).toBe('string')

    const meta = await db.c[FILES]!.findOne({ _id: r.body.avatar })
    expect(meta).toMatchObject({ collection: 'docs', recordId: r.body._id, field: 'avatar', name: 'a.png', mime: 'image/png', size: bytes.byteLength })
    expect(existsSync(join(dir, 'files', 'docs', r.body._id, `${r.body.avatar}-a.png`))).toBe(true)

    const res = await call('GET', `/api/files/${r.body.avatar}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    expect(res.headers.get('content-disposition')).toContain('inline')
    expect((await call('GET', `/api/files/${r.body.avatar}?download=1`)).headers.get('content-disposition')).toContain('attachment')
    await db.close()
  })

  test('167. массив файлов (many) и отдача каждого', async () => {
    const { db, post, call } = await setup()
    const r = await post({ title: 'галерея' }, { photos: [fileOf(png(1), '1.png'), fileOf(png(2), '2.png')] })
    expect(r.status).toBe(200)
    expect(r.body.photos).toHaveLength(2)
    for (const id of r.body.photos) expect((await call('GET', `/api/files/${id}`)).status).toBe(200)
    await db.close()
  })

  test('168. лимиты: размер (413), тип (400), больше одного файла в одно поле (400)', async () => {
    const small = await setup({ maxUploadBytes: 4 })
    expect((await small.post({ title: 'большой' }, { avatar: fileOf(png(100)) })).status).toBe(413)
    expect(await small.db.c.docs!.find()).toEqual([]) // ничего не сохранилось
    await small.db.close()

    const big = await setup({ fieldMax: 100_000 })
    expect((await big.post({ title: 'тип' }, { avatar: fileOf(png(), 'a.txt', 'text/plain') })).status).toBe(400)
    expect((await big.post({ title: 'два' }, { avatar: [fileOf(png()), fileOf(png())] })).status).toBe(400)
    expect(await big.db.c.docs!.find()).toEqual([])
    await big.db.close()
  })

  test('169. значение поля-файла нельзя задать напрямую - только загрузкой', async () => {
    const { db, call } = await setup()
    const body = new FormData()
    body.append('title', JSON.stringify('чужой id'))
    body.append('avatar', JSON.stringify('01ZZZZZZZZZZZZZZZZZZZZZZZZ'))
    const res = await call('POST', '/api/c/docs', body)
    expect(res.status).toBe(400)
    expect(await db.c.docs!.find()).toEqual([])
    await db.close()
  })

  test('170. правило view родительской записи решает, видно ли файл', async () => {
    const { db, post, access } = await setup({ rules: { list: (u: any) => !!u, view: (u: any) => !!u } })
    const r = await post({ title: 'закрытый' }, { avatar: fileOf(png()) })
    expect(r.status).toBe(200)
    // гость - 404, вошедший - читает
    expect(await access.forUser(null).file(r.body.avatar).catch((e) => e.code)).toBe('not_found')
    const got = await access.forUser({ id: 'u1' }).file(r.body.avatar)
    expect(got.meta._id).toBe(r.body.avatar)
    await db.close()
  })

  test('171. замена файла удаляет старый: метаданные, байты и отдача', async () => {
    const { db, post, call, dir } = await setup()
    const first = await post({ title: 'версия 1' }, { avatar: fileOf(png()) })
    const form = new FormData()
    form.append('$set', JSON.stringify({ avatar: '' })) // значение заменит загрузка
    form.append('avatar', fileOf(png(3), 'b.png'))
    const res = await call('PATCH', `/api/c/docs/${first.body._id}`, form)
    expect(res.status).toBe(200)
    const updated = await res.json()
    expect(updated.avatar).not.toBe(first.body.avatar)

    await waitFor(async () => !(await db.c[FILES]!.findOne({ _id: first.body.avatar })), 2000)
    expect((await call('GET', `/api/files/${first.body.avatar}`)).status).toBe(404)
    expect((await call('GET', `/api/files/${updated.avatar}`)).status).toBe(200)
    expect(existsSync(join(dir, 'files', 'docs', first.body._id, `${first.body.avatar}-a.png`))).toBe(false)
    await db.close()
  })

  test('172. удалили запись - файлы и метаданные убраны', async () => {
    const { db, post, call, dir } = await setup()
    const r = await post({ title: 'удалю' }, { avatar: fileOf(png()) })
    expect((await call('DELETE', `/api/c/docs/${r.body._id}`)).status).toBe(204)
    await waitFor(async () => (await db.c[FILES]!.count()) === 0, 2000)
    expect((await call('GET', `/api/files/${r.body.avatar}`)).status).toBe(404)
    expect(existsSync(join(dir, 'files', 'docs', r.body._id))).toBe(false)
    await db.close()
  })

  test('173. файлы переживают перезапуск: метаданные в базе, байты на диске', async () => {
    const { db, post, dir, files, access, auth } = await setup()
    const r = await post({ title: 'навсегда' }, { avatar: fileOf(png()) })
    await db.close()

    const db2 = await openDb({ dir, fsync: false, compactMinBytes: 0 })
    const meta = await db2.c[FILES]!.findOne({ _id: r.body.avatar })
    expect(meta).toMatchObject({ recordId: r.body._id, name: 'a.png' })
    expect(new Uint8Array(await files.read(meta as any))).toEqual(png())
    await db2.close()
    void access
    void auth
  })

  test('174. не объявленное поле-файл и пустая загрузка - 400', async () => {
    const { db, call } = await setup()
    const form = new FormData()
    form.append('title', JSON.stringify('x'))
    form.append('nope', fileOf(png()))
    expect((await call('POST', '/api/c/docs', form)).status).toBe(400)

    const empty = new FormData()
    empty.append('title', JSON.stringify('x'))
    empty.append('avatar', '') // текстовое поле вместо файла: id напрямую
    expect((await call('POST', '/api/c/docs', empty)).status).toBe(400)
    await db.close()
  })

  test('175. SDK: insert/update с files и fileUrl', async () => {
    const s = await startServer({
      dataDir: tmpDir('files-sdk'),
      port: 0,
      hostname: '127.0.0.1',
      env: {},
      onWarning: () => {},
      db: { fsync: false },
      collections: {
        docs: {
          schema: z.object({ title: z.string(), avatar: z.string().optional() }).passthrough(),
          files: { avatar: { accept: ['image/'] } },
          rules: { list: () => true, view: () => true, create: () => true, update: () => true },
        },
      },
    })
    try {
      const mb = createClient(s.url, { storage: memory(), sessionStorage: memory() })
      const bytes = png()
      const doc = await mb.c.docs!.insert({ title: 'из SDK' }, { files: { avatar: fileOf(bytes) } })
      expect(typeof doc.avatar).toBe('string')
      const res = await fetch(mb.fileUrl(doc.avatar))
      expect(res.status).toBe(200)
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)

      // замена через PATCH в одном запросе с $set
      const other = new File([png(5)], 'b.png', { type: 'image/png' })
      const updated = await mb.c.docs!.update(doc._id, { $set: { title: 'из SDK 2' } }, { files: { avatar: other } })
      expect(updated.title).toBe('из SDK 2')
      expect(updated.avatar).not.toBe(doc.avatar)
      expect((await fetch(mb.fileUrl(updated.avatar))).status).toBe(200)
      await waitFor(async () => (await fetch(mb.fileUrl(doc.avatar))).status === 404, 2000)
      mb.close()
    } finally {
      await s.stop()
    }
  })
})

function memory() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

void sleep

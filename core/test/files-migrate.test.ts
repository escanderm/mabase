// Тесты 199-201: перенос файлов между хранилищами (design.md §16).
// 199 - локально -> S3: копирование, идемпотентность, --dry-run, отдача из S3;
// 200 - S3 -> локально; 201 - команда mabase files migrate в CLI.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { LocalStorage, S3Storage, migrateFiles, type S3Options } from '../src/files'
import { startServer, type ServerConfig } from '../src/server'
import { fakeS3, KEY, SECRET } from './fake-s3'
import { tmpDir } from './helpers'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const png = (n = 8) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: n }, (_, i) => i)])

const CLIENT_OPTIONS = { storage: memory(), sessionStorage: memory() }
function memory() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

const docs = {
  schema: z.object({ title: z.string(), avatar: z.string().optional() }).passthrough(),
  files: { avatar: { accept: ['image/'] } },
  rules: { list: () => true, view: () => true, create: () => true, update: () => true, delete: () => true },
}

function config(dataDir: string, s3?: S3Options): ServerConfig {
  return { dataDir, port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false }, collections: { docs }, ...(s3 ? { storage: { s3 } } : {}) }
}

async function upload(base: string, title: string, bytes: Uint8Array): Promise<{ _id: string; avatar: string }> {
  const form = new FormData()
  form.append('title', JSON.stringify(title))
  form.append('avatar', new File([bytes as unknown as BlobPart], 'a.png', { type: 'image/png' }))
  const res = await fetch(`${base}/api/c/docs`, { method: 'POST', body: form })
  expect(res.status).toBe(200)
  return res.json()
}

const s3For = (port: number, prefix = 'app'): S3Options => ({
  bucket: 'files',
  region: 'us-east-1',
  accessKeyId: KEY,
  secretAccessKey: SECRET,
  endpoint: `http://127.0.0.1:${port}`,
  forcePathStyle: true,
  prefix,
})

describe('перенос файлов', () => {
  test('199. локально -> S3: копирует, второй раз пропускает, dry-run не копирует, отдача из S3', async () => {
    const dir = tmpDir('mig-s3')
    const s3 = fakeS3({ accessKeyId: KEY, secretAccessKey: SECRET, region: 'us-east-1', bucket: 'files' })
    const s = await startServer(config(dir))
    try {
      const a = await upload(s.url, 'раз', png(1))
      const b = await upload(s.url, 'два', png(2))
      const local = new LocalStorage(join(dir, 'files'))
      const target = new S3Storage(s3For(s3.port))

      const first = await migrateFiles(s.db, local, target)
      expect(first).toMatchObject({ total: 2, copied: 2, skipped: 0, failed: [] })
      expect(s3.objects.size).toBe(2)
      expect([...s3.objects.keys()].sort()).toEqual([`/files/app/docs/${a._id}/${a.avatar}-a.png`, `/files/app/docs/${b._id}/${b.avatar}-a.png`].sort())

      // идемпотентность: второй прогон ничего не копирует
      const second = await migrateFiles(s.db, local, target)
      expect(second).toMatchObject({ total: 2, copied: 0, skipped: 2 })

      // dry-run: считает, но не копирует
      const dry = await migrateFiles(s.db, local, new S3Storage(s3For(s3.port, 'other')), { dryRun: true })
      expect(dry).toMatchObject({ total: 2, copied: 2, skipped: 0 })
      expect([...s3.objects.keys()].some((k) => k.includes('/other/'))).toBe(false)
    } finally {
      await s.stop()
    }

    // после переключения на S3 те же файлы отдаются из облака
    const s3srv = await startServer(config(dir, s3For(s3.port)))
    try {
      const a = await s3srv.db.c.docs!.findOne({ title: 'раз' })
      const res = await fetch(`${s3srv.url}/api/files/${a!.avatar}`)
      expect(res.status).toBe(200)
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(png(1))
    } finally {
      await s3srv.stop()
      s3.stop()
    }
  }, 40_000)

  test('200. S3 -> локально: файлы появляются на диске и отдаются локальным сервером', async () => {
    const dir = tmpDir('mig-local')
    const s3 = fakeS3({ accessKeyId: KEY, secretAccessKey: SECRET, region: 'us-east-1', bucket: 'files' })
    const s = await startServer(config(dir, s3For(s3.port)))
    try {
      const a = await upload(s.url, 'в облаке', png(3))
      const local = new LocalStorage(join(dir, 'files'))
      const from = new S3Storage(s3For(s3.port))
      const r = await migrateFiles(s.db, from, local)
      expect(r).toMatchObject({ total: 1, copied: 1, skipped: 0 })
      const meta = await s.db.c._files!.findOne({ _id: a.avatar })
      expect(existsSync(local.pathFor(meta as any))).toBe(true)
      expect(new Uint8Array(await local.get(meta as any))).toEqual(png(3))
    } finally {
      await s.stop()
    }

    const localSrv = await startServer(config(dir))
    try {
      const a = await localSrv.db.c.docs!.findOne({ title: 'в облаке' })
      const res = await fetch(`${localSrv.url}/api/files/${a!.avatar}`)
      expect(res.status).toBe(200)
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(png(3))
    } finally {
      await localSrv.stop()
      s3.stop()
    }
  }, 40_000)

  test('201. CLI: mabase files migrate --from local --to s3', async () => {
    const s3 = fakeS3({ accessKeyId: KEY, secretAccessKey: SECRET, region: 'us-east-1', bucket: 'files' })
    const root = tmpDir('mig-cli')
    writeFileSync(
      join(root, 'mabase.config.ts'),
      `import { defineCollection, defineConfig, z } from 'mabase'
const docs = defineCollection('docs', {
  schema: z.object({ title: z.string(), avatar: z.string().optional() }).passthrough(),
  files: { avatar: { accept: ['image/'] } },
  rules: { list: () => true, view: () => true, create: () => true },
})
export default defineConfig({ collections: [docs] })`,
    )
    mkdirSync(join(root, 'mb_hooks'), { recursive: true })

    // гототовим локальную базу с одним файлом (сервер в этом же процессе, данные - в root/mb_data)
    const s = await startServer({ dataDir: join(root, 'mb_data'), port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false }, collections: { docs } })
    const created = await upload(s.url, 'через CLI', png(4))
    await s.stop()

    const env = {
      ...process.env,
      MABASE_S3_BUCKET: 'files',
      MABASE_S3_REGION: 'us-east-1',
      MABASE_S3_ACCESS_KEY_ID: KEY,
      MABASE_S3_SECRET_ACCESS_KEY: SECRET,
      MABASE_S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
      MABASE_S3_PATH_STYLE: '1',
      MABASE_S3_PREFIX: 'app',
    }
    const run = async (...args: string[]) => {
      const p = Bun.spawn(['bun', CLI, ...args, '--root', root], { stdout: 'pipe', stderr: 'pipe', env })
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      return { code: await p.exited, out: out + err }
    }

    const dry = await run('files', 'migrate', '--from', 'local', '--to', 's3', '--dry-run')
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('нужно перенести 1')
    expect(s3.objects.size).toBe(0) // dry-run ничего не скопировал

    const real = await run('files', 'migrate', '--from', 'local', '--to', 's3')
    expect(real.code).toBe(0)
    expect(real.out).toContain('перенесено 1')
    expect(real.out).toContain('Источник не удалён')
    expect(s3.objects.size).toBe(1)
    expect([...s3.objects.keys()][0]).toContain(`/app/docs/${created._id}/`)

    const again = await run('files', 'migrate', '--from', 'local', '--to', 's3')
    expect(again.out).toContain('перенесено 0')
    expect(again.out).toContain('уже было 1')
    s3.stop()
  }, 60_000)
})

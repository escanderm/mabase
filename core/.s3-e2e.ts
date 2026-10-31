// Живой прогон на Beget S3 собранным бинарником. Env задаём явно, без утечки
// S3-переменных в «локальный» сервер.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { S3Storage } from './src/files'

const e = process.env
const S3 = { bucket: e.MABASE_S3_BUCKET!, region: 'ru1', accessKeyId: e.MABASE_S3_ACCESS_KEY_ID!, secretAccessKey: e.MABASE_S3_SECRET_ACCESS_KEY!, endpoint: e.MABASE_S3_ENDPOINT!, prefix: 'mabase-test/live', forcePathStyle: false }
const s3 = new S3Storage(S3)
const bin = join(import.meta.dir, 'dist', 'mabase')
const cleanEnv = (() => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('MABASE_S3_')) delete env[k]
  return env
})()
const s3Env = {
  ...cleanEnv,
  MABASE_S3_BUCKET: S3.bucket, MABASE_S3_REGION: S3.region, MABASE_S3_ACCESS_KEY_ID: S3.accessKeyId,
  MABASE_S3_SECRET_ACCESS_KEY: S3.secretAccessKey, MABASE_S3_ENDPOINT: S3.endpoint, MABASE_S3_PREFIX: S3.prefix, MABASE_S3_PATH_STYLE: '0',
}
const dir = mkdtempSync(join(tmpdir(), 'mb-s3-e2e2-'))
mkdirSync(join(dir, 'mb_hooks'), { recursive: true })
writeFileSync(join(dir, 'mabase.config.ts'), `import { defineCollection, defineConfig, z } from 'mabase'
const docs = defineCollection('docs', {
  schema: z.object({ title: z.string(), avatar: z.string().optional() }).passthrough(),
  files: { avatar: { accept: ['image/'] } },
  rules: { list: () => true, view: () => true, create: () => true, delete: () => true },
})
export default defineConfig({ collections: [docs] })`)
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: n }, (_, i) => i)])
const log = (...a: any[]) => console.log(...a)

async function start(env: Record<string, string | undefined>) {
  const proc = Bun.spawn([bin, 'serve', '--port', '18521', '--host', '127.0.0.1'], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' })
  const errs: string[] = []
  void (async () => { for await (const c of proc.stderr as any) errs.push(new TextDecoder().decode(c)) })()
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch('http://127.0.0.1:18521/api/health')).ok) return { proc, errs } } catch {}
    await Bun.sleep(100)
  }
  throw new Error('сервер не поднялся: ' + errs.join(''))
}
async function upload(title: string, bytes: Uint8Array) {
  const form = new FormData()
  form.append('title', JSON.stringify(title))
  form.append('avatar', new File([bytes as unknown as BlobPart], 'a.png', { type: 'image/png' }))
  const r = await fetch('http://127.0.0.1:18521/api/c/docs', { method: 'POST', body: form })
  const text = await r.text()
  if (!r.ok) throw new Error(`upload ${r.status}: ${text}`)
  return JSON.parse(text)
}
async function cli(args: string[], env: Record<string, string | undefined>) {
  const p = Bun.spawn([bin, ...args], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, text: (out + err).trim() }
}
const bytesOf = async (id: string, docId: string) => ({ _id: id, collection: 'docs', recordId: docId, field: 'avatar', name: 'a.png', size: 0, mime: 'image/png', createdAt: 0 })
const result: any = {}

// 1. локально
let srv = await start(cleanEnv)
const a = await upload('локально', png(4))
const onDisk = join(dir, 'mb_data', 'files', 'docs', a._id, `${a.avatar}-a.png`)
result.step1 = { uploaded: existsSync(onDisk), file: a.avatar }
srv.proc.kill(); await Bun.sleep(400)

// 2. local -> S3
const m1 = await cli(['files', 'migrate', '--from', 'local', '--to', 's3'], s3Env)
result.step2 = { code: m1.code, line: m1.text.split('\n').filter((l) => /Готово|Подпись|ошибка/.test(l)).join(' | ') }
result.objectA = await s3.head(await bytesOf(a.avatar, a._id))

// 3. сервер на S3: отдача и Range
srv = await start(s3Env)
const full = await fetch(`http://127.0.0.1:18521/api/files/${a.avatar}`)
const fullBytes = new Uint8Array(await full.arrayBuffer())
const part = await fetch(`http://127.0.0.1:18521/api/files/${a.avatar}`, { headers: { Range: 'bytes=1-3' } })
const partBytes = new Uint8Array(await part.arrayBuffer())
result.step3 = { status: full.status, bytesOk: fullBytes.length === png(4).length, rangeStatus: part.status, contentRange: part.headers.get('content-range'), partOk: [...partBytes].join(',') === [png(4)[1], png(4)[2], png(4)[3]].join(',') }
if (full.status !== 200) result.step3.err = srv.errs.join('').slice(-300)

// 4. загрузка сразу в облако
const b = await upload('сразу в облако', png(9))
result.step4 = { file: b.avatar, inS3: await s3.head(await bytesOf(b.avatar, b._id)) }
srv.proc.kill(); await Bun.sleep(400)

// 5. S3 -> local
const m2 = await cli(['files', 'migrate', '--from', 's3', '--to', 'local'], s3Env)
result.step5 = { code: m2.code, line: m2.text.split('\n').filter((l) => /Готово|ошибка/.test(l)).join(' | ') }
srv = await start(cleanEnv)
const back = await fetch(`http://127.0.0.1:18521/api/files/${b.avatar}`)
const backBytes = new Uint8Array(await back.arrayBuffer())
result.step6 = { status: back.status, bytesOk: backBytes.length === png(9).length && backBytes.every((x, i) => x === png(9)[i]) }
srv.proc.kill()

// 6. уборка
await s3.delete(await bytesOf(a.avatar, a._id))
await s3.delete(await bytesOf(b.avatar, b._id))
result.cleaned = !(await s3.head(await bytesOf(a.avatar, a._id))) && !(await s3.head(await bytesOf(b.avatar, b._id)))
log(JSON.stringify(result, null, 2))
process.exit(0)

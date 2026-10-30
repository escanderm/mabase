// CLI и загрузка проекта (design.md §5, §15): mabase.config.ts, mb_hooks, seed,
// serve, backup, import. Сервер - отдельный процесс, как у пользователя.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from '../src/cli'
import { openDb } from '../src/db'
import { tmpDir, waitFor } from './helpers'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

const CONFIG = `
import { ActionError, defineAction, defineCollection, defineConfig, mail, z, type Db } from 'mabase'

const notes = defineCollection('notes', {
  schema: z.object({ text: z.string().min(1), ownerId: z.string() }),
  indexes: ['ownerId'],
  owner: 'ownerId',
  fields: { readonly: ['ownerId'] },
  rules: { list: (u) => (u ? { ownerId: u.id } : false), create: (u) => !!u },
  hooks: { beforeCreate: ({ doc, user }) => ({ ...doc, ownerId: user?.id ?? doc.ownerId }) },
})

const users = defineCollection('users', { schema: z.object({ name: z.string() }) })

const ping = defineAction('ping', {
  input: z.object({ to: z.string() }),
  handler: async ({ input }) => {
    await mail.send({ to: input.to, subject: 'пинг', text: 'понг' })
    return 'ok'
  },
})

export default defineConfig({ collections: [users, notes], actions: [ping] })
`

const SEED = `
import { defineSeed } from 'mabase'
export default defineSeed(async ({ db, auth }) => {
  const a = await auth.upsertUser({ email: 'alice@example.test', password: 'dev-alice-1', name: 'Алиса' })
  await db.notes.upsert({ _id: 'n1' }, { text: 'из сида', ownerId: a._id })
})
`

function project(files: Record<string, string> = {}): string {
  const root = tmpDir('cli')
  const all = { 'mabase.config.ts': CONFIG, 'seed.ts': SEED, 'mb_hooks/events.ts': "import { on } from 'mabase'\non('note.big', () => {})\n", ...files }
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  return root
}

async function cli(root: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(['bun', CLI, ...args, '--root', root], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: out + err }
}

// serve в фоне: ждём строку с адресом.
async function serve(root: string) {
  const p = Bun.spawn(['bun', CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--root', root], { stdout: 'pipe', stderr: 'pipe' })
  let log = ''
  const read = async (s: ReadableStream<Uint8Array>) => {
    for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) log += new TextDecoder().decode(chunk)
  }
  void read(p.stdout)
  void read(p.stderr)
  await waitFor(() => /MaBase [\d.]+: (http\S+)/.test(log) || p.exitCode !== null, 15_000)
  const url = /MaBase [\d.]+: (http\S+)/.exec(log)?.[1]
  if (!url) throw new Error(`сервер не запустился:\n${log}`)
  return { p, url, log: () => log }
}

const post = (url: string, body: unknown, token?: string) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) })

describe('CLI', () => {
  test('87. seed и serve: конфиг и хуки из папки проекта, правила, mail из действия, backup и import через работающий сервер', async () => {
    const root = project()
    expect(await cli(root, 'seed')).toMatchObject({ code: 0, out: expect.stringContaining('Сид выполнен') })
    const s = await serve(root)
    try {
      expect(s.log()).toContain('хуки: events.ts')
      expect(s.log()).toContain('обработчики событий: note.big')
      const login = await (await post(`${s.url}/api/auth/login`, { email: 'alice@example.test', password: 'dev-alice-1' })).json()
      expect(login.user.name).toBe('Алиса')
      const notes = await (await fetch(`${s.url}/api/c/notes`, { headers: { Authorization: `Bearer ${login.accessToken}` } })).json()
      expect(notes.items.map((n: any) => n.text)).toEqual(['из сида'])
      expect((await fetch(`${s.url}/api/c/notes`)).status).toBe(401)
      // users расширена своей схемой: без name - 400
      expect((await post(`${s.url}/api/auth/register`, { email: 'b@example.test', password: 'bob-pass-1' })).status).toBe(400)

      // import { mail } from 'mabase' работает в действии (режим разработки - в консоль)
      expect(await (await post(`${s.url}/api/actions/ping`, { to: 'x@example.test' }, login.accessToken)).json()).toBe('ok')
      await waitFor(() => s.log().includes('тема: пинг'))

      // сид пишет в базу напрямую - пока сервер работает, нельзя
      const seed = await cli(root, 'seed')
      expect(seed.code).toBe(1)
      expect(seed.out).toContain('остановите сервер')

      // backup и import идут через admin работающего сервера
      const b = await cli(root, 'backup', 'bk1')
      expect(b).toMatchObject({ code: 0, out: expect.stringContaining('Бэкап на tx') })
      writeFileSync(join(root, 'n.ndjson'), '{"_id":"n2","text":"импорт","ownerId":"u"}\n')
      expect((await cli(root, 'import', 'notes', 'n.ndjson')).out).toContain('добавлено 1, пропущено 0')
      expect((await cli(root, 'import', 'notes', 'n.ndjson')).out).toContain('добавлено 0, пропущено 1')
    } finally {
      s.p.kill('SIGTERM')
      expect(await s.p.exited).toBe(0)
    }
    expect(existsSync(join(root, 'mb_data', 'admin.json'))).toBe(false) // остановка убирает адрес admin

    // сервер остановлен: backup и import открывают базу сами
    expect((await cli(root, 'backup', 'bk2')).code).toBe(0)
    writeFileSync(join(root, 'm.ndjson'), '{"_id":"n3","text":"без сервера","ownerId":"u"}\n{"_id":"n4","text":"","ownerId":"u"}\n')
    const bad = await cli(root, 'import', 'notes', 'm.ndjson')
    expect(bad.code).toBe(1) // схема из конфига работает и без сервера: пустой text
    const bk = await openDb({ dir: join(root, 'bk2'), fsync: false })
    expect(bk.peek('notes', 'n2')).toMatchObject({ text: 'импорт' }) // бэкап без сервера - с данными
    await bk.close()
    const db = await openDb({ dir: join(root, 'mb_data', 'db'), fsync: false })
    expect(db.peek('notes', 'n3')).toBeNull() // пачка с ошибкой отменена целиком
    await db.close()
  }, 60_000)

  test('88. ошибки запуска: хук с ошибкой, неизвестный раздел конфига, неизвестная команда и флаг', async () => {
    const broken = project({ 'mb_hooks/zz-broken.ts': "import { nope } from 'mabase'\nnope()\n" })
    const r1 = await cli(broken, 'serve', '--port', '0')
    expect(r1.code).toBe(1)
    expect(r1.out).toContain('zz-broken.ts')
    expect(existsSync(join(broken, 'mb_data'))).toBe(false) // до базы дело не дошло

    const typo = project({ 'mabase.config.ts': "import { defineConfig } from 'mabase'\nexport default defineConfig({ colections: [] } as any)\n" })
    expect((await cli(typo, 'serve')).out).toContain('неизвестный раздел "colections"')
    // конфиг без defineConfig проверяется так же
    const plain = project({ 'mabase.config.ts': 'export default { colections: [] }\n' })
    expect((await cli(plain, 'serve')).out).toContain('неизвестный раздел "colections"')
    const r3 = await cli(typo, 'deploy')
    expect(r3.code).toBe(1)
    expect(r3.out).toContain('mabase serve')

    expect(parseArgs(['serve', '--port=0', '--dir', 'data'])).toMatchObject({ cmd: 'serve', flags: { port: 0 } })
    expect(() => parseArgs(['serve', '--prot', '1'])).toThrow('--prot')
    expect(() => parseArgs(['serve', '--port', '99999'])).toThrow('--port')
    expect(parseArgs([]).cmd).toBe('help')
  }, 30_000)
})

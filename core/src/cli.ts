// CLI MaBase (design.md §5, §15, §17):
//
//   mabase serve  [--port 8090] [--host 0.0.0.0] [--dir mb_data] [--public mb_public] [--dev]
//   mabase seed   [--dir mb_data]
//   mabase backup <папка> [--dir mb_data]
//   mabase import <коллекция> <файл.ndjson> [--dir mb_data]
//   mabase tail   [--dir mb_data]
//   mabase update [--check]
//
// Проект - текущая папка: mabase.config.ts, mb_hooks/*.ts, seed.ts. Они
// импортируют 'mabase' - это виртуальный модуль из бинарника, node_modules не нужен.
import { plugin } from 'bun'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as api from './api'
import { openDb } from './db'
import { LockedError } from './errors'
import { importNdjson } from './import'
import { formatTail } from './tail'
import { DEFAULT_API, update } from './update'
import { openApp, readAdminInfo, startServer, type CollectionConfig, type ServerConfig } from './server'

export const VERSION = '0.1.0'

let pluginReady = false
function registerModule(): void {
  if (pluginReady) return
  pluginReady = true
  plugin({
    name: 'mabase',
    setup(build) {
      build.module('mabase', () => ({ exports: { ...api }, loader: 'object' }))
    },
  })
}

export type Flags = { dir: string; port: number; host?: string; public?: string; root: string; dev: boolean; check: boolean }

export function parseArgs(argv: string[]): { cmd: string; args: string[]; flags: Flags } {
  const args: string[] = []
  const raw: Record<string, string> = {}
  let dev = false
  let check = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dev') dev = true
    else if (a === '--check') check = true
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined]
      if (!['dir', 'port', 'host', 'public', 'root'].includes(k)) throw new UsageError(`неизвестный флаг --${k}`)
      const value = v ?? argv[++i]
      if (value === undefined) throw new UsageError(`--${k}: нужно значение`)
      raw[k] = value
    } else args.push(a)
  }
  const root = resolve(raw.root ?? process.cwd())
  const port = raw.port === undefined ? 8090 : Number(raw.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port: число от 0 до 65535')
  return {
    cmd: args.shift() ?? 'help',
    args,
    flags: { root, dir: resolve(root, raw.dir ?? 'mb_data'), port, host: raw.host, public: raw.public && resolve(root, raw.public), dev, check },
  }
}

class UsageError extends Error {}

// Конфиг и хуки проекта. Ошибка в любом файле останавливает запуск: сервер
// без части логики опаснее, чем упавший (design.md §21).
export async function loadProject(flags: Flags, opts: { seed?: boolean } = {}): Promise<{ config: ServerConfig; seed?: api.SeedDefinition; hooks: string[] }> {
  registerModule()
  api.resetApi()
  const load = async (file: string) => {
    try {
      return await import(file)
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`, { cause: err })
    }
  }
  const cfgFile = join(flags.root, 'mabase.config.ts')
  const appCfg: api.AppConfig = existsSync(cfgFile) ? api.defineConfig((await load(cfgFile)).default ?? {}) : {}
  const hooksDir = join(flags.root, 'mb_hooks')
  const hooks = existsSync(hooksDir) ? readdirSync(hooksDir).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts')).sort() : []
  for (const f of hooks) await load(join(hooksDir, f))

  const collections: Record<string, CollectionConfig> = {}
  for (const { name, ...def } of appCfg.collections ?? []) collections[name] = def
  const defaultPublic = join(flags.root, 'mb_public')
  const config: ServerConfig = {
    dataDir: flags.dir,
    port: flags.port,
    hostname: flags.host,
    collections,
    actions: appCfg.actions,
    auth: appCfg.auth,
    mail: appCfg.mail,
    limits: appCfg.limits,
    db: appCfg.db,
    dev: flags.dev,
    realtime: appCfg.realtime,
    events: appCfg.events,
    scheduler: appCfg.scheduler,
    handlers: api.eventHandlers,
    http: { ...appCfg.http, publicDir: flags.public ?? appCfg.http?.publicDir ?? (existsSync(defaultPublic) ? defaultPublic : undefined) },
  }
  let seed: api.SeedDefinition | undefined
  const seedFile = join(flags.root, 'seed.ts')
  if (opts.seed) {
    if (!existsSync(seedFile)) throw new UsageError(`нет ${seedFile}`)
    seed = (await load(seedFile)).default
    if (!seed || typeof seed.seed !== 'function') throw new Error(`${seedFile}: export default defineSeed(...)`)
  }
  return { config, seed, hooks }
}

// База открыта запущенным сервером - команда идёт к нему через admin.
async function viaServer(dir: string, path: string, init: RequestInit): Promise<any> {
  const info = readAdminInfo(dir)
  if (!info) throw new Error(`База занята другим процессом, а ${join(dir, 'admin.json')} нет. Сервер запущен из другой папки?`)
  const res = await fetch(info.url + path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${info.token}` } })
  const body: any = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`сервер ответил ${res.status}: ${body?.message ?? ''}`)
  return body
}

export async function run(argv: string[], out: (line: string) => void = console.log): Promise<void> {
  const { cmd, args, flags } = parseArgs(argv)
  switch (cmd) {
    case 'serve': {
      const { config, hooks } = await loadProject(flags)
      const s = await startServer(config)
      api.bindMailer(s.mail)
      const events = [...api.eventHandlers().keys()]
      out(`MaBase ${VERSION}: ${s.url}`)
      out(`  данные: ${flags.dir}`)
      if (flags.dev) out('  режим разработки: правила проверяются на dependsOn')
      if (hooks.length) out(`  хуки: ${hooks.join(', ')}`)
      if (events.length) out(`  обработчики событий: ${events.join(', ')}`)
      if (s.realtime) out(`  realtime: ${s.url.replace('http', 'ws')}/api/realtime`)
      const stop = async () => {
        await s.stop()
        process.exit(0)
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      return
    }
    case 'seed': {
      const { config, seed } = await loadProject(flags, { seed: true })
      const app = await openApp(config).catch(lockedHint)
      api.bindMailer(app.mail)
      try {
        const t = performance.now()
        await seed!.seed({ db: app.db.c, auth: app.auth })
        out(`Сид выполнен за ${Math.round(performance.now() - t)} мс`)
      } finally {
        api.bindMailer(null)
        await app.close()
      }
      return
    }
    case 'backup': {
      const dest = args[0]
      if (!dest) throw new UsageError('mabase backup <папка>')
      const target = resolve(flags.root, dest)
      let r: { tx: number; bytes: number }
      try {
        const db = await openDb({ dir: join(flags.dir, 'db') })
        try {
          r = await db.backup(target)
        } finally {
          await db.close()
        }
      } catch (err) {
        if (!(err instanceof LockedError)) throw err
        r = await viaServer(flags.dir, '/api/admin/backup', { method: 'POST', body: JSON.stringify({ dir: target }), headers: { 'Content-Type': 'application/json' } })
      }
      out(`Бэкап на tx ${r.tx}: ${target} (${r.bytes} байт)`)
      return
    }
    case 'import': {
      const [collection, file] = args
      if (!collection || !file) throw new UsageError('mabase import <коллекция> <файл.ndjson>')
      const text = readFileSync(resolve(flags.root, file), 'utf8')
      let r: { inserted: number; skipped: number }
      try {
        const { config } = await loadProject(flags)
        const app = await openApp(config)
        try {
          r = await importNdjson(app.db, collection, text)
        } finally {
          await app.close()
        }
      } catch (err) {
        if (!(err instanceof LockedError)) throw err
        r = await viaServer(flags.dir, `/api/admin/import/${encodeURIComponent(collection)}`, { method: 'POST', body: text, headers: { 'Content-Type': 'application/x-ndjson' } })
      }
      out(`Импорт в ${collection}: добавлено ${r.inserted}, пропущено ${r.skipped} (такой _id уже есть)`)
      return
    }
    case 'tail': {
      const info = readAdminInfo(flags.dir)
      if (!info) throw new Error(`Сервер не запущен: нет ${join(flags.dir, 'admin.json')}`)
      const res = await fetch(`${info.url}/api/admin/tail`, { headers: { Authorization: `Bearer ${info.token}` } })
      if (!res.ok || !res.body) throw new Error(`сервер ответил ${res.status}`)
      let buf = ''
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += new TextDecoder().decode(chunk)
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (line) out(formatTail(JSON.parse(line)))
        }
      }
      return
    }
    case 'version':
      out(VERSION)
      return
    case 'update': {
      // Из исходников обновлять нечего: process.execPath - это сам bun
      if (!import.meta.url.includes('$bunfs')) throw new UsageError('update работает только в собранном бинарнике')
      const r = await update({ current: VERSION, exe: realpathSync(process.execPath), api: process.env.MABASE_UPDATE_URL || DEFAULT_API, check: flags.check, out })
      if (r.updated && readAdminInfo(flags.dir)) out('Сервер запущен на старой версии - перезапустите его')
      return
    }
    case 'help':
      out(HELP)
      return
  }
  throw new UsageError(`неизвестная команда "${cmd}"\n\n${HELP}`)
}

function lockedHint(err: unknown): never {
  if (err instanceof LockedError) throw new Error(`${err.message}. Сид пишет в базу напрямую - остановите сервер`)
  throw err
}

const HELP = `MaBase ${VERSION}

  mabase serve  [--port 8090] [--host 0.0.0.0] [--dir mb_data] [--public mb_public] [--dev]
                --dev - предупреждать, если правило читает коллекцию не из dependsOn
  mabase seed   - выполнить seed.ts (сервер должен быть остановлен)
  mabase backup <папка>
  mabase import <коллекция> <файл.ndjson>
  mabase tail   - живой журнал работающего сервера: коммиты, действия, события, ошибки
  mabase update  [--check] - скачать новую версию с GitHub и заменить этот файл
  mabase version`

if (import.meta.main) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(`[mabase] ${err instanceof UsageError ? '' : 'ошибка: '}${err?.message ?? err}`)
    process.exit(1)
  })
}

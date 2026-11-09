// CLI MaBase (design.md §5, §15, §17):
//
//   mabase serve  [--port 8090] [--host 0.0.0.0] [--dir mb_data] [--public mb_public] [--dev]
//   mabase seed   [--dir mb_data]
//   mabase backup <папка> [--dir mb_data]
//   mabase import <коллекция> <файл.ndjson> [--dir mb_data]
//   mabase tail   [--dir mb_data]
//   mabase update [--check]
//   mabase superuser list | upsert <email> <пароль> | delete <email>
//
// Проект - текущая папка: mabase.config.ts, mb_hooks/*.ts, seed.ts. Они
// импортируют 'mabase' - это виртуальный модуль из бинарника, node_modules не нужен.
import { plugin } from 'bun'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as api from './api'
import { openDb } from './db'
import { LockedError } from './errors'
import { configView } from './config-view'
import { LocalStorage, S3Storage, migrateFiles, type FileStorage } from './files'
import { readEnv } from './env'
import type { S3Options } from './files'
import type { SmtpOptions } from './mail'
import { importNdjson } from './import'
import { applyMigrations, loadMigrations } from './migrations'
import { formatTail } from './tail'
import { superuserCommand } from './superusers'
import { runWizard, terminalIO } from './wizard'
import { DEFAULT_API, update } from './update'
import { openApp, readAdminInfo, startServer, type CollectionConfig, type ServerConfig } from './server'

export { VERSION } from './version'
import { VERSION } from './version'

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

// Bun в собранном бинарнике подставляет в статическое process.env.MABASE_*
// значение с момента сборки - обычно undefined. Предупреждаем заранее: иначе
// сид молча получает пустой секрет и падает с «не задан».
function warnReservedEnv(file: string, warnings: string[]): void {
  let src: string
  try {
    src = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const m = src.match(/process\.env\s*(?:\.\s*(MABASE_[A-Za-z0-9_]+)|\[\s*(['"])(MABASE_[A-Za-z0-9_]+)\2\s*\])/)
  const name = m?.[1] ?? m?.[3]
  if (!name) return
  warnings.push(
    `${file}: process.env.${name} - префикс MABASE_ зарезервирован: в скомпилированной сборке такое обращение может вернуть undefined. Назовите переменную иначе, например SERVICE_PASSWORD`,
  )
}

export type Flags = {
  dir: string
  port: number
  host?: string
  public?: string
  root: string
  dev: boolean
  check: boolean
  dryRun: boolean
  filesFrom?: string // mabase files migrate --from
  filesTo?: string // --to
  given: { dir?: boolean; port?: boolean; host?: boolean; public?: boolean } // что задано флагом (приоритет над env)
}

export function parseArgs(argv: string[]): { cmd: string; args: string[]; flags: Flags } {
  const args: string[] = []
  const raw: Record<string, string> = {}
  let dev = false
  let check = false
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dev') dev = true
    else if (a === '--check') check = true
    else if (a === '--dry-run') dryRun = true
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined]
      if (!['dir', 'port', 'host', 'public', 'root', 'from', 'to'].includes(k)) throw new UsageError(`неизвестный флаг --${k}`)
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
    flags: {
      root,
      dir: resolve(root, raw.dir ?? 'mb_data'),
      port,
      host: raw.host,
      public: raw.public && resolve(root, raw.public),
      dev,
      check,
      dryRun,
      filesFrom: raw.from,
      filesTo: raw.to,
      given: {
        ...(raw.dir !== undefined && { dir: true }),
        ...(raw.port !== undefined && { port: true }),
        ...(raw.host !== undefined && { host: true }),
        ...(raw.public !== undefined && { public: true }),
      },
    },
  }
}

class UsageError extends Error {}

// Конфиг и хуки проекта. Ошибка в любом файле останавливает запуск: сервер
// без части логики опаснее, чем упавший (design.md §21).
export async function loadProject(
  flags: Flags,
  opts: { seed?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<{ config: ServerConfig; seed?: api.SeedDefinition; hooks: string[]; sources: Record<string, string>; warnings: string[] }> {
  registerModule()
  api.resetApi()
  const warnings: string[] = []
  const load = async (file: string) => {
    warnReservedEnv(file, warnings)
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

  // Приоритет: флаги CLI > env > mabase.config.ts > настройки админки > умолчания.
  const env = readEnv(opts.env ?? process.env)
  const given = flags.given ?? {} // внешние вызовы могут не заполнять given
  const fromFlag = (k: 'dir' | 'port' | 'host' | 'public') => given[k] === true
  const dataDir = fromFlag('dir') ? flags.dir : (env.overrides.dir ?? flags.dir)
  const port = fromFlag('port') ? flags.port : (env.overrides.port ?? flags.port)
  const hostname = fromFlag('host') ? flags.host : (env.overrides.host ?? flags.host)
  const publicDir = fromFlag('public')
    ? flags.public
    : (env.overrides.publicDir ?? appCfg.http?.publicDir ?? (existsSync(defaultPublic) ? defaultPublic : undefined))

  const s3 = appCfg.storage?.s3 || env.overrides.storage?.s3 ? { ...appCfg.storage?.s3, ...env.overrides.storage?.s3 } : undefined
  const smtp = appCfg.mail?.smtp || env.overrides.mail?.smtp ? { ...appCfg.mail?.smtp, ...env.overrides.mail?.smtp } : undefined
  const oauth = mergeOauth(appCfg.auth?.oauth, env.overrides.auth?.oauth)

  const sources: Record<string, string> = {}
  sources.dir = fromFlag('dir') ? 'флаг --dir' : env.overrides.dir ? 'MABASE_DIR' : 'по умолчанию'
  sources.port = fromFlag('port') ? 'флаг --port' : env.overrides.port !== undefined ? 'MABASE_PORT' : 'по умолчанию'
  sources.host = fromFlag('host') ? 'флаг --host' : env.overrides.host ? 'MABASE_HOST' : 'по умолчанию'
  if (publicDir) sources.public = fromFlag('public') ? 'флаг --public' : env.overrides.publicDir ? 'MABASE_PUBLIC' : 'config'
  const serverUrl = env.overrides.serverUrl ?? appCfg.http?.serverUrl
  if (serverUrl) sources.serverUrl = env.overrides.serverUrl ? 'MABASE_SERVER_URL' : 'config'
  const cors = env.overrides.cors ?? appCfg.http?.cors
  if (cors) sources.cors = env.overrides.cors ? 'MABASE_CORS' : 'config'
  if (env.overrides.secret) sources.secret = 'MABASE_SECRET'
  if (s3) sources.storage = env.overrides.storage?.s3 ? 'MABASE_S3_*' : 'config'
  if (smtp || env.overrides.mail?.from) sources.mail = env.overrides.mail ? 'MABASE_SMTP_*/MABASE_MAIL_FROM' : 'config'
  if (oauth) sources.auth = env.overrides.auth ? 'MABASE_APP_URL/MABASE_GOOGLE_*/MABASE_GITHUB_*' : 'config'
  if (env.overrides.auth?.appUrl && !oauth) sources.auth = 'MABASE_APP_URL'
  const appUrl = env.overrides.auth?.appUrl ?? appCfg.auth?.appUrl
  if ((smtp || env.overrides.mail?.from) && !appUrl) {
    env.warnings.push('почта настроена, а адрес приложения не задан: нужен MABASE_APP_URL (или auth.appUrl) - на него ведут ссылки из писем')
  }

  const config: ServerConfig = {
    dataDir,
    port,
    hostname,
    collections,
    actions: appCfg.actions,
    auth: {
      ...appCfg.auth,
      ...(env.overrides.secret !== undefined && { secret: env.overrides.secret }),
      ...(env.overrides.auth?.appUrl !== undefined && { appUrl: env.overrides.auth.appUrl }),
      ...(oauth && { oauth }),
    },
    mail: { ...appCfg.mail, ...(env.overrides.mail?.from !== undefined && { from: env.overrides.mail.from }), ...(smtp?.host && { smtp: smtp as SmtpOptions }) },
    limits: appCfg.limits,
    db: appCfg.db,
    dev: flags.dev,
    realtime: appCfg.realtime,
    events: appCfg.events,
    scheduler: appCfg.scheduler,
    admin: appCfg.admin,
    storage: s3 ? { s3: s3 as S3Options } : undefined,
    handlers: api.eventHandlers,
    hooksDir,
    http: { ...appCfg.http, publicDir, ...(serverUrl !== undefined && { serverUrl }), ...(cors !== undefined && { cors }) },
  }
  let seed: api.SeedDefinition | undefined
  const seedFile = join(flags.root, 'seed.ts')
  if (opts.seed) {
    if (!existsSync(seedFile)) throw new UsageError(`нет ${seedFile}`)
    seed = (await load(seedFile)).default
    if (!seed || typeof seed.seed !== 'function') throw new Error(`${seedFile}: export default defineSeed(...)`)
  }
  return { config, seed, hooks, sources, warnings: [...warnings, ...env.warnings] }
}

function mergeOauth(
  fromConfig: Partial<Record<'google' | 'github', { clientId: string; clientSecret: string }>> | undefined,
  fromEnv: Partial<Record<'google' | 'github', Partial<{ clientId: string; clientSecret: string }>>> | undefined,
): Partial<Record<'google' | 'github', { clientId: string; clientSecret: string }>> | undefined {
  if (!fromConfig && !fromEnv) return undefined
  const out: any = { ...fromConfig }
  for (const p of ['google', 'github'] as const) {
    const e = fromEnv?.[p]
    if (e?.clientId && e?.clientSecret) out[p] = { clientId: e.clientId, clientSecret: e.clientSecret }
  }
  return out
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
      const { config, hooks, warnings } = await loadProject(flags)
      for (const w of warnings) out(`[mabase] ${w}`)
      const s = await startServer(config)
      api.bindMailer(s.mail)
      const events = [...api.eventHandlers().keys()]
      out(`MaBase ${VERSION}: ${s.url}`)
      out(`  данные: ${flags.dir}`)
      if (flags.dev) out('  режим разработки: правила проверяются на dependsOn')
      if (hooks.length) out(`  хуки: ${hooks.join(', ')} (перезагружаются при изменении)`)
      if (events.length) out(`  обработчики событий: ${events.join(', ')}`)
      if (s.realtime) out(`  realtime: ${s.url.replace('http', 'ws')}/api/realtime`)
      if (config.admin?.enabled !== false) out(`  админка: ${s.url}/_/`)
      const stop = async () => {
        await s.stop()
        process.exit(0)
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      // Первый запуск из терминала - вопросы здесь же; без терминала (systemd,
      // Docker) или если пропустили - ссылка для браузера.
      if (s.setupUrl && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI) {
        const io = terminalIO()
        const done = await runWizard(io, { superusers: s.superusers, settings: s.settings, url: s.url })
          .catch((err) => {
            out(`[mabase] мастер настройки: ${err?.message ?? err}`)
            return false
          })
          .finally(() => io.close())
        if (done) return
      }
      if (s.setupUrl && (await s.superusers.count()) === 0) {
        out('')
        out('(!) Администратора ещё нет. Откройте ссылку, чтобы создать первого:')
        out(`    ${s.setupUrl}`)
        out('    Или: mabase superuser upsert <email> <пароль>')
      }
      return
    }
    case 'seed': {
      const { config, seed, warnings } = await loadProject(flags, { seed: true })
      for (const w of warnings) out(`[mabase] ${w}`)
      const app = await openApp(config).catch(lockedHint)
      api.bindMailer(app.mail)
      try {
        const t = performance.now()
        // Сид идёт мимо правил, но хуки работают и видят origin: 'seed'.
        await app.db.runAs('seed', () => seed!.seed({ db: app.db.c, auth: app.auth }))
        out(`Сид выполнен за ${Math.round(performance.now() - t)} мс`)
      } finally {
        api.bindMailer(null)
        await app.close()
      }
      return
    }
    case 'migrate': {
      // Миграции - при остановленном сервере: они пишут в базу напрямую.
      const { config, warnings } = await loadProject(flags)
      for (const w of warnings) out(`[mabase] ${w}`)
      const app = await openApp(config).catch(lockedHint)
      try {
        const list = await loadMigrations(join(flags.root, 'mb_migrations'))
        if (!list.length) {
          out('Миграций нет: папка mb_migrations пуста или её нет')
          return
        }
        const r = await applyMigrations(app.db, list, { onApply: (name) => out(`  применена ${name}`) })
        out(r.applied.length ? `Применено миграций: ${r.applied.length}, уже было: ${r.skipped}` : `Всё уже применено: ${r.skipped} миграций`)
      } finally {
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
    case 'files': {
      if (args[0] !== 'migrate') throw new UsageError('mabase files migrate --from local|s3 --to local|s3 [--dry-run]')
      const fromSide = flags.filesFrom
      const toSide = flags.filesTo
      if (fromSide !== 'local' && fromSide !== 's3') throw new UsageError('--from local|s3')
      if (toSide !== 'local' && toSide !== 's3') throw new UsageError('--to local|s3')
      if (fromSide === toSide) throw new UsageError('--from и --to совпадают: переносить некуда')
      const { config, warnings } = await loadProject(flags)
      for (const w of warnings) out(`[mabase] ${w}`)
      const local = new LocalStorage(join(config.dataDir, 'files'))
      const s3 = config.storage?.s3 ? new S3Storage(config.storage.s3) : null
      const side = (name: string): FileStorage => {
        if (name === 'local') return local
        if (!s3) throw new UsageError('для S3 нужны настройки storage.s3: mabase.config.ts или MABASE_S3_*')
        return s3
      }
      const app = await openApp(config).catch(lockedHint)
      try {
        const t = performance.now()
        const r = await migrateFiles(app.db, side(fromSide), side(toSide), {
          dryRun: flags.dryRun,
          onProgress: (p) => out(`  … ${p.copied + p.skipped} из ${p.total}`),
        })
        const what = flags.dryRun ? 'нужно перенести' : 'перенесено'
        out(`${flags.dryRun ? 'Проверка (ничего не скопировано)' : 'Готово'}: всего ${r.total}, ${what} ${r.copied}, уже было ${r.skipped}, ${(r.bytes / 1e6).toFixed(1)} МБ, ${Math.round(performance.now() - t)} мс`)
        for (const f of r.failed.slice(0, 10)) out(`  ошибка ${f.id}: ${f.error}`)
        if (r.failed.length) {
          out(`Не перенесено файлов: ${r.failed.length} - проверьте источник и повторите`)
          process.exitCode = 1
        } else if (!flags.dryRun && r.copied) {
          out('Источник не удалён: проверьте, что всё на месте, и уберите старое сами')
        }
      } finally {
        await app.close()
      }
      return
    }
    case 'config': {
      const { config, sources, hooks, warnings } = await loadProject(flags)
      for (const w of warnings) out(`[mabase] ${w}`)
      out(`MaBase ${VERSION}: настройки (слева - значение, справа - откуда оно)`)
      for (const l of configView(config, { sources, hooks })) out(`  ${l.key.padEnd(20)} ${l.value}${l.source ? `   (${l.source})` : ''}`)
      return
    }
    case 'version':
      out(VERSION)
      return
    case 'superuser': {
      const [op, email, password] = args
      if (!['list', 'upsert', 'delete'].includes(op ?? '') || (op !== 'list' && !email) || (op === 'upsert' && !password)) {
        throw new UsageError('mabase superuser list | upsert <email> <пароль> | delete <email>')
      }
      const cmd = { op, email, password }
      let r: any
      try {
        const { config } = await loadProject(flags)
        const app = await openApp(config)
        try {
          r = await superuserCommand(app.superusers, cmd)
        } finally {
          await app.close()
        }
      } catch (err) {
        if (!(err instanceof LockedError)) throw err
        r = await viaServer(flags.dir, '/api/admin/superuser', { method: 'POST', body: JSON.stringify(cmd), headers: { 'Content-Type': 'application/json' } })
      }
      if (op === 'list') out(r.length ? r.map((x: any) => `${x.email}  (создан ${new Date(x.createdAt).toLocaleString('ru-RU')})`).join('\n') : 'Администраторов нет')
      else if (op === 'upsert') out(r.created ? `Администратор ${r.email} создан` : `Пароль ${r.email} изменён, его сессии закрыты`)
      else out(`Администратор ${email} удалён`)
      return
    }
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
  if (err instanceof LockedError) throw new Error(`${err.message}. Сид и миграции пишут в базу напрямую - остановите сервер`)
  throw err
}

const HELP = `MaBase ${VERSION}

  mabase serve  [--port 8090] [--host 0.0.0.0] [--dir mb_data] [--public mb_public] [--dev]
                --dev - предупреждать, если правило читает коллекцию не из dependsOn
  mabase seed   - выполнить seed.ts (сервер должен быть остановлен)
  mabase migrate - применить миграции из mb_migrations/ (сервер остановлен)
  mabase config - показать настройки и откуда взято каждое значение
  mabase files migrate --from local|s3 --to local|s3 [--dry-run]
                - перенести файлы между локальной папкой и S3
  mabase backup <папка>
  mabase import <коллекция> <файл.ndjson>
  mabase tail   - живой журнал работающего сервера: коммиты, действия, события, ошибки
  mabase superuser list | upsert <email> <пароль> | delete <email>
                - администраторы админки /_/
  mabase update  [--check] - скачать новую версию с GitHub и заменить этот файл
  mabase version`

if (import.meta.main) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(`[mabase] ${err instanceof UsageError ? '' : 'ошибка: '}${err?.message ?? err}`)
    process.exit(1)
  })
}

// Запуск сервера: папка данных, секреты, база, доступ, вход, действия, HTTP.
//
//   <dataDir>/db/          база (design.md §6)
//   <dataDir>/secret.key   секрет подписи токенов, если нет MABASE_SECRET
//   <dataDir>/admin.json   адрес и токен /api/admin/* для CLI на этой машине; новый на каждый старт, удаляется при остановке
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Access, type AccessDef, type ClientLimits } from './access'
import { Actions, type ActionDef } from './actions'
import { Auth, USERS, type AuthOptions } from './auth'
import { openDb, type CollectionDef, type Db, type DbOptions } from './db'
import { createHandler, type HttpOptions } from './http'
import { Bus, type Handler } from './bus'
import { Mailer, type MailMessage, type MailOptions } from './mail'
import { checkEvents, PRESENCE, Realtime, type Conn, type EventConfig } from './realtime'
import { Scheduler, ensureSchedules, type SchedulerOptions } from './scheduler'
import { reloadHooks as reloadHookFiles, watchHooks, type HooksInfo } from './hooks'
import { scheduledTasks } from './api'
import { writeEditorTypes } from './editor'
import { attachFileCleanup, FILES, type FileFields, FileStore, LocalStorage, S3Storage, type S3Options } from './files'
import { maskSecrets, Tail } from './tail'
import { createAdminApi } from './admin-api'
import { Superusers, type SuperuserOptions } from './superusers'
import { Settings } from './settings'
import { Registry } from './registry'

export type CollectionConfig = CollectionDef & AccessDef

export type ServerConfig = {
  dataDir: string
  port?: number // 8090
  hostname?: string
  collections?: Record<string, CollectionConfig> // users - расширение встроенной
  actions?: ActionDef[]
  auth?: Omit<AuthOptions, 'secret' | 'users' | 'mail'> & { secret?: string }
  mail?: MailOptions
  http?: Omit<HttpOptions, 'access' | 'auth' | 'actions' | 'adminToken' | 'adminApi' | 'superusers'>
  admin?: { enabled?: boolean; superusers?: SuperuserOptions } // админка /_/; enabled: false - выключить
  limits?: Partial<ClientLimits>
  db?: Omit<DbOptions, 'dir'>
  dev?: boolean // режим разработки: проверка dependsOn у правил
  realtime?: boolean // WebSocket /api/realtime
  events?: Record<string, EventConfig>
  handlers?: () => ReadonlyMap<string, readonly Handler[]> // on() из mb_hooks
  storage?: { s3?: S3Options } // где лежат файлы; нет - локальная папка dataDir/files
  hooksDir?: string // папка mb_hooks для горячей перезагрузки
  watchHooks?: boolean // следить за hooksDir; по умолчанию да, если папка задана
  scheduler?: Omit<SchedulerOptions, 'onError' | 'tail'> // отложенные события
  env?: Record<string, string | undefined>
  onWarning?: (message: string) => void
  onError?: (err: unknown, where: string) => void
}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600) // файл мог существовать с другими правами
}

// Секрет: MABASE_SECRET, иначе файл в папке данных, иначе создать файл.
// Без файла каждый рестарт выкидывал бы всех пользователей.
export function loadSecret(dataDir: string, env: Record<string, string | undefined>, warn: (m: string) => void): string {
  const fromEnv = env.MABASE_SECRET
  if (fromEnv) {
    if (fromEnv.length < 32) throw new TypeError('MABASE_SECRET: не короче 32 символов')
    return fromEnv
  }
  const path = join(dataDir, 'secret.key')
  if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  const secret = randomBytes(32).toString('base64url')
  writePrivate(path, secret + '\n')
  warn(`Секрет подписи токенов создан в ${path}. Берегите файл: с ним можно подделать вход любого пользователя`)
  return secret
}

export type App = {
  db: Db
  access: Access
  auth: Auth
  actions: Actions
  mail: Mailer
  tail: Tail
  bus: Bus
  superusers: Superusers
  settings: Settings
  registry: Registry
  files: FileStore
  fileDefs: (c: string) => FileFields | undefined
  close: () => Promise<void>
}

// База, доступ, вход и действия - без HTTP. Для сида и импорта при
// остановленном сервере и как основа startServer.
export async function openApp(cfg: ServerConfig): Promise<App> {
  const warn = cfg.onWarning ?? ((m: string) => console.warn(`[mabase] ${m}`))
  const env = cfg.env ?? process.env
  const tail = new Tail()
  const report = cfg.onError ?? ((err: unknown, where: string) => console.error(`[mabase] ошибка в ${where}`, err))
  const onError = (err: unknown, where: string) => {
    tail.publish('error', { where, error: String(err) })
    report(err, where)
  }
  if (cfg.events) checkEvents(cfg.events) // ошибка в конфиге событий - до открытия базы
  mkdirSync(cfg.dataDir, { recursive: true })
  // Типы для редактора: <dataDir>/types.d.ts и типы zod (design.md §5).
  // Не записались - не повод не запускаться.
  try {
    await writeEditorTypes(cfg.dataDir)
  } catch (err) {
    warn(`типы для редактора не записались: ${(err as Error).message}`)
  }
  // Файлы: S3, если настроен, иначе локальная папка <dataDir>/files/... (§16).
  const fileStorage = cfg.storage?.s3 ? new S3Storage(cfg.storage.s3) : new LocalStorage(join(cfg.dataDir, 'files'))
  const files = new FileStore(fileStorage, cfg.http?.maxUploadBytes)
  const db = await openDb({
    ...cfg.db,
    dir: join(cfg.dataDir, 'db'),
    onWarning: cfg.db?.onWarning ?? warn,
    onError: (err, info) => onError(err, info.collection ? `${info.where} ${info.collection}` : info.where),
  })
  try {
    // Время удержания очереди - лучший способ найти медленный хук (design.md §14).
    db.onCommit((info) => {
      if (!tail.active) return
      const ops: Record<string, number> = {}
      for (const ch of info.changes) ops[ch.c] = (ops[ch.c] ?? 0) + 1
      tail.publish('commit', { tx: info.tx, holdMs: info.holdMs, user: info.user?.id, ops, events: info.events.map((e) => e.event) })
    })
    // Метаданные файлов: _files. Клиентам закрыта (нет правил), админке видна.
    db.collection(FILES, { indexes: ['recordId'] })
    const fileDefs = (c: string) => (cfg.collections ?? {})[c]?.files
    attachFileCleanup({ db, files, defs: fileDefs, onError })
    const { [USERS]: usersCfg, ...others } = cfg.collections ?? {}
    const accessDefs: Record<string, AccessDef> = {}
    // _presence - соединения: { _id: id соединения, userId, connectedAt } (design.md §12)
    if (cfg.realtime && !others[PRESENCE]) others[PRESENCE] = {}
    for (const [name, c] of Object.entries(others)) {
      const indexes = name === PRESENCE ? [...new Set([...(c.indexes ?? []), 'userId'])] : c.indexes
      db.collection(name, { schema: c.schema, indexes, hooks: c.hooks, relations: c.relations })
      accessDefs[name] = { rules: c.rules, fields: c.fields, owner: c.owner, files: c.files }
    }
    if (usersCfg) accessDefs[USERS] = { rules: usersCfg.rules, fields: usersCfg.fields, files: usersCfg.files }
    const access = new Access(db, accessDefs, cfg.limits, {
      files,
      onRuleWarning: cfg.dev
        ? (m) => {
            tail.publish('warning', { message: m })
            warn(m)
          }
        : undefined,
    })
    const print = (m: MailMessage) =>
      console.log(`[mabase] письмо (почта не настроена - режим разработки)\n  кому: ${m.to}\n  тема: ${m.subject}\n\n${m.text}`)
    const devMail = cfg.mail?.onDevMail ?? print
    const mail = new Mailer({
      ...cfg.mail,
      onDevMail: (m) => {
        // В письмах сброса и смены email - рабочая одноразовая ссылка с токеном.
        // В журнал (mabase tail, /_/journal, логи) она попадать не должна.
        tail.publish('mail', { to: m.to, subject: m.subject, text: maskSecrets(m.text) })
        devMail(m)
      },
    })
    const secret = cfg.auth?.secret ?? loadSecret(cfg.dataDir, env, warn)
    const auth = new Auth(access, {
      ...cfg.auth,
      secret,
      users: usersCfg && { schema: usersCfg.schema, indexes: usersCfg.indexes, hooks: usersCfg.hooks, relations: usersCfg.relations },
      mail,
      onError: (err, where) => onError(err, where),
    })
    const actions = new Actions(db, cfg.actions ?? [], { onError: (err, info) => onError(err, `действие ${info.name}`) })
    actions.onRun((r) => tail.publish('action', { name: r.name, user: r.userId, ms: Math.round(r.ms), ok: r.ok, code: r.code }))
    const bus = new Bus(db, cfg.handlers ?? (() => new Map()), { onError, tail })
    const superusers = new Superusers(db, cfg.admin?.superusers)
    // Код главнее админки: способы входа или отправка почты заданы в конфиге -
    // этот раздел настроек админка только показывает.
    const a = cfg.auth ?? {}
    const fixed = {
      auth: ['providers', 'signup', 'oauth', 'appUrl', 'minPasswordLength'].some((k) => (a as any)[k] !== undefined),
      mail: !!(cfg.mail?.smtp || cfg.mail?.send),
      storage: !!cfg.storage?.s3, // конфиг/env главнее админки
    }
    // Файлы: смена настроек в админке переключает хранилище без перезапуска.
    // Старые файлы остаются там, где лежали - их переносит `files migrate`.
    const settings = new Settings(db, secret, auth, mail, fixed, {
      onStorage: (s3) => {
        files.storage = s3 ? new S3Storage(s3) : new LocalStorage(join(cfg.dataDir, 'files'))
      },
      liveStorage: () => (files.storage instanceof S3Storage ? files.storage.opts : null),
    })
    await settings.load(warn)
    const registry = new Registry(db)
    await registry.load(warn)
    return {
      db,
      access,
      auth,
      actions,
      mail,
      tail,
      bus,
      superusers,
      settings,
      registry,
      files,
      fileDefs,
      close: async () => {
        await auth.settled()
        await bus.settled()
        await db.close()
      },
    }
  } catch (err) {
    await db.close()
    throw err
  }
}

// Как CLI на этой машине находит запущенный сервер: адрес и токен admin.
export type AdminInfo = { url: string; token: string; pid: number }
export const ADMIN_FILE = 'admin.json'

export function readAdminInfo(dataDir: string): AdminInfo | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, ADMIN_FILE), 'utf8'))
  } catch {
    return null
  }
}

// setupUrl - ссылка первичной настройки админки, пока нет ни одного суперпользователя.
export type RunningServer = App & {
  url: string
  adminToken: string
  setupUrl: string | null
  realtime: Realtime | null
  scheduler: Scheduler
  reloadHooks: () => Promise<HooksInfo>
  stop: () => Promise<void>
}

export async function startServer(cfg: ServerConfig): Promise<RunningServer> {
  const warn = cfg.onWarning ?? ((m: string) => console.warn(`[mabase] ${m}`))
  const app = await openApp(cfg)
  try {
    if (app.mail.mode === 'dev') warn('Почта не настроена: письма печатаются в консоль')
    const adminToken = randomBytes(32).toString('base64url')
    const adminApi =
      cfg.admin?.enabled === false
        ? undefined
        : createAdminApi({ access: app.access, superusers: app.superusers, settings: app.settings, registry: app.registry, mail: app.mail, tail: app.tail, files: app.files, fileDefs: app.fileDefs })
    const handle = createHandler({ ...cfg.http, access: app.access, auth: app.auth, actions: app.actions, adminToken, tail: app.tail, adminApi, superusers: app.superusers })
    let rt: Realtime | null = null
    if (cfg.realtime) {
      rt = new Realtime(app.access, app.auth, { events: cfg.events, tail: app.tail, onError: (err, where) => app.tail.publish('error', { where, error: String(err) }) })
      await rt.start()
    }
    const realtime = rt
    // Периодические задачи из schedule(): по одной на событие, до старта
    // планировщика - чтобы просроченные выполнились при старте.
    if (scheduledTasks().length) await ensureSchedules(app.db, scheduledTasks())
    // Отложенные события выполняет только сервер: сид и импорт их не трогают.
    const scheduler = new Scheduler(app.db, cfg.handlers ?? (() => new Map()), {
      ...cfg.scheduler,
      tail: app.tail,
      onError: (err, where) => {
        app.tail.publish('error', { where, error: String(err) })
        ;(cfg.onError ?? ((e: unknown, w: string) => console.error(`[mabase] ошибка в ${w}`, e)))(err, where)
      },
    })
    const overdue = await scheduler.start()
    if (overdue) warn(`Отложенных событий, пропущенных за время простоя: ${overdue}. Выполняются сейчас`)

    // Горячая перезагрузка хуков: правка mb_hooks/*.ts подхватывается без
    // рестарта. Ошибка в файле не роняет сервер - работают прежние хуки.
    const reload = async (): Promise<HooksInfo> => {
      const r = await reloadHookFiles(cfg.hooksDir!)
      if (scheduledTasks().length) await ensureSchedules(app.db, scheduledTasks())
      return r
    }
    const stopWatch =
      cfg.hooksDir && cfg.watchHooks !== false
        ? watchHooks(cfg.hooksDir, () => {
            void reload()
              .then((r) => {
                app.tail.publish('hooks', { ...r, ok: true })
                warn(`хуки перезагружены: файлов ${r.files}, обработчиков ${r.handlers}, задач ${r.schedules}`)
              })
              .catch((err) => {
                app.tail.publish('hooks', { ok: false, error: String(err) })
                warn(`хуки НЕ перезагружены, работают прежние: ${(err as Error).message}`)
              })
          })
        : () => {}
    type WsData = { conn?: Conn }
    const server = Bun.serve<WsData>({
      port: cfg.port ?? 8090,
      hostname: cfg.hostname,
      maxRequestBodySize: (cfg.http?.maxImportBytes ?? 256 << 20) + 1024,
      fetch: (req, srv) => {
        if (realtime && new URL(req.url).pathname === '/api/realtime') {
          if (srv.upgrade(req, { data: {} })) return undefined
          return new Response('Нужен WebSocket', { status: 400 })
        }
        return handle(req, { ip: srv.requestIP(req)?.address })
      },
      websocket: {
        maxPayloadLength: 64 << 10,
        idleTimeout: 120, // SDK шлёт ping
        open(ws) {
          ws.data.conn = realtime!.connect(
            (text) => ws.send(text),
            (code, reason) => ws.close(code, reason),
          )
        },
        message(ws, m) {
          void ws.data.conn!.receive(typeof m === 'string' ? m : new TextDecoder().decode(m))
        },
        close(ws) {
          void ws.data.conn?.closedByClient()
        },
      },
    })
    // admin слушает тот же порт; CLI ходит на loopback
    const wildcard = !cfg.hostname || cfg.hostname === '0.0.0.0' || cfg.hostname === '::'
    const host = wildcard ? '127.0.0.1' : cfg.hostname!
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${server.port}`
    const adminPath = join(cfg.dataDir, ADMIN_FILE)
    writePrivate(adminPath, JSON.stringify({ url, token: adminToken, pid: process.pid } satisfies AdminInfo) + '\n')
    const setup = adminApi ? await app.superusers.installToken() : null
    let stopped: Promise<void> | null = null
    return {
      ...app,
      url,
      adminToken,
      setupUrl: setup && `${url}/_/#/setup/${setup}`,
      realtime,
      scheduler,
      reloadHooks: () => (cfg.hooksDir ? reload() : Promise.resolve({ files: 0, handlers: 0, schedules: 0 })),
      stop: () =>
        (stopped ??= (async () => {
          stopWatch()
          await scheduler.stop()
          await realtime?.stop()
          // Bun 1.3.12: stop(true) не завершается, если через сервер прошёл
          // WebSocket. Сокеты realtime уже закрыл сам - ждём не дольше секунды.
          await Promise.race([server.stop(true), Bun.sleep(1000)])
          rmSync(adminPath, { force: true })
          await app.close()
        })()),
    }
  } catch (err) {
    await app.close()
    throw err
  }
}

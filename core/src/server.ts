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
import { Tail } from './tail'

export type CollectionConfig = CollectionDef & AccessDef

export type ServerConfig = {
  dataDir: string
  port?: number // 8090
  hostname?: string
  collections?: Record<string, CollectionConfig> // users - расширение встроенной
  actions?: ActionDef[]
  auth?: Omit<AuthOptions, 'secret' | 'users' | 'mail'> & { secret?: string }
  mail?: MailOptions
  http?: Omit<HttpOptions, 'access' | 'auth' | 'actions' | 'adminToken'>
  limits?: Partial<ClientLimits>
  db?: Omit<DbOptions, 'dir'>
  realtime?: boolean // WebSocket /api/realtime
  events?: Record<string, EventConfig>
  handlers?: () => ReadonlyMap<string, readonly Handler[]> // on() из mb_hooks
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

export type App = { db: Db; access: Access; auth: Auth; actions: Actions; mail: Mailer; tail: Tail; bus: Bus; close: () => Promise<void> }

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
    const { [USERS]: usersCfg, ...others } = cfg.collections ?? {}
    const accessDefs: Record<string, AccessDef> = {}
    // _presence - соединения: { _id: id соединения, userId, connectedAt } (design.md §12)
    if (cfg.realtime && !others[PRESENCE]) others[PRESENCE] = {}
    for (const [name, c] of Object.entries(others)) {
      const indexes = name === PRESENCE ? [...new Set([...(c.indexes ?? []), 'userId'])] : c.indexes
      db.collection(name, { schema: c.schema, indexes, hooks: c.hooks })
      accessDefs[name] = { rules: c.rules, fields: c.fields, owner: c.owner }
    }
    if (usersCfg) accessDefs[USERS] = { rules: usersCfg.rules, fields: usersCfg.fields }
    const access = new Access(db, accessDefs, cfg.limits)
    const print = (m: MailMessage) =>
      console.log(`[mabase] письмо (почта не настроена - режим разработки)\n  кому: ${m.to}\n  тема: ${m.subject}\n\n${m.text}`)
    const devMail = cfg.mail?.onDevMail ?? print
    const mail = new Mailer({
      ...cfg.mail,
      onDevMail: (m) => {
        tail.publish('mail', { to: m.to, subject: m.subject, text: m.text })
        devMail(m)
      },
    })
    const auth = new Auth(access, {
      ...cfg.auth,
      secret: cfg.auth?.secret ?? loadSecret(cfg.dataDir, env, warn),
      users: usersCfg && { schema: usersCfg.schema, indexes: usersCfg.indexes, hooks: usersCfg.hooks },
      mail,
      onError: (err, where) => onError(err, where),
    })
    const actions = new Actions(db, cfg.actions ?? [], { onError: (err, info) => onError(err, `действие ${info.name}`) })
    actions.onRun((r) => tail.publish('action', { name: r.name, user: r.userId, ms: Math.round(r.ms), ok: r.ok, code: r.code }))
    const bus = new Bus(db, cfg.handlers ?? (() => new Map()), { onError, tail })
    return {
      db,
      access,
      auth,
      actions,
      mail,
      tail,
      bus,
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

export type RunningServer = App & { url: string; adminToken: string; realtime: Realtime | null; stop: () => Promise<void> }

export async function startServer(cfg: ServerConfig): Promise<RunningServer> {
  const warn = cfg.onWarning ?? ((m: string) => console.warn(`[mabase] ${m}`))
  const app = await openApp(cfg)
  try {
    if (app.mail.mode === 'dev') warn('Почта не настроена: письма печатаются в консоль')
    const adminToken = randomBytes(32).toString('base64url')
    const handle = createHandler({ ...cfg.http, access: app.access, auth: app.auth, actions: app.actions, adminToken, tail: app.tail })
    let rt: Realtime | null = null
    if (cfg.realtime) {
      rt = new Realtime(app.access, app.auth, { events: cfg.events, tail: app.tail, onError: (err, where) => app.tail.publish('error', { where, error: String(err) }) })
      await rt.start()
    }
    const realtime = rt
    type WsData = { conn?: Conn }
    const server = Bun.serve<WsData, {}>({
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
    let stopped: Promise<void> | null = null
    return {
      ...app,
      url,
      adminToken,
      realtime,
      stop: () =>
        (stopped ??= (async () => {
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

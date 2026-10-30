// Запуск сервера: папка данных, секреты, база, доступ, вход, действия, HTTP.
//
//   <dataDir>/db/          база (design.md §6)
//   <dataDir>/secret.key   секрет подписи токенов, если нет MABASE_SECRET
//   <dataDir>/admin.token  токен /api/admin/* для CLI на этой машине, новый на каждый старт
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Access, type AccessDef, type ClientLimits } from './access'
import { Actions, type ActionDef } from './actions'
import { Auth, USERS, type AuthOptions } from './auth'
import { openDb, type CollectionDef, type Db, type DbOptions } from './db'
import { createHandler, type HttpOptions } from './http'
import { Mailer, type MailOptions } from './mail'

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
  env?: Record<string, string | undefined>
  onWarning?: (message: string) => void
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

export type RunningServer = { url: string; db: Db; access: Access; auth: Auth; actions: Actions; adminToken: string; stop: () => Promise<void> }

export async function startServer(cfg: ServerConfig): Promise<RunningServer> {
  const warn = cfg.onWarning ?? ((m: string) => console.warn(`[mabase] ${m}`))
  const env = cfg.env ?? process.env
  mkdirSync(cfg.dataDir, { recursive: true })
  const db = await openDb({ ...cfg.db, dir: join(cfg.dataDir, 'db'), onWarning: cfg.db?.onWarning ?? warn })
  try {
    const { [USERS]: usersCfg, ...others } = cfg.collections ?? {}
    const accessDefs: Record<string, AccessDef> = {}
    for (const [name, c] of Object.entries(others)) {
      db.collection(name, { schema: c.schema, indexes: c.indexes, hooks: c.hooks })
      accessDefs[name] = { rules: c.rules, fields: c.fields, owner: c.owner }
    }
    if (usersCfg) accessDefs[USERS] = { rules: usersCfg.rules, fields: usersCfg.fields }
    const access = new Access(db, accessDefs, cfg.limits)
    const mail = new Mailer(cfg.mail)
    if (mail.mode === 'dev') warn('Почта не настроена: письма печатаются в консоль')
    const auth = new Auth(access, {
      ...cfg.auth,
      secret: cfg.auth?.secret ?? loadSecret(cfg.dataDir, env, warn),
      users: usersCfg && { schema: usersCfg.schema, indexes: usersCfg.indexes, hooks: usersCfg.hooks },
      mail,
    })
    const actions = new Actions(db, cfg.actions ?? [])
    const adminToken = randomBytes(32).toString('base64url')
    const adminPath = join(cfg.dataDir, 'admin.token')
    writePrivate(adminPath, adminToken + '\n')
    const handle = createHandler({ ...cfg.http, access, auth, actions, adminToken })
    const server = Bun.serve({
      port: cfg.port ?? 8090,
      hostname: cfg.hostname,
      maxRequestBodySize: (cfg.http?.maxImportBytes ?? 256 << 20) + 1024,
      fetch: (req, srv) => handle(req, { ip: srv.requestIP(req)?.address }),
    })
    return {
      url: `http://${server.hostname === '0.0.0.0' ? 'localhost' : server.hostname}:${server.port}`,
      db,
      access,
      auth,
      actions,
      adminToken,
      stop: async () => {
        await server.stop()
        await auth.settled()
        await db.close()
      },
    }
  } catch (err) {
    await db.close()
    throw err
  }
}

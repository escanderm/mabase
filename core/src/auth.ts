// Пользователи и вход (design.md §11): пароль, токены, вход по телефону через
// authphone.su. Слой над ядром и Access: users - обычная коллекция с
// зарезервированными полями, сессии - документы системной коллекции _authTokens.
//
// Токены:
// - access - JWT (HS256) на 15 минут: { sub: id пользователя, sid: id сессии }.
//   Проверка смотрит, что сессия и пользователь ещё есть: выход, смена пароля
//   и удаление пользователя действуют сразу, а не через 15 минут. В памяти это
//   два поиска по _id;
// - refresh - `${sid}.${32 случайных байта}`. В базе только sha256. Каждое
//   обновление выдаёт новый токен, старый перестаёт работать.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { clientErrors, type Access } from './access'
import { parseDuration, type CollectionDef, type Db, type Doc, type Hooks, type TxApi, type User } from './db'
import { ActionError, DefinitionError } from './errors'
import type { Schema } from './schema'

export const USERS = 'users'
export const AUTH_TOKENS = '_authTokens'

const RESERVED = {
  email: z.string().optional(),
  phone: z.string().optional(),
  passwordHash: z.string().optional(),
  verified: z.boolean().default(false),
  roles: z.array(z.string()).default([]),
}
export const RESERVED_USER_FIELDS = Object.keys(RESERVED)

export type AuthProvider = 'password' | 'authphone'

export type AuthOptions = {
  secret: string // подпись JWT; из переменной окружения, не короче 32 символов
  providers?: AuthProvider[] // по умолчанию ['password']
  signup?: boolean // новый пользователь регистрируется сам (паролем или телефоном); по умолчанию да
  accessTtl?: number | string // '15m'
  refreshTtl?: number | string // '30d' от последнего обновления
  refreshGraceMs?: number // старый refresh-токен после обновления: до этого срока - 409, позже - сессия закрывается
  users?: CollectionDef // расширение встроенной users: схема z.object(...), индексы, хуки
  minPasswordLength?: number
  hashConcurrency?: number // одновременных хэшей argon2id; каждый берёт 64 МБ памяти
  loginLimit?: { attempts: number; windowMs: number } // на email или телефон вместе с IP
  authphone?: { url?: string; timeoutMs?: number }
  fetch?: (url: string, init: RequestInit) => Promise<Response> // для тестов
  now?: () => number
}

export type Session = {
  user: Doc // как его видит сам пользователь: без passwordHash
  accessToken: string
  accessExpiresAt: number // мс
  refreshToken: string
}

export type ClientInfo = { ip?: string }

const bad = (message: string) => new ActionError('bad_request', message)
const expired = () => new ActionError('unauthorized', 'Сессия закончилась, войдите снова')
const unavailable = () => new ActionError('unavailable', 'authphone.su не отвечает, попробуйте позже или войдите паролем')

export function normalizeEmail(v: unknown): string {
  if (typeof v !== 'string') throw bad('email - строка')
  const e = v.trim().toLowerCase()
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad('неверный email')
  return e
}

// Номер в E.164: +79991234567. Российские 89991234567, 79991234567 и
// 9991234567 приводятся к +7. С плюсом - как есть, без пробелов и скобок.
export function normalizePhone(v: unknown): string {
  if (typeof v !== 'string') throw bad('телефон - строка')
  const s = v.trim().replace(/[\s()\-.]/g, '')
  if (!/^\+?\d+$/.test(s)) throw bad('неверный номер телефона')
  let d = s.replace('+', '')
  if (!s.startsWith('+')) {
    if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = '7' + d.slice(1)
    else if (d.length === 10 && d[0] === '9') d = '7' + d
  }
  if (d.length < 10 || d.length > 15 || d[0] === '0') throw bad('неверный номер телефона')
  return '+' + d
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const b64 = (s: string) => Buffer.from(s).toString('base64url')
const JWT_HEADER = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))

function safeEqual(a: string, b: unknown): boolean {
  if (typeof b !== 'string' || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function parseRefresh(token: unknown): { sid: string; secret: string } | null {
  if (typeof token !== 'string' || token.length > 256) return null
  const dot = token.indexOf('.')
  if (dot < 1) return null
  return { sid: token.slice(0, dot), secret: token.slice(dot + 1) }
}

// Не больше max задач сразу, остальные ждут.
class Limiter {
  private active = 0
  private waiting: Array<() => void> = []
  constructor(private max: number) {}

  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r))
    else this.active++
    try {
      return await f()
    } finally {
      const next = this.waiting.shift()
      if (next) next() // место переходит следующему
      else this.active--
    }
  }
}

// Попытки входа на ключ (email или телефон + IP). Попытка считается до
// проверки: параллельные запросы не обойдут лимит. Удачный вход сбрасывает счёт.
class Attempts {
  private m = new Map<string, { n: number; until: number }>()
  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number,
  ) {}

  hit(key: string): void {
    const now = this.now()
    let e = this.m.get(key)
    if (!e || e.until <= now) {
      if (this.m.size > 10_000) for (const [k, v] of this.m) if (v.until <= now) this.m.delete(k)
      this.m.set(key, (e = { n: 0, until: now + this.windowMs }))
    }
    if (e.n >= this.max) throw new ActionError('too_many_requests', 'Слишком много попыток входа, попробуйте позже')
    e.n++
  }

  ok(key: string): void {
    this.m.delete(key)
  }
}

// Встроенная users плюс расширение из конфига. Зарезервированные поля
// приложение не объявляет: их задаёт MaBase.
function usersDef(def: CollectionDef): CollectionDef {
  let schema: Schema
  if (def.schema) {
    const s = def.schema as any
    if (!s.shape || typeof s.extend !== 'function') {
      throw new DefinitionError('users: схема - z.object(...), к ней добавятся зарезервированные поля')
    }
    const taken = RESERVED_USER_FIELDS.filter((f) => f in s.shape)
    if (taken.length) throw new DefinitionError(`users: поля ${taken.join(', ')} зарезервированы, их задаёт MaBase`)
    schema = s.extend(RESERVED)
  } else {
    schema = z.looseObject(RESERVED)
  }
  return { schema, indexes: [...new Set(['email', 'phone', ...(def.indexes ?? [])])], hooks: usersHooks(def.hooks ?? {}) }
}

// Хуки приложения - первыми, потом проверки MaBase: email и телефон приводятся
// к одному виду и уникальны, кто бы ни писал - клиент, действие или сид.
function usersHooks(h: Hooks): Hooks {
  return {
    ...h,
    beforeCreate: async (ctx) => {
      const r = h.beforeCreate ? await h.beforeCreate(ctx) : undefined
      return checkContacts(ctx.db, r && typeof r === 'object' ? (r as Doc) : ctx.doc, ctx.doc._id)
    },
    beforeUpdate: async (ctx) => {
      const r = h.beforeUpdate ? await h.beforeUpdate(ctx) : undefined
      return checkContacts(ctx.db, r && typeof r === 'object' ? (r as Doc) : ctx.next, ctx.prev._id, ctx.prev)
    },
    beforeDelete: async (ctx) => {
      await h.beforeDelete?.(ctx)
      await ctx.db.c[AUTH_TOKENS]!.removeMany({ userId: ctx.prev._id }) // сессии уходят вместе с пользователем
    },
  }
}

async function checkContacts(db: Db, doc: Doc, id: string, prev?: Doc): Promise<Doc> {
  const out: Doc = { ...doc }
  for (const [field, norm, taken] of [
    ['email', normalizeEmail, 'Этот email уже занят'],
    ['phone', normalizePhone, 'Этот номер уже занят'],
  ] as const) {
    if (out[field] === undefined || out[field] === null) {
      delete out[field]
      continue
    }
    out[field] = norm(out[field])
    if (prev && prev[field] === out[field]) continue
    const other = await db.c[USERS]!.findOne({ [field]: out[field], _id: { $ne: id } }, { fields: ['_id'] })
    if (other) throw new ActionError('conflict', taken)
  }
  return out
}

export class Auth {
  readonly db: Db
  private providers: Set<AuthProvider>
  private signup: boolean
  private accessMs: number
  private refreshMs: number
  private graceMs: number
  private minPassword: number
  private hashes: Limiter
  private attempts: Attempts
  private authphoneUrl: string
  private authphoneTimeout: number
  private fetch: NonNullable<AuthOptions['fetch']>
  private now: () => number
  private dummy: Promise<string> | null = null

  constructor(
    readonly access: Access,
    private readonly opts: AuthOptions,
  ) {
    if (typeof opts.secret !== 'string' || opts.secret.length < 32) {
      throw new TypeError('auth.secret: нужна строка не короче 32 символов, из переменной окружения')
    }
    this.db = access.db
    this.providers = new Set(opts.providers ?? ['password'])
    for (const p of this.providers) if (p !== 'password' && p !== 'authphone') throw new TypeError(`auth.providers: неизвестный способ входа ${p}`)
    this.signup = opts.signup ?? true
    this.accessMs = parseDuration(opts.accessTtl ?? '15m')
    this.refreshMs = parseDuration(opts.refreshTtl ?? '30d')
    this.graceMs = opts.refreshGraceMs ?? 30_000
    this.minPassword = opts.minPasswordLength ?? 8
    this.hashes = new Limiter(opts.hashConcurrency ?? 2)
    this.now = opts.now ?? Date.now
    const limit = opts.loginLimit ?? { attempts: 10, windowMs: 15 * 60_000 }
    this.attempts = new Attempts(limit.attempts, limit.windowMs, this.now)
    this.authphoneUrl = (opts.authphone?.url ?? 'https://authphone.su').replace(/\/$/, '')
    this.authphoneTimeout = opts.authphone?.timeoutMs ?? 5000
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init))
    this.db.collection(USERS, usersDef(opts.users ?? {}))
    this.db.collection(AUTH_TOKENS, { indexes: ['userId'] })
  }

  // ---------- для клиента: /api/auth/* ----------

  async register(input: { email: unknown; password: unknown; data?: unknown }, info: ClientInfo = {}): Promise<Session> {
    return clientErrors(async () => {
      this.requireProvider('password')
      if (!this.signup) throw new ActionError('forbidden', 'Регистрация закрыта')
      const email = normalizeEmail(input.email)
      const password = this.checkPassword(input.password)
      const data = input.data ?? {}
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw bad('data должен быть объектом')
      this.access.forUser(null).checkWrite(USERS, Object.keys(data), 'create')
      if (info.ip) this.attempts.hit(`signup:${info.ip}`) // без IP общий счётчик закрыл бы регистрацию всем
      const passwordHash = await this.hash(password) // до транзакции: 65 мс очередь записи не держат
      return this.db.transaction(async (tx) => {
        const user = await tx.c[USERS]!.insert({ ...data, email, passwordHash, verified: false, roles: [] })
        return this.startSession(tx, user, 'password')
      })
    })
  }

  async login(input: { email: unknown; password: unknown }, info: ClientInfo = {}): Promise<Session> {
    return clientErrors(async () => {
      this.requireProvider('password')
      const email = normalizeEmail(input.email)
      const invalid = new ActionError('invalid_credentials', 'Неверный email или пароль')
      if (typeof input.password !== 'string' || input.password.length > 256) throw invalid
      const key = `email:${email}|${info.ip ?? ''}`
      this.attempts.hit(key)
      const user = await this.db.c[USERS]!.findOne({ email })
      // Нет пользователя или пароля - хэш всё равно считается: по времени
      // ответа не понять, есть ли такой email.
      const ok = await this.verifyHash(input.password, user?.passwordHash ?? (await this.dummyHash()))
      if (!user?.passwordHash || !ok) throw invalid
      this.attempts.ok(key)
      return this.db.transaction(async (tx) => {
        const fresh = await tx.c[USERS]!.findOne({ _id: user._id })
        if (!fresh || fresh.passwordHash !== user.passwordHash) throw invalid // пароль сменили, пока проверяли
        await this.dropExpired(tx, fresh._id)
        return this.startSession(tx, fresh, 'password')
      })
    })
  }

  // Код запрашивает браузер прямо у authphone.su, проверяет сервер (design.md §11).
  async loginWithPhone(input: { phone: unknown; code: unknown }, info: ClientInfo = {}): Promise<Session> {
    return clientErrors(async () => {
      this.requireProvider('authphone')
      const phone = normalizePhone(input.phone)
      if (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) throw bad('код - 6 цифр')
      const key = `phone:${phone}|${info.ip ?? ''}`
      this.attempts.hit(key)
      if (!(await this.authphoneCheck(phone, input.code))) throw new ActionError('invalid_credentials', 'Неверный код')
      this.attempts.ok(key)
      return this.db.transaction(async (tx) => {
        let user = await tx.c[USERS]!.findOne({ phone })
        if (!user) {
          if (!this.signup) throw new ActionError('forbidden', 'Регистрация закрыта')
          user = await tx.c[USERS]!.insert({ phone, verified: false, roles: [] })
        }
        await this.dropExpired(tx, user._id)
        return this.startSession(tx, user, 'authphone')
      })
    })
  }

  // Новая пара токенов. Старый refresh-токен перестаёт работать.
  async refresh(token: unknown): Promise<Session> {
    return clientErrors(async () => {
      const t = parseRefresh(token)
      if (!t) throw expired()
      const now = this.now()
      const r = await this.db.transaction(async (tx) => {
        const s = await tx.c[AUTH_TOKENS]!.findOne({ _id: t.sid })
        if (!s || s.kind !== 'session' || s.expiresAt <= now) throw expired()
        const h = sha256(t.secret)
        if (!safeEqual(h, s.hash)) {
          if (!safeEqual(h, s.prevHash)) throw expired()
          // Прошлый токен этой сессии. Сразу после обновления - другая вкладка
          // обновилась первой: SDK возьмёт новый токен из хранилища. Позже -
          // токен утёк, и им пользуется кто-то ещё: сессия закрывается.
          if (now - s.rotatedAt <= this.graceMs) throw new ActionError('conflict', 'Токен уже обновлён, возьмите новый')
          await tx.c[AUTH_TOKENS]!.remove(s._id)
          return 'reused' as const
        }
        const user = await tx.c[USERS]!.findOne({ _id: s.userId })
        if (!user) throw expired()
        const secret = randomBytes(32).toString('base64url')
        await tx.c[AUTH_TOKENS]!.update(s._id, {
          $set: { hash: sha256(secret), prevHash: s.hash, rotatedAt: now, expiresAt: now + this.refreshMs },
        })
        return this.session(user, s._id, secret, now)
      })
      if (r === 'reused') throw expired() // закрытие сессии сохранено, клиенту - как обычный конец сессии
      return r
    })
  }

  // Закрыть сессию. Неизвестный токен - тоже успех: ничего не сообщаем.
  async logout(token: unknown): Promise<void> {
    const t = parseRefresh(token)
    if (!t) return
    await this.db.transaction(async (tx) => {
      const s = await tx.c[AUTH_TOKENS]!.findOne({ _id: t.sid })
      const h = sha256(t.secret)
      if (s?.kind === 'session' && (safeEqual(h, s.hash) || safeEqual(h, s.prevHash))) await tx.c[AUTH_TOKENS]!.remove(s._id)
    })
  }

  // Кто это: для HTTP-запроса и сокета. Токен неверный, истёк или сессию закрыли - null.
  async verify(token: unknown): Promise<User | null> {
    const p = this.readJwt(token)
    const now = this.now()
    if (!p || p.exp * 1000 <= now) return null
    const s = await this.db.c[AUTH_TOKENS]!.findOne({ _id: p.sid }, { fields: ['userId', 'expiresAt'] })
    if (!s || s.userId !== p.sub || s.expiresAt <= now) return null
    const user = await this.db.c[USERS]!.findOne({ _id: p.sub }, { fields: ['roles'] })
    if (!user) return null
    return Object.freeze({ id: user._id, roles: Object.freeze([...(user.roles ?? [])]) })
  }

  // Смена пароля закрывает все сессии пользователя, кроме новой.
  async changePassword(user: User | null, input: { oldPassword: unknown; newPassword: unknown }): Promise<Session> {
    return clientErrors(async () => {
      if (!user) throw new ActionError('unauthorized', 'Нужен вход')
      const password = this.checkPassword(input.newPassword)
      const doc = await this.db.c[USERS]!.findOne({ _id: user.id })
      if (!doc) throw expired()
      if (!doc.passwordHash) throw bad('У пользователя нет пароля: задать его можно через сброс по почте')
      const key = `password:${user.id}`
      this.attempts.hit(key)
      const old = input.oldPassword
      if (typeof old !== 'string' || old.length > 256 || !(await this.verifyHash(old, doc.passwordHash))) {
        throw new ActionError('invalid_credentials', 'Неверный текущий пароль')
      }
      this.attempts.ok(key)
      const passwordHash = await this.hash(password)
      return this.db.transaction(async (tx) => {
        const fresh = await tx.c[USERS]!.findOne({ _id: user.id })
        if (!fresh || fresh.passwordHash !== doc.passwordHash) throw new ActionError('conflict', 'Пароль уже изменён, войдите снова')
        const saved = await tx.c[USERS]!.update(user.id, { $set: { passwordHash } })
        await tx.c[AUTH_TOKENS]!.removeMany({ userId: user.id, kind: 'session' })
        return this.startSession(tx, saved, 'password')
      }, { user })
    })
  }

  // ---------- для сервера: сид, действия ----------

  // Создать или обновить пользователя по email (или телефону). Правил нет.
  // Пароль совпадает с сохранённым - хэш не меняется и сессии живут: сид
  // можно запускать на каждом старте.
  async upsertUser(input: { email?: string; phone?: string; password?: string; [field: string]: unknown }): Promise<Doc> {
    const { email, phone, password, ...rest } = input
    if ('passwordHash' in rest) throw new TypeError('upsertUser: передайте password, а не passwordHash')
    if (email === undefined && phone === undefined) throw new TypeError('upsertUser: нужен email или phone')
    const by = email !== undefined ? { email: normalizeEmail(email) } : { phone: normalizePhone(phone) }
    let passwordHash: string | undefined
    if (password !== undefined) {
      this.checkPassword(password)
      const found = await this.db.c[USERS]!.findOne(by)
      if (!found?.passwordHash || !(await this.verifyHash(password, found.passwordHash))) passwordHash = await this.hash(password)
    }
    const doc = await this.db.transaction(async (tx) => {
      const set = { ...rest, ...(email !== undefined && { email }), ...(phone !== undefined && { phone }), ...(passwordHash && { passwordHash }) }
      const found = await tx.c[USERS]!.findOne(by)
      if (!found) return tx.c[USERS]!.insert({ verified: false, roles: [], ...set })
      if (passwordHash) await tx.c[AUTH_TOKENS]!.removeMany({ userId: found._id, kind: 'session' })
      return tx.c[USERS]!.update(found._id, { $set: set })
    })
    return this.access.forUser({ id: doc._id }).strip(USERS, doc)
  }

  // Задать пароль (сброс, админ). Все сессии пользователя закрываются.
  async setPassword(userId: string, password: string): Promise<void> {
    const passwordHash = await this.hash(this.checkPassword(password))
    await this.db.transaction(async (tx) => {
      await tx.c[USERS]!.update(userId, { $set: { passwordHash } })
      await tx.c[AUTH_TOKENS]!.removeMany({ userId, kind: 'session' })
    })
  }

  async revokeSessions(userId: string): Promise<number> {
    return this.db.c[AUTH_TOKENS]!.removeMany({ userId, kind: 'session' })
  }

  // ---------- внутреннее ----------

  private requireProvider(p: AuthProvider): void {
    if (!this.providers.has(p)) throw new ActionError('forbidden', `Вход через ${p} выключен`)
  }

  private checkPassword(v: unknown): string {
    if (typeof v !== 'string') throw bad('пароль - строка')
    if (v.length < this.minPassword) throw bad(`пароль короче ${this.minPassword} символов`)
    if (v.length > 256) throw bad('пароль длиннее 256 символов')
    return v
  }

  private hash(password: string): Promise<string> {
    return this.hashes.run(() => Bun.password.hash(password, { algorithm: 'argon2id' }))
  }

  private verifyHash(password: string, hash: string): Promise<boolean> {
    return this.hashes.run(() => Bun.password.verify(password, hash))
  }

  private dummyHash(): Promise<string> {
    return (this.dummy ??= this.hash(randomBytes(16).toString('hex')))
  }

  private async startSession(tx: TxApi, user: Doc, provider: string): Promise<Session> {
    const now = this.now()
    const secret = randomBytes(32).toString('base64url')
    const s = await tx.c[AUTH_TOKENS]!.insert({ kind: 'session', userId: user._id, provider, hash: sha256(secret), expiresAt: now + this.refreshMs })
    return this.session(user, s._id, secret, now)
  }

  private session(user: Doc, sid: string, secret: string, now: number): Session {
    const exp = Math.floor((now + this.accessMs) / 1000)
    const accessToken = this.sign({ sub: user._id, sid, iat: Math.floor(now / 1000), exp })
    return {
      user: this.access.forUser({ id: user._id }).strip(USERS, user),
      accessToken,
      accessExpiresAt: exp * 1000,
      refreshToken: `${sid}.${secret}`,
    }
  }

  private async dropExpired(tx: TxApi, userId: string): Promise<void> {
    const old = await tx.c[AUTH_TOKENS]!.find({ userId, kind: 'session', expiresAt: { $lte: this.now() } }, { fields: ['_id'] })
    for (const s of old) await tx.c[AUTH_TOKENS]!.remove(s._id)
  }

  private hmac(s: string): string {
    return createHmac('sha256', this.opts.secret).update(s).digest('base64url')
  }

  private sign(payload: object): string {
    const body = `${JWT_HEADER}.${b64(JSON.stringify(payload))}`
    return `${body}.${this.hmac(body)}`
  }

  // Заголовок сравнивается целиком с нашим: alg "none" и подмена алгоритма не пройдут.
  private readJwt(token: unknown): { sub: string; sid: string; exp: number } | null {
    if (typeof token !== 'string' || token.length > 2048) return null
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== JWT_HEADER) return null
    if (!safeEqual(this.hmac(`${parts[0]}.${parts[1]}`), parts[2])) return null
    try {
      const p = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
      if (typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.exp !== 'number') return null
      return p
    } catch {
      return null
    }
  }

  // Ответ authphone.su получает сам сервер: ответу из браузера не верим.
  // Сеть, таймаут, 5xx или непонятный ответ - 503: неверным код не считается.
  private async authphoneCheck(phone: string, code: string): Promise<boolean> {
    let res: Response
    let body: any
    try {
      res = await this.fetch(`${this.authphoneUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone, code }),
        signal: AbortSignal.timeout(this.authphoneTimeout),
      })
      body = await res.json().catch(() => null)
    } catch {
      throw unavailable()
    }
    if (res.status >= 500 || (res.ok && !body)) throw unavailable()
    return res.ok && body.status === 'ok'
  }
}

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
import { Mailer, type LetterKind } from './mail'
import { exchangeCode, OAUTH_PROVIDERS, type OAuthClient, type OAuthProfile, type OAuthProviderName } from './oauth'
import type { Schema } from './schema'

export const USERS = 'users'
export const AUTH_TOKENS = '_authTokens'
export const EXTERNAL_AUTHS = '_externalAuths' // { provider, providerId, userId }: вход через Google и GitHub

const RESERVED = {
  email: z.string().optional(),
  phone: z.string().optional(),
  passwordHash: z.string().optional(),
  verified: z.boolean().default(false),
  roles: z.array(z.string()).default([]),
}
export const RESERVED_USER_FIELDS = Object.keys(RESERVED)

export type AuthProvider = 'password' | 'authphone' | OAuthProviderName

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
  oauth?: Partial<Record<OAuthProviderName, OAuthClient>> // ключи - из переменных окружения
  oauthFields?: (profile: OAuthProfile) => Record<string, unknown> // поля нового пользователя; по умолчанию { name }
  mail?: Mailer // нет - режим разработки: письма в консоль
  appUrl?: string // фронтенд: ссылки в письмах ведут сюда
  mailIntervalMs?: number // одно письмо одного вида пользователю не чаще; по умолчанию минута
  onError?: (err: unknown, where: string) => void // письмо сброса уходит в фоне
  fetch?: (url: string, init: RequestInit) => Promise<Response> // для тестов
  now?: () => number
}

// Что можно менять на ходу (настройки админки).
export type AuthSettings = Pick<AuthOptions, 'providers' | 'signup' | 'minPasswordLength' | 'oauth' | 'appUrl'>

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
const badLink = () => new ActionError('bad_request', 'Ссылка недействительна или устарела')

// Письма со ссылкой: вид токена в _authTokens, страница фронтенда, срок.
const LETTERS = {
  verify: { letter: 'verifyEmail', path: '/verify-email', ttl: 24 * 3_600_000 },
  reset: { letter: 'resetPassword', path: '/reset-password', ttl: 3_600_000 },
  email: { letter: 'changeEmail', path: '/confirm-email', ttl: 24 * 3_600_000 },
} as const satisfies Record<string, { letter: LetterKind; path: string; ttl: number }>
type TokenKind = keyof typeof LETTERS

// Смена пароля закрывает сессии и делает недействительными все ссылки из писем:
// сброс, подтверждение email и смену email. Ссылка смены email жила 24 часа и
// после сброса пароля оставалась рабочей: укравший сессию у аккаунта без
// пароля успевал увести email себе, а вместе с ним и аккаунт.
const PASSWORD_BOUND = { $in: ['session', 'reset', 'email', 'verify'] }

const OAUTH_STATE_MS = 10 * 60_000 // пользователь у провайдера
const OAUTH_CODE_MS = 60_000 // одноразовый код от колбэка до SDK
const OAUTH_PENDING_MAX = 10_000

const b64sha256 = (s: string) => createHash('sha256').update(s).digest('base64url')

// Чем закончился вход через провайдера - уходит во фронтенд после #.
class OAuthFail extends Error {
  constructor(public code: 'invalid_state' | 'denied' | 'provider_error' | 'signup_closed' | 'email_taken' | 'already_linked' | 'server_error') {
    super(code)
  }
}

type OAuthState = { provider: OAuthProviderName; verifier: string; redirectUri: string; challenge: string; userId: string | null; returnTo: string; expiresAt: number }
type OAuthCode = { userId: string; provider: OAuthProviderName; challenge: string; expiresAt: number }

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
export class Limiter {
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
export class Attempts {
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
  return { schema, indexes: [...new Set(['email', 'phone', ...(def.indexes ?? [])])], hooks: usersHooks(def.hooks ?? {}), relations: def.relations }
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
      await ctx.db.c[EXTERNAL_AUTHS]!.removeMany({ userId: ctx.prev._id })
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
  private providers!: Set<AuthProvider>
  private signup!: boolean
  private accessMs: number
  private refreshMs: number
  private graceMs: number
  private minPassword!: number
  private hashes: Limiter
  private attempts: Attempts // по аккаунту (email/телефон), независимо от IP
  private ipAttempts: Attempts // по IP, независимо от аккаунта: ротация адресов не снимает лимит
  private authphoneUrl: string
  private authphoneTimeout: number
  private fetch: NonNullable<AuthOptions['fetch']>
  private now: () => number
  private dummy: Promise<string> | null = null
  private oauth: Partial<Record<OAuthProviderName, OAuthClient>> = {}
  readonly mail: Mailer
  private appUrl!: string
  private mailIntervalMs: number
  private onError: (err: unknown, where: string) => void
  private background = new Set<Promise<void>>()
  private oauthStates = new Map<string, OAuthState>()
  private oauthCodes = new Map<string, OAuthCode>() // ключ - sha256 кода

  constructor(
    readonly access: Access,
    private readonly opts: AuthOptions,
  ) {
    if (typeof opts.secret !== 'string' || opts.secret.length < 32) {
      throw new TypeError('auth.secret: нужна строка не короче 32 символов, из переменной окружения')
    }
    this.db = access.db
    this.mail = opts.mail ?? new Mailer()
    this.configure(opts)
    this.accessMs = parseDuration(opts.accessTtl ?? '15m')
    this.refreshMs = parseDuration(opts.refreshTtl ?? '30d')
    this.graceMs = opts.refreshGraceMs ?? 30_000
    this.hashes = new Limiter(opts.hashConcurrency ?? 2)
    this.now = opts.now ?? Date.now
    const limit = opts.loginLimit ?? { attempts: 10, windowMs: 15 * 60_000 }
    // По аккаунту лимит мягче, чем по IP: иначе чужой человек с ботнета
    // закрывает вход владельцу на всё окно - это DoS на аккаунт. По IP - строго.
    this.attempts = new Attempts(Math.max(limit.attempts * 5, 20), limit.windowMs, this.now)
    this.ipAttempts = new Attempts(limit.attempts, limit.windowMs, this.now)
    this.authphoneUrl = (opts.authphone?.url ?? 'https://authphone.su').replace(/\/$/, '')
    this.authphoneTimeout = opts.authphone?.timeoutMs ?? 5000
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init))
    this.mailIntervalMs = opts.mailIntervalMs ?? 60_000
    this.onError = opts.onError ?? ((err, where) => console.error(`[mabase] ошибка в ${where}`, err))
    this.db.collection(USERS, usersDef(opts.users ?? {}))
    this.db.collection(AUTH_TOKENS, { indexes: ['userId'] })
    this.db.collection(EXTERNAL_AUTHS, { indexes: ['providerId', 'userId'] })
  }

  // Способы входа, регистрация, OAuth, адрес приложения. Из конфига при
  // старте или из настроек админки на ходу. Ошибка - ничего не меняется.
  configure(o: AuthSettings): void {
    const c = Auth.check(o, this.mail.mode)
    this.providers = c.providers
    this.signup = c.signup
    this.minPassword = c.minPassword
    this.oauth = c.oauth
    this.appUrl = c.appUrl
  }

  static check(o: AuthSettings, mailMode: Mailer['mode']) {
    const providers = new Set(o.providers ?? ['password'])
    for (const p of providers) {
      if (p === 'password' || p === 'authphone') continue
      if (!(p in OAUTH_PROVIDERS)) throw new TypeError(`auth.providers: неизвестный способ входа ${p}`)
      const c = o.oauth?.[p as OAuthProviderName]
      const title = p === 'github' ? 'GitHub' : p[0]!.toUpperCase() + p.slice(1)
      if (!c?.clientId || !c?.clientSecret) throw new TypeError(`${title}: нужны Client ID и Client Secret (auth.oauth.${p})`)
      if (!o.appUrl) throw new TypeError(`Нужен адрес приложения (auth.appUrl): туда вернётся пользователь после входа через ${title}`)
    }
    // В режиме разработки ссылка без адреса - путь; иначе ссылка из письма никуда не ведёт.
    if (mailMode !== 'dev' && !o.appUrl) throw new TypeError('Нужен адрес приложения (auth.appUrl): на него ведут ссылки из писем')
    const minPassword = o.minPasswordLength ?? 8
    if (!Number.isInteger(minPassword) || minPassword < 6 || minPassword > 128) throw new TypeError('auth.minPasswordLength: от 6 до 128')
    return { providers, signup: o.signup ?? true, minPassword, oauth: { ...o.oauth }, appUrl: (o.appUrl ?? '').replace(/\/$/, '') }
  }

  get settings(): Required<Pick<AuthSettings, 'providers' | 'signup' | 'minPasswordLength' | 'appUrl'>> {
    return { providers: [...this.providers], signup: this.signup, minPasswordLength: this.minPassword, appUrl: this.appUrl }
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
      if (info.ip) this.ipAttempts.hit(`signup:${info.ip}`) // без IP общий счётчик закрыл бы регистрацию всем
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
      this.hitLoginKeys(`email:${email}`, info.ip)
      const user = await this.db.c[USERS]!.findOne({ email })
      // Нет пользователя или пароля - хэш всё равно считается: по времени
      // ответа не понять, есть ли такой email.
      const ok = await this.verifyHash(input.password, user?.passwordHash ?? (await this.dummyHash()))
      if (!user?.passwordHash || !ok) throw invalid
      this.okLoginKeys(`email:${email}`, info.ip)
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
      this.hitLoginKeys(`phone:${phone}`, info.ip)
      if (!(await this.authphoneCheck(phone, input.code))) throw new ActionError('invalid_credentials', 'Неверный код')
      this.okLoginKeys(`phone:${phone}`, info.ip)
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
        await tx.c[AUTH_TOKENS]!.removeMany({ userId: user.id, kind: PASSWORD_BOUND })
        return this.startSession(tx, saved, 'password')
      }, { user })
    })
  }

  // ---------- письма: подтверждение email, сброс пароля, смена email ----------

  // Письмо со ссылкой подтверждения на email вошедшего пользователя.
  async requestVerification(user: User | null): Promise<void> {
    return clientErrors(async () => {
      if (!user) throw new ActionError('unauthorized', 'Нужен вход')
      const doc = await this.db.c[USERS]!.findOne({ _id: user.id })
      if (!doc) throw expired()
      if (!doc.email) throw bad('У пользователя нет email')
      if (doc.verified) throw bad('Email уже подтверждён')
      await this.sendLetter('verify', doc, doc.email)
    })
  }

  async confirmVerification(token: unknown): Promise<void> {
    return clientErrors(async () => {
      await this.db.transaction(async (tx) => {
        const { user } = await this.useToken(tx, 'verify', token)
        await tx.c[USERS]!.update(user._id, { $set: { verified: true } })
      })
    })
  }

  // Ответ всегда одинаковый и сразу: есть ли такой email, не узнать ни по
  // ответу, ни по времени. Письмо уходит в фоне, ошибки - в onError.
  async requestPasswordReset(input: { email: unknown }, info: ClientInfo = {}): Promise<void> {
    return clientErrors(async () => {
      this.requireProvider('password')
      const email = normalizeEmail(input.email)
      if (info.ip) this.attempts.hit(`reset:${info.ip}`)
      this.inBackground('requestPasswordReset', async () => {
        const doc = await this.db.c[USERS]!.findOne({ email })
        if (doc) await this.sendLetter('reset', doc, email, { quiet: true })
      })
    })
  }

  // Новый пароль по ссылке. Закрывает все сессии; email считается
  // подтверждённым - письмо дошло.
  async confirmPasswordReset(input: { token: unknown; password: unknown }): Promise<void> {
    return clientErrors(async () => {
      const password = this.checkPassword(input.password)
      await this.useToken(null, 'reset', input.token) // неверная ссылка - 400 без 65 мс на хэш
      const passwordHash = await this.hash(password)
      await this.db.transaction(async (tx) => {
        const { user } = await this.useToken(tx, 'reset', input.token)
        await tx.c[USERS]!.update(user._id, { $set: { passwordHash, verified: true } })
        await tx.c[AUTH_TOKENS]!.removeMany({ userId: user._id, kind: PASSWORD_BOUND })
      })
    })
  }

  // Письмо на новый адрес. Есть пароль - нужен пароль: украденная сессия не
  // должна уводить аккаунт сменой email. Вошёл по телефону без пароля -
  // добавляет email без него.
  async requestEmailChange(user: User | null, input: { newEmail: unknown; password?: unknown }): Promise<void> {
    return clientErrors(async () => {
      if (!user) throw new ActionError('unauthorized', 'Нужен вход')
      const email = normalizeEmail(input.newEmail)
      const doc = await this.db.c[USERS]!.findOne({ _id: user.id })
      if (!doc) throw expired()
      if (doc.email === email) throw bad('Это и есть текущий email')
      if (doc.passwordHash) {
        const key = `password:${user.id}`
        this.attempts.hit(key)
        const pw = input.password
        if (typeof pw !== 'string' || pw.length > 256 || !(await this.verifyHash(pw, doc.passwordHash))) {
          throw new ActionError('invalid_credentials', 'Неверный пароль')
        }
        this.attempts.ok(key)
      }
      if (await this.db.c[USERS]!.findOne({ email }, { fields: ['_id'] })) throw new ActionError('conflict', 'Этот email уже занят')
      await this.sendLetter('email', doc, email)
    })
  }

  // Email меняется, сессии закрываются: email - это логин.
  async confirmEmailChange(token: unknown): Promise<void> {
    return clientErrors(async () => {
      await this.db.transaction(async (tx) => {
        const { user, email } = await this.useToken(tx, 'email', token)
        await tx.c[USERS]!.update(user._id, { $set: { email, verified: true } })
        await tx.c[AUTH_TOKENS]!.removeMany({ userId: user._id, kind: { $in: ['session', 'reset', 'verify'] } })
      })
    })
  }

  // Дождаться писем, ушедших в фоне. Для тестов и остановки сервера.
  async settled(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background])
  }

  // ---------- вход через Google и GitHub ----------
  //
  // 1. oauthStart - адрес провайдера. Сервер создаёт state и свой PKCE-ключ
  //    (в памяти, 10 минут). SDK присылает challenge = sha256 своего verifier.
  // 2. oauthCallback - провайдер вернул браузер с code. Сервер сверяет state,
  //    сам меняет code на токен (секрет и PKCE-ключ знает только он), читает
  //    профиль и решает, кто это. Браузер уходит на appUrl с одноразовым
  //    кодом после # - в логи сервера и в Referer он не попадает.
  // 3. oauthExchange - SDK меняет код и свой verifier на токены. Код из
  //    адреса без verifier бесполезен. Токены в адресной строке не бывают.

  // user - вошедший пользователь: провайдер привяжется к нему.
  // returnTo - путь на appUrl, куда вернуть пользователя.
  oauthStart(provider: string, args: { redirectUri: string; challenge: unknown; returnTo?: unknown; user?: User | null }): { url: string } {
    const p = this.oauthProvider(provider)
    if (typeof args.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(args.challenge)) throw bad('challenge - sha256 в base64url')
    const returnTo = args.returnTo ?? '/'
    if (typeof returnTo !== 'string' || !/^\/(?![/\\])[^\s#]{0,511}$/.test(returnTo)) throw bad('returnTo - путь на appUrl, начиная с /')
    const now = this.now()
    for (const [k, v] of this.oauthStates) if (v.expiresAt <= now) this.oauthStates.delete(k)
    if (this.oauthStates.size >= OAUTH_PENDING_MAX) throw new ActionError('too_many_requests', 'Слишком много начатых входов, попробуйте позже')
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    this.oauthStates.set(state, {
      provider: p,
      verifier,
      redirectUri: args.redirectUri,
      challenge: args.challenge,
      userId: args.user?.id ?? null,
      returnTo,
      expiresAt: now + OAUTH_STATE_MS,
    })
    const d = OAUTH_PROVIDERS[p]
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.oauth[p]!.clientId,
      redirect_uri: args.redirectUri,
      scope: d.scopes.join(' '),
      state,
      code_challenge: b64sha256(verifier),
      code_challenge_method: 'S256',
    })
    return { url: `${d.authUrl}?${q}` }
  }

  // Ответ - куда отправить браузер: appUrl + returnTo + #mb_oauth=код или #mb_oauth_error=причина.
  async oauthCallback(provider: string, q: { code?: unknown; state?: unknown; error?: unknown }): Promise<{ redirect: string }> {
    const st = typeof q.state === 'string' ? this.oauthStates.get(q.state) : undefined
    if (st) this.oauthStates.delete(q.state as string) // state одноразовый
    const back = (hash: string) => ({ redirect: `${this.appUrl}${st?.returnTo ?? '/'}#${hash}` })
    try {
      if (!st || st.provider !== provider || st.expiresAt <= this.now()) throw new OAuthFail('invalid_state')
      if (q.error !== undefined || typeof q.code !== 'string' || !q.code) throw new OAuthFail('denied')
      const d = OAUTH_PROVIDERS[st.provider]
      let profile: OAuthProfile
      try {
        const signal = AbortSignal.timeout(10_000)
        const token = await exchangeCode(d, this.oauth[st.provider]!, { code: q.code, redirectUri: st.redirectUri, verifier: st.verifier }, this.fetch, signal)
        profile = await d.profile(token, this.fetch, signal)
      } catch (err) {
        this.onError(err, `oauth ${st.provider}`)
        throw new OAuthFail('provider_error')
      }
      const userId = await this.oauthUser(st.provider, profile, st.userId)
      const code = randomBytes(32).toString('base64url')
      const now = this.now()
      for (const [k, v] of this.oauthCodes) if (v.expiresAt <= now) this.oauthCodes.delete(k)
      this.oauthCodes.set(sha256(code), { userId, provider: st.provider, challenge: st.challenge, expiresAt: now + OAUTH_CODE_MS })
      return back(`mb_oauth=${code}`)
    } catch (err) {
      if (err instanceof OAuthFail) return back(`mb_oauth_error=${err.code}`)
      this.onError(err, `oauth ${provider}`)
      return back('mb_oauth_error=server_error')
    }
  }

  async oauthExchange(input: { code: unknown; verifier: unknown }): Promise<Session> {
    return clientErrors(async () => {
      const key = typeof input.code === 'string' ? sha256(input.code) : ''
      const c = this.oauthCodes.get(key)
      this.oauthCodes.delete(key) // одноразовый, даже если verifier неверный
      if (!c || c.expiresAt <= this.now()) throw bad('Код входа недействителен или устарел')
      if (typeof input.verifier !== 'string' || !safeEqual(b64sha256(input.verifier), c.challenge)) throw bad('Код входа недействителен или устарел')
      return this.db.transaction(async (tx) => {
        const user = await tx.c[USERS]!.findOne({ _id: c.userId })
        if (!user) throw expired()
        await this.dropExpired(tx, user._id)
        return this.startSession(tx, user, c.provider)
      })
    })
  }

  // Отвязать провайдера. Последний способ входа отвязать нельзя.
  async oauthUnlink(user: User | null, provider: string): Promise<void> {
    return clientErrors(async () => {
      if (!user) throw new ActionError('unauthorized', 'Нужен вход')
      await this.db.transaction(async (tx) => {
        const doc = await tx.c[USERS]!.findOne({ _id: user.id })
        if (!doc) throw expired()
        const links = await tx.c[EXTERNAL_AUTHS]!.find({ userId: user.id })
        const link = links.find((l) => l.provider === provider)
        if (!link) throw new ActionError('not_found', `${provider} не привязан`)
        if (!doc.passwordHash && !doc.phone && links.length === 1) throw bad('Это единственный способ входа: сначала задайте пароль или привяжите другой')
        await tx.c[EXTERNAL_AUTHS]!.remove(link._id)
      }, { user })
    })
  }

  // Кто это. По порядку: уже привязан; привязать к вошедшему; подтверждённый
  // у провайдера email есть у пользователя - привязать к нему; иначе -
  // новый пользователь.
  private async oauthUser(provider: OAuthProviderName, p: OAuthProfile, linkTo: string | null): Promise<string> {
    let email: string | undefined
    try {
      email = p.email === undefined ? undefined : normalizeEmail(p.email)
    } catch {}
    const verified = !!email && p.emailVerified
    return this.db.transaction(async (tx) => {
      const users = tx.c[USERS]!
      const ext = tx.c[EXTERNAL_AUTHS]!
      const link = await ext.findOne({ providerId: p.id, provider })
      if (linkTo) {
        if (link && link.userId !== linkTo) throw new OAuthFail('already_linked')
        if (!(await users.findOne({ _id: linkTo }, { fields: ['_id'] }))) throw new OAuthFail('invalid_state')
        if (!link) await ext.insert({ provider, providerId: p.id, userId: linkTo })
        return linkTo
      }
      if (link) return link.userId as string
      const same = email ? await users.findOne({ email }) : null
      if (same && verified) {
        // Захват заранее: кто-то зарегистрировался паролем на чужой email и
        // ждёт. Владелец адреса пришёл через провайдера - пароль чужака
        // стирается, его сессии закрываются.
        if (!same.verified) {
          await users.update(same._id, { $set: { verified: true }, $unset: { passwordHash: '' } })
          await tx.c[AUTH_TOKENS]!.removeMany({ userId: same._id, kind: PASSWORD_BOUND })
        }
        await ext.insert({ provider, providerId: p.id, userId: same._id })
        return same._id
      }
      // Неподтверждённый email у провайдера не привязывает и не занимает чужой адрес.
      if (same) throw new OAuthFail('email_taken')
      if (!this.signup) throw new OAuthFail('signup_closed')
      const fields: Record<string, unknown> = { ...(this.opts.oauthFields ?? ((x: OAuthProfile) => (x.name ? { name: x.name } : {})))(p) }
      for (const f of [...RESERVED_USER_FIELDS, '_id', '_createdAt', '_updatedAt']) delete fields[f]
      const user = await users.insert({ ...fields, ...(verified && { email }), verified, roles: [] })
      await ext.insert({ provider, providerId: p.id, userId: user._id })
      return user._id
    })
  }

  private oauthProvider(name: string): OAuthProviderName {
    if (!(name in OAUTH_PROVIDERS) || !this.providers.has(name as AuthProvider)) throw new ActionError('not_found', `Вход через ${name} выключен`)
    return name as OAuthProviderName
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
      if (passwordHash) await tx.c[AUTH_TOKENS]!.removeMany({ userId: found._id, kind: PASSWORD_BOUND })
      return tx.c[USERS]!.update(found._id, { $set: set })
    })
    return this.access.forUser({ id: doc._id }).strip(USERS, doc)
  }

  // Задать пароль (сброс, админ). Все сессии пользователя закрываются.
  async setPassword(userId: string, password: string): Promise<void> {
    const passwordHash = await this.hash(this.checkPassword(password))
    await this.db.transaction(async (tx) => {
      await tx.c[USERS]!.update(userId, { $set: { passwordHash } })
      await tx.c[AUTH_TOKENS]!.removeMany({ userId, kind: PASSWORD_BOUND })
    })
  }

  async revokeSessions(userId: string): Promise<number> {
    return this.db.c[AUTH_TOKENS]!.removeMany({ userId, kind: 'session' })
  }

  // Два счётчика на попытку входа: аккаунт и IP по отдельности. Одного ключа
  // "email+IP" мало: с одного адреса перебирается сколько угодно аккаунтов по
  // 10 попыток, а с ботнета - 10 попыток на адрес для одного аккаунта.
  private hitLoginKeys(account: string, ip?: string): void {
    this.attempts.hit(account)
    if (ip) this.ipAttempts.hit(`ip:${ip}`)
  }

  private okLoginKeys(account: string, ip?: string): void {
    this.attempts.ok(account)
    if (ip) this.ipAttempts.ok(`ip:${ip}`)
  }

  // ---------- внутреннее ----------

  // Ссылка из письма: токен в _authTokens (только sha256), прошлые ссылки
  // этого вида перестают работать. Письмо - после коммита, вне очереди
  // записи. Не ушло - токен удаляется, клиент получает 503 и просит ещё раз.
  // quiet: про "слишком часто" не сообщать (сброс пароля ничего не сообщает).
  private async sendLetter(kind: TokenKind, user: Doc, email: string, opts: { quiet?: boolean } = {}): Promise<void> {
    const now = this.now()
    const secret = randomBytes(32).toString('base64url')
    const id = await this.db.transaction(async (tx) => {
      const prev = await tx.c[AUTH_TOKENS]!.find({ userId: user._id, kind }, { fields: ['createdAt'] })
      if (prev.some((t) => now - t.createdAt < this.mailIntervalMs)) return null
      for (const t of prev) await tx.c[AUTH_TOKENS]!.remove(t._id)
      const t = await tx.c[AUTH_TOKENS]!.insert({ kind, userId: user._id, email, hash: sha256(secret), createdAt: now, expiresAt: now + LETTERS[kind].ttl })
      return t._id
    })
    if (!id) {
      if (opts.quiet) return
      throw new ActionError('too_many_requests', 'Письмо уже отправлено, следующее - через минуту')
    }
    const token = `${id}.${secret}`
    const link = `${this.appUrl}${LETTERS[kind].path}?token=${encodeURIComponent(token)}`
    try {
      await this.mail.send(this.mail.letter(LETTERS[kind].letter, { link, token, email, user: this.access.forUser({ id: user._id }).strip(USERS, user) }))
    } catch (err) {
      await this.db.c[AUTH_TOKENS]!.remove(id).catch(() => {})
      if (opts.quiet) throw err
      this.onError(err, `письмо ${kind}`)
      throw new ActionError('unavailable', 'Не удалось отправить письмо, попробуйте позже')
    }
  }

  // Проверить ссылку из письма. В транзакции - ещё и погасить: ссылка одноразовая.
  // Ссылка на адрес, который у пользователя уже не тот (кроме смены email), не работает.
  private async useToken(tx: TxApi | null, kind: TokenKind, token: unknown): Promise<{ user: Doc; email: string }> {
    const t = parseRefresh(token)
    if (!t) throw badLink()
    const c = tx ? tx.c : this.db.c
    const doc = await c[AUTH_TOKENS]!.findOne({ _id: t.sid })
    if (!doc || doc.kind !== kind || doc.expiresAt <= this.now() || !safeEqual(sha256(t.secret), doc.hash)) throw badLink()
    const user = await c[USERS]!.findOne({ _id: doc.userId })
    if (!user || (kind !== 'email' && user.email !== doc.email)) throw badLink()
    if (tx) await tx.c[AUTH_TOKENS]!.remove(doc._id)
    return { user, email: doc.email }
  }

  private inBackground(where: string, f: () => Promise<void>): void {
    const p = f()
      .catch((err) => this.onError(err, where))
      .finally(() => this.background.delete(p))
    this.background.add(p)
  }

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

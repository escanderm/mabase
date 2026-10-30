// Суперпользователи - вход в админку /_/ по email и паролю.
//
// - Отдельно от users: у приложения свои пользователи и правила, у админки -
//   свои. Суперпользователь видит и правит всё, мимо правил.
// - Первичная настройка: пока нет ни одного суперпользователя, сервер при
//   старте печатает одноразовую ссылку /_/#/install/<токен>. По ней создаётся
//   первый. Токен живёт в памяти до первого суперпользователя; новый старт -
//   новый токен. Без ссылки из консоли сервера создать первого нельзя.
// - Ещё способ: mabase superuser upsert <email> <пароль> на этой машине.
// - Сессия: токен `<id>.<секрет>`, в базе только sha256 секрета. Выход и
//   удаление суперпользователя закрывают его сессии сразу.
// - Коллекции _superusers и _superuserSessions без правил: через клиентский
//   API их не прочитать, админка их не показывает.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Attempts, Limiter, normalizeEmail } from './auth'
import { parseDuration, type Db, type Doc } from './db'
import { ActionError } from './errors'

export const SUPERUSERS = '_superusers'
export const SUPERUSER_SESSIONS = '_superuserSessions'

export type SuperuserOptions = {
  sessionTtl?: string // '7d'
  minPasswordLength?: number // 10
  loginLimit?: { attempts: number; windowMs: number } // 5 за 15 минут на email+IP
  now?: () => number
}

export type Superuser = { id: string; email: string }
export type SuperuserSession = { token: string; expiresAt: number; superuser: Superuser }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const invalid = () => new ActionError('invalid_credentials', 'Неверный email или пароль')

export class Superusers {
  private ttlMs: number
  private minPassword: number
  private hashes = new Limiter(1)
  private attempts: Attempts
  private now: () => number
  private dummy: Promise<string> | null = null
  private install: string | null = null

  constructor(
    private db: Db,
    opts: SuperuserOptions = {},
  ) {
    this.ttlMs = parseDuration(opts.sessionTtl ?? '7d')
    this.minPassword = opts.minPasswordLength ?? 10
    this.now = opts.now ?? Date.now
    const limit = opts.loginLimit ?? { attempts: 5, windowMs: 15 * 60_000 }
    this.attempts = new Attempts(limit.attempts, limit.windowMs, this.now)
    db.collection(SUPERUSERS, { indexes: ['email'] })
    db.collection(SUPERUSER_SESSIONS, { indexes: ['suId'] })
  }

  count(): Promise<number> {
    return this.db.c[SUPERUSERS]!.count()
  }

  async list(): Promise<(Superuser & { createdAt: number })[]> {
    const all = await this.db.c[SUPERUSERS]!.find({}, { fields: ['email', '_createdAt'] })
    return all.map((d) => ({ id: d._id, email: d.email, createdAt: d._createdAt }))
  }

  // Токен первичной настройки. Суперпользователь уже есть - null.
  async installToken(): Promise<string | null> {
    if ((await this.count()) > 0) return (this.install = null)
    return (this.install ??= randomBytes(24).toString('base64url'))
  }

  // Первый суперпользователь по ссылке из консоли. Сразу и вход.
  async setup(input: { token: unknown; email: unknown; password: unknown }): Promise<SuperuserSession> {
    const t = this.install
    if (!t || typeof input.token !== 'string' || !safeEqual(sha256(t), sha256(input.token))) {
      throw new ActionError('forbidden', 'Ссылка настройки недействительна: она печатается в консоли сервера при запуске, пока нет ни одного администратора')
    }
    const email = normalizeEmail(input.email)
    const hash = await this.hash(this.checkPassword(input.password))
    return this.db.transaction(async (tx) => {
      if ((await tx.c[SUPERUSERS]!.count()) > 0) throw new ActionError('conflict', 'Администратор уже создан - войдите')
      const su = await tx.c[SUPERUSERS]!.insert({ email, passwordHash: hash })
      this.install = null
      return this.startSession(tx.c, su)
    })
  }

  // Создать или сменить пароль. Смена пароля закрывает сессии.
  async upsert(emailIn: unknown, password: unknown): Promise<Superuser & { created: boolean }> {
    const email = normalizeEmail(emailIn)
    const hash = await this.hash(this.checkPassword(password))
    return this.db.transaction(async (tx) => {
      const found = await tx.c[SUPERUSERS]!.findOne({ email })
      if (found) {
        await tx.c[SUPERUSERS]!.update(found._id, { $set: { passwordHash: hash } })
        await tx.c[SUPERUSER_SESSIONS]!.removeMany({ suId: found._id })
      } else await tx.c[SUPERUSERS]!.insert({ email, passwordHash: hash })
      this.install = null
      const su = found ?? (await tx.c[SUPERUSERS]!.findOne({ email }))!
      return { id: su._id, email, created: !found }
    })
  }

  // Последнего не удаляем: иначе в админку не войти без консоли сервера.
  async remove(idOrEmail: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const su = await tx.c[SUPERUSERS]!.findOne({ $or: [{ _id: idOrEmail }, { email: idOrEmail.trim().toLowerCase() }] })
      if (!su) throw new ActionError('not_found', 'Нет такого администратора')
      if ((await tx.c[SUPERUSERS]!.count()) === 1) throw new ActionError('conflict', 'Это последний администратор - сначала создайте другого')
      await tx.c[SUPERUSER_SESSIONS]!.removeMany({ suId: su._id })
      await tx.c[SUPERUSERS]!.remove(su._id)
    })
  }

  async login(input: { email: unknown; password: unknown }, info: { ip?: string } = {}): Promise<SuperuserSession> {
    let email: string
    try {
      email = normalizeEmail(input.email)
    } catch {
      throw invalid()
    }
    if (typeof input.password !== 'string' || input.password.length > 256) throw invalid()
    const key = `${email}|${info.ip ?? ''}`
    this.attempts.hit(key)
    const su = await this.db.c[SUPERUSERS]!.findOne({ email })
    // Нет такого - хэш всё равно считаем: по времени ответа не понять, есть ли email
    const hash = su?.passwordHash ?? (await this.dummyHash())
    const ok = await this.hashes.run(() => Bun.password.verify(input.password as string, hash))
    if (!su || !ok) throw invalid()
    this.attempts.ok(key)
    return this.db.transaction(async (tx) => {
      const fresh = await tx.c[SUPERUSERS]!.findOne({ _id: su._id })
      if (!fresh || fresh.passwordHash !== su.passwordHash) throw invalid() // пароль сменили, пока проверяли
      const old = await tx.c[SUPERUSER_SESSIONS]!.find({ suId: su._id, expiresAt: { $lte: this.now() } }, { fields: ['_id'] })
      for (const s of old) await tx.c[SUPERUSER_SESSIONS]!.remove(s._id)
      return this.startSession(tx.c, fresh)
    })
  }

  // Кто это. Токен неверный, истёк, сессию закрыли - null.
  async verify(token: unknown): Promise<Superuser | null> {
    const t = parse(token)
    if (!t) return null
    const s = await this.db.c[SUPERUSER_SESSIONS]!.findOne({ _id: t.sid })
    if (!s || s.expiresAt <= this.now() || !safeEqual(s.hash, sha256(t.secret))) return null
    const su = await this.db.c[SUPERUSERS]!.findOne({ _id: s.suId }, { fields: ['email'] })
    return su ? { id: su._id, email: su.email } : null
  }

  async logout(token: unknown): Promise<void> {
    const t = parse(token)
    if (!t) return
    const s = await this.db.c[SUPERUSER_SESSIONS]!.findOne({ _id: t.sid })
    if (s && safeEqual(s.hash, sha256(t.secret))) await this.db.c[SUPERUSER_SESSIONS]!.remove(s._id).catch(() => {})
  }

  private async startSession(c: Db['c'], su: Doc): Promise<SuperuserSession> {
    const secret = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + this.ttlMs
    const s = await c[SUPERUSER_SESSIONS]!.insert({ suId: su._id, hash: sha256(secret), expiresAt })
    return { token: `${s._id}.${secret}`, expiresAt, superuser: { id: su._id, email: su.email } }
  }

  private checkPassword(v: unknown): string {
    if (typeof v !== 'string') throw new ActionError('bad_request', 'пароль - строка')
    if (v.length < this.minPassword) throw new ActionError('bad_request', `пароль короче ${this.minPassword} символов`)
    if (v.length > 256) throw new ActionError('bad_request', 'пароль длиннее 256 символов')
    return v
  }

  private hash(password: string): Promise<string> {
    return this.hashes.run(() => Bun.password.hash(password, { algorithm: 'argon2id' }))
  }

  private dummyHash(): Promise<string> {
    return (this.dummy ??= this.hash(randomBytes(16).toString('hex')))
  }
}

function parse(token: unknown): { sid: string; secret: string } | null {
  if (typeof token !== 'string' || token.length > 256) return null
  const dot = token.indexOf('.')
  return dot > 0 ? { sid: token.slice(0, dot), secret: token.slice(dot + 1) } : null
}

// mabase superuser list | upsert <email> <пароль> | delete <email> - и напрямую
// в базу, и через работающий сервер (POST /api/admin/superuser).
export async function superuserCommand(su: Superusers, b: { op?: unknown; email?: unknown; password?: unknown }): Promise<unknown> {
  if (b.op === 'list') return su.list()
  if (b.op === 'upsert') return su.upsert(b.email, b.password)
  if (b.op === 'delete' && typeof b.email === 'string') {
    await su.remove(b.email)
    return { deleted: b.email }
  }
  throw new ActionError('bad_request', 'op: list, upsert или delete')
}

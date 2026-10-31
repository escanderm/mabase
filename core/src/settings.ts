// Настройки из админки (design.md §11, §17): способы входа, почта и файлы
// (S3). Живут в базе (_settings), меняются без перезапуска.
//
// - Код главнее: если в mabase.config.ts есть раздел auth или mail, этот
//   раздел задан кодом, админка его только показывает.
// - Секреты (Client Secret, пароль SMTP) - в базе зашифрованными
//   AES-256-GCM. Ключ - из секрета сервера (MABASE_SECRET или
//   mb_data/secret.key): копия базы без секрета их не раскроет.
// - Наружу секреты не уходят никогда: в ответе только "задан / не задан".
//   Пустая строка при сохранении - "не менять".
// - Ошибка в настройках - ничего не меняется: и вход, и почта проверяются
//   до сохранения.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { Auth, type AuthProvider, type AuthSettings } from './auth'
import type { Db } from './db'
import { ActionError } from './errors'
import { S3Storage, type S3Options } from './files'
import { Mailer, type MailOptions } from './mail'

export const SETTINGS = '_settings'
const ID = 'app'

export type StoredSettings = {
  auth?: {
    password?: boolean
    signup?: boolean
    minPasswordLength?: number
    phone?: boolean
    google?: { enabled?: boolean; clientId?: string; clientSecret?: string }
    github?: { enabled?: boolean; clientId?: string; clientSecret?: string }
    appUrl?: string
  }
  mail?: {
    mode?: 'dev' | 'smtp'
    from?: string
    appName?: string
    smtp?: { host?: string; port?: number; secure?: boolean; user?: string; pass?: string }
  }
  // Нет s3 - файлы в локальной папке. Секреты шифруются, как у почты.
  storage?: {
    s3?: {
      bucket?: string
      region?: string
      accessKeyId?: string
      secretAccessKey?: string
      endpoint?: string
      prefix?: string
      forcePathStyle?: boolean
      sessionToken?: string
    }
  }
}

export type SettingsView = StoredSettings & { fixed: { auth: boolean; mail: boolean; storage: boolean } }

export type SettingsOptions = {
  // Применить хранилище файлов: null - локальная папка. Вызывается при старте
  // и после сохранения настроек (файлы переключаются без перезапуска).
  onStorage?: (s3: S3Options | null) => void
  // Что реально работает - для вида, когда раздел задан кодом.
  liveStorage?: () => S3Options | null
}

const OAUTH = ['google', 'github'] as const
const bad = (m: string) => new ActionError('bad_request', m)

export class Settings {
  private key: Buffer
  private current: StoredSettings = {}

  constructor(
    private db: Db,
    secret: string,
    private auth: Auth,
    private mail: Mailer,
    readonly fixed: { auth: boolean; mail: boolean; storage: boolean },
    private opts: SettingsOptions = {},
  ) {
    this.key = createHash('sha256').update(`mabase-settings:${secret}`).digest()
    db.collection(SETTINGS)
  }

  // При старте: применить сохранённое. Сломанные настройки не валят сервер -
  // остаются настройки по умолчанию и предупреждение.
  async load(warn: (m: string) => void): Promise<void> {
    const doc = await this.db.c[SETTINGS]!.findOne({ _id: ID })
    if (!doc) return
    const { _id, _createdAt, _updatedAt, ...stored } = doc
    this.current = this.decrypt(stored as StoredSettings)
    try {
      this.apply(this.current)
    } catch (err) {
      warn(`Настройки из админки не применились: ${(err as Error).message}. Работают настройки по умолчанию - поправьте в /_/ -> Настройки`)
    }
  }

  view(): SettingsView {
    const auth = { ...this.current.auth }
    for (const p of OAUTH) if (auth[p]) auth[p] = { ...auth[p], clientSecret: auth[p]!.clientSecret ? '***' : '' }
    const mail = { ...this.current.mail, smtp: this.current.mail?.smtp && { ...this.current.mail.smtp, pass: this.current.mail.smtp.pass ? '***' : '' } }
    const storage = this.fixed.storage ? this.liveStorageView() : maskStorage(this.current.storage)
    // Раздел задан кодом - показываем, что работает на самом деле
    const live = this.auth.settings
    return {
      fixed: this.fixed,
      auth: this.fixed.auth
        ? {
            password: live.providers.includes('password'),
            signup: live.signup,
            minPasswordLength: live.minPasswordLength,
            phone: live.providers.includes('authphone'),
            google: { enabled: live.providers.includes('google') },
            github: { enabled: live.providers.includes('github') },
            appUrl: live.appUrl,
          }
        : auth,
      mail: this.fixed.mail ? { mode: this.mail.mode === 'dev' ? 'dev' : 'smtp', appName: this.mail.appName } : mail,
      storage,
    }
  }

  async save(patch: StoredSettings): Promise<SettingsView> {
    if (!patch || typeof patch !== 'object') throw bad('настройки - объект')
    if (patch.auth && this.fixed.auth) throw new ActionError('conflict', 'Вход задан в mabase.config.ts - меняйте там')
    if (patch.mail && this.fixed.mail) throw new ActionError('conflict', 'Почта задана в mabase.config.ts - меняйте там')
    if (patch.storage && this.fixed.storage) throw new ActionError('conflict', 'Файлы (S3) заданы в mabase.config.ts или env - меняйте там')
    const next: StoredSettings = {
      auth: patch.auth ? clean(patch.auth, this.current.auth) : this.current.auth,
      mail: patch.mail ? cleanMail(patch.mail, this.current.mail) : this.current.mail,
      storage: patch.storage ? cleanStorage(patch.storage, this.current.storage) : this.current.storage,
    }
    try {
      this.apply(next) // проверка и применение; ошибка - ничего не поменялось
    } catch (err) {
      throw bad((err as Error).message)
    }
    await this.db.c[SETTINGS]!.upsert({ _id: ID }, this.encrypt(next) as Record<string, unknown>)
    this.current = next
    return this.view()
  }

  private apply(s: StoredSettings): void {
    const mailOpts = this.fixed.mail ? null : toMail(s.mail)
    const mailMode = mailOpts ? new Mailer(mailOpts).mode : this.mail.mode // new Mailer - проверка smtp
    const authOpts = this.fixed.auth ? null : toAuth(s.auth)
    if (authOpts) Auth.check(authOpts, mailMode)
    if (mailOpts) this.mail.configure(mailOpts)
    if (authOpts) this.auth.configure(authOpts)
    if (!this.fixed.storage) this.opts.onStorage?.(toStorage(s.storage))
  }

  private liveStorageView(): StoredSettings['storage'] {
    const s3 = this.opts.liveStorage?.()
    return s3 ? { s3: maskStorage({ s3 })?.s3 } : {}
  }

  private encrypt(s: StoredSettings): StoredSettings {
    return mapSecrets(s, (v) => {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', this.key, iv)
      const data = Buffer.concat([c.update(v, 'utf8'), c.final()])
      return `enc:v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${data.toString('base64url')}`
    })
  }

  private decrypt(s: StoredSettings): StoredSettings {
    return mapSecrets(s, (v) => {
      const m = /^enc:v1:([\w-]+):([\w-]+):([\w-]*)$/.exec(v)
      if (!m) return ''
      try {
        const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(m[1]!, 'base64url'))
        d.setAuthTag(Buffer.from(m[2]!, 'base64url'))
        return Buffer.concat([d.update(Buffer.from(m[3]!, 'base64url')), d.final()]).toString('utf8')
      } catch {
        return '' // секрет сервера сменили - секрет настроек не прочитать, задать заново
      }
    })
  }
}

function mapSecrets(s: StoredSettings, f: (v: string) => string): StoredSettings {
  const out: StoredSettings = structuredClone(s)
  for (const p of OAUTH) {
    const c = out.auth?.[p]
    if (c?.clientSecret) c.clientSecret = f(c.clientSecret)
  }
  if (out.mail?.smtp?.pass) out.mail.smtp.pass = f(out.mail.smtp.pass)
  const s3 = out.storage?.s3
  if (s3?.secretAccessKey) s3.secretAccessKey = f(s3.secretAccessKey)
  if (s3?.sessionToken) s3.sessionToken = f(s3.sessionToken)
  return out
}

function maskStorage(s: StoredSettings['storage']): StoredSettings['storage'] {
  if (!s?.s3) return s
  return { s3: { ...s.s3, secretAccessKey: s.s3.secretAccessKey ? '***' : '', sessionToken: s.s3.sessionToken ? '***' : '' } }
}

// Проверенная настройка S3: null - локальная папка.
export function toStorage(s: StoredSettings['storage'] = {}): S3Options | null {
  const p = s.s3
  if (!p) return null
  const opts: S3Options = {
    bucket: p.bucket ?? '',
    region: p.region ?? '',
    accessKeyId: p.accessKeyId ?? '',
    secretAccessKey: p.secretAccessKey ?? '',
    ...(p.endpoint && { endpoint: p.endpoint }),
    ...(p.prefix && { prefix: p.prefix }),
    ...(p.forcePathStyle !== undefined && { forcePathStyle: p.forcePathStyle }),
    ...(p.sessionToken && { sessionToken: p.sessionToken }),
  }
  new S3Storage(opts) // проверка: обязательные поля, endpoint
  return opts
}

// Секрет "***" или пусто - оставить прежний.
export function cleanStorage(s: NonNullable<StoredSettings['storage']>, prev: StoredSettings['storage'] = {}): StoredSettings['storage'] {
  if (!s.s3) return undefined // выключили - обратно в локальную папку
  const p = s.s3
  // Поле не пришло - берём прежнее; пришло пустым - значит очистили (для
  // обязательных это ошибка ниже). Секреты: '' и '***' - «не менять».
  const given = <T>(v: T | undefined, prev: T | undefined) => (v === undefined ? prev : v)
  const out = {
    bucket: given(p.bucket === undefined ? undefined : (str(p.bucket, 's3.bucket', 200) ?? ''), prev.s3?.bucket),
    region: given(p.region === undefined ? undefined : (str(p.region, 's3.region', 100) ?? ''), prev.s3?.region),
    accessKeyId: given(p.accessKeyId === undefined ? undefined : (str(p.accessKeyId, 's3.accessKeyId', 200) ?? ''), prev.s3?.accessKeyId),
    secretAccessKey: keepSecret(p.secretAccessKey, prev.s3?.secretAccessKey, 's3.secretAccessKey'),
    endpoint: given(p.endpoint === undefined ? undefined : (str(p.endpoint, 's3.endpoint', 300) ?? ''), prev.s3?.endpoint),
    prefix: given(p.prefix === undefined ? undefined : (str(p.prefix, 's3.prefix', 200) ?? ''), prev.s3?.prefix),
    forcePathStyle: p.forcePathStyle === undefined ? prev.s3?.forcePathStyle : !!p.forcePathStyle,
    sessionToken: keepSecret(p.sessionToken, prev.s3?.sessionToken, 's3.sessionToken'),
  }
  const storage = { s3: out }
  try {
    toStorage(storage) // ошибка с понятным текстом - до сохранения
  } catch (err) {
    throw bad((err as Error).message)
  }
  return storage
}

const str = (v: unknown, name: string, max = 500): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || v.length > max) throw bad(`${name}: строка до ${max} символов`)
  return v.trim()
}
const bool = (v: unknown, def: boolean) => (v === undefined ? def : !!v)

// Секрет "***" или пусто - оставить прежний.
const keepSecret = (v: unknown, prev: string | undefined, name: string) => (v === '***' || v === '' || v === undefined ? prev : str(v, name))

function clean(a: NonNullable<StoredSettings['auth']>, prev: StoredSettings['auth'] = {}): StoredSettings['auth'] {
  const min = a.minPasswordLength === undefined ? prev.minPasswordLength : Number(a.minPasswordLength)
  const appUrl = str(a.appUrl, 'appUrl')
  if (appUrl && !/^https?:\/\/[^\s/]+/.test(appUrl)) throw bad('appUrl: адрес вида https://my.app')
  const out: NonNullable<StoredSettings['auth']> = {
    password: bool(a.password, prev.password ?? true),
    signup: bool(a.signup, prev.signup ?? true),
    minPasswordLength: min,
    phone: bool(a.phone, prev.phone ?? false),
    appUrl,
  }
  for (const p of OAUTH) {
    const v = a[p]
    if (!v && !prev[p]) continue
    out[p] = {
      enabled: bool(v?.enabled, prev[p]?.enabled ?? false),
      clientId: v ? str(v.clientId, `${p}.clientId`) : prev[p]?.clientId,
      clientSecret: keepSecret(v?.clientSecret, prev[p]?.clientSecret, `${p}.clientSecret`),
    }
  }
  return out
}

function cleanMail(m: NonNullable<StoredSettings['mail']>, prev: StoredSettings['mail'] = {}): StoredSettings['mail'] {
  if (m.mode !== undefined && m.mode !== 'dev' && m.mode !== 'smtp') throw bad('mail.mode: dev или smtp')
  const out: NonNullable<StoredSettings['mail']> = { mode: m.mode ?? prev.mode ?? 'dev', from: str(m.from, 'from'), appName: str(m.appName, 'appName', 100) }
  if (m.smtp || prev.smtp) {
    const s = m.smtp ?? {}
    const port = s.port === undefined || (s.port as unknown) === '' ? prev.smtp?.port : Number(s.port)
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw bad('smtp.port: от 1 до 65535')
    out.smtp = {
      host: m.smtp ? str(s.host, 'smtp.host') : prev.smtp?.host,
      port,
      secure: s.secure === undefined ? prev.smtp?.secure : !!s.secure,
      user: m.smtp ? str(s.user, 'smtp.user') : prev.smtp?.user,
      pass: keepSecret(s.pass, prev.smtp?.pass, 'smtp.pass'),
    }
  }
  return out
}

export function toAuth(a: StoredSettings['auth'] = {}): AuthSettings {
  const providers: AuthProvider[] = []
  if (a.password ?? true) providers.push('password')
  if (a.phone) providers.push('authphone')
  const oauth: AuthSettings['oauth'] = {}
  for (const p of OAUTH) {
    const c = a[p]
    if (!c?.enabled) continue
    providers.push(p)
    oauth[p] = { clientId: c.clientId ?? '', clientSecret: c.clientSecret ?? '' }
  }
  return { providers, signup: a.signup ?? true, minPasswordLength: a.minPasswordLength, oauth, appUrl: a.appUrl }
}

function toMail(m: StoredSettings['mail'] = {}): MailOptions {
  const base = { from: m.from, appName: m.appName }
  if (m.mode !== 'smtp') return base
  if (!m.smtp?.host) throw new TypeError('почта: для SMTP нужен сервер (host)')
  return { ...base, smtp: { host: m.smtp.host, port: m.smtp.port, secure: m.smtp.secure, user: m.smtp.user, pass: m.smtp.pass } }
}

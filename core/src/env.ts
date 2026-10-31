// Настройки из окружения (design.md §5, §17): только то, что зависит от
// машины, - порт, папка, публичный адрес, секреты облака/почты/OAuth.
// Коллекции, правила, хуки и действия - код в mabase.config.ts, в env их нет.
//
// Приоритет: флаги CLI > env > mabase.config.ts > настройки админки > умолчания.
// Имена фиксированы: неизвестная MABASE_* - предупреждение, кривое значение -
// ошибка с именем переменной (а не загадочный отказ позже).
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { OAuthClient } from './oauth'
import type { SmtpOptions } from './mail'
import type { S3Options } from './files'

export type EnvStorage = { s3?: Partial<S3Options> }
export type EnvMail = { from?: string; smtp?: Partial<SmtpOptions> }
export type EnvAuth = { appUrl?: string; oauth?: Partial<Record<'google' | 'github', Partial<OAuthClient>>> }

export type EnvOverrides = {
  dir?: string
  port?: number
  host?: string
  publicDir?: string
  serverUrl?: string
  cors?: string[] | '*'
  secret?: string
  storage?: EnvStorage
  mail?: EnvMail
  auth?: EnvAuth
}

export type EnvResult = {
  overrides: EnvOverrides
  sources: Record<string, string> // ключ настройки -> имя переменной
  warnings: string[]
}

const KNOWN = [
  'MABASE_SECRET',
  'MABASE_DIR',
  'MABASE_PORT',
  'MABASE_HOST',
  'MABASE_PUBLIC',
  'MABASE_SERVER_URL',
  'MABASE_CORS',
  'MABASE_UPDATE_URL',
  'MABASE_S3_BUCKET',
  'MABASE_S3_REGION',
  'MABASE_S3_ACCESS_KEY_ID',
  'MABASE_S3_SECRET_ACCESS_KEY',
  'MABASE_S3_ENDPOINT',
  'MABASE_S3_PREFIX',
  'MABASE_S3_PATH_STYLE',
  'MABASE_S3_SESSION_TOKEN',
  'MABASE_SMTP_HOST',
  'MABASE_SMTP_PORT',
  'MABASE_SMTP_USER',
  'MABASE_SMTP_PASS',
  'MABASE_SMTP_SECURE',
  'MABASE_MAIL_FROM',
  'MABASE_APP_URL',
  'MABASE_GOOGLE_ID',
  'MABASE_GOOGLE_SECRET',
  'MABASE_GITHUB_ID',
  'MABASE_GITHUB_SECRET',
] as const

type Env = Record<string, string | undefined>

export function readEnv(env: Env = process.env): EnvResult {
  const warnings: string[] = []
  const sources: Record<string, string> = {}
  const get = (name: string): string | undefined => {
    const v = env[name]
    return v === undefined || v === '' ? undefined : v
  }
  const num = (name: string, min: number, max: number): number | undefined => {
    const raw = get(name)
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min || n > max) throw new TypeError(`${name}: нужно целое от ${min} до ${max}, а не "${raw}"`)
    return n
  }
  const bool = (name: string): boolean | undefined => {
    const raw = get(name)?.toLowerCase()
    if (raw === undefined) return undefined
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true
    if (['0', 'false', 'no', 'off'].includes(raw)) return false
    throw new TypeError(`${name}: нужно 1/0, true/false, yes/no (а не "${env[name]}")`)
  }
  const path = (name: string, base: string): string | undefined => {
    const raw = get(name)
    if (raw === undefined) return undefined
    return isAbsolute(raw) ? raw : resolve(base, raw)
  }

  // неизвестные MABASE_* - предупреждение: опечатка в имени не должна молчать
  for (const key of Object.keys(env)) {
    if (key.startsWith('MABASE_') && !(KNOWN as readonly string[]).includes(key) && key !== 'MABASE_UPDATE_URL') {
      if (!warnings.some((w) => w.includes(key))) warnings.push(`неизвестная переменная ${key} - проверьте имя (см. README, раздел «Настройки»)`)
    }
  }

  const out: EnvOverrides = {}
  const base = process.cwd()

  const secret = get('MABASE_SECRET')
  if (secret !== undefined) {
    if (secret.length < 32) throw new TypeError('MABASE_SECRET: не короче 32 символов')
    out.secret = secret
    sources.secret = 'MABASE_SECRET'
  }
  const dir = path('MABASE_DIR', base)
  if (dir) {
    if (!existsSync(dir) && !dir.endsWith('mb_data')) {
      // папку создаст сервер; предупреждаем только о явно неверном пути к существующей базе
      warnings.push(`MABASE_DIR=${dir}: папки пока нет, сервер её создаст`)
    }
    out.dir = dir
    sources.dir = 'MABASE_DIR'
  }
  const port = num('MABASE_PORT', 0, 65535)
  if (port !== undefined) {
    out.port = port
    sources.port = 'MABASE_PORT'
  }
  const host = get('MABASE_HOST')
  if (host) {
    out.host = host
    sources.host = 'MABASE_HOST'
  }
  const publicDir = path('MABASE_PUBLIC', base)
  if (publicDir) {
    out.publicDir = publicDir
    sources.public = 'MABASE_PUBLIC'
  }
  const serverUrl = get('MABASE_SERVER_URL')
  if (serverUrl) {
    out.serverUrl = serverUrl.replace(/\/$/, '')
    sources.serverUrl = 'MABASE_SERVER_URL'
  }
  const cors = get('MABASE_CORS')
  if (cors) {
    out.cors = cors.trim() === '*' ? '*' : cors.split(',').map((s) => s.trim()).filter(Boolean)
    sources.cors = 'MABASE_CORS'
  }

  // S3: собираем, если задано хоть что-то; частичная настройка - ошибка
  const s3: Partial<S3Options> = {}
  const s3Map: Array<[keyof S3Options, string]> = [
    ['bucket', 'MABASE_S3_BUCKET'],
    ['region', 'MABASE_S3_REGION'],
    ['accessKeyId', 'MABASE_S3_ACCESS_KEY_ID'],
    ['secretAccessKey', 'MABASE_S3_SECRET_ACCESS_KEY'],
    ['endpoint', 'MABASE_S3_ENDPOINT'],
    ['prefix', 'MABASE_S3_PREFIX'],
    ['sessionToken', 'MABASE_S3_SESSION_TOKEN'],
  ]
  for (const [field, name] of s3Map) {
    const v = get(name)
    if (v !== undefined) (s3 as any)[field] = v
  }
  const pathStyle = bool('MABASE_S3_PATH_STYLE')
  if (pathStyle !== undefined) s3.forcePathStyle = pathStyle
  if (Object.keys(s3).length) {
    // Частичная настройка допустима: остальное может быть в mabase.config.ts.
    // Полноту проверяет S3Storage при сборке (иначе ошибка была бы непонятной).
    const missing = ['bucket', 'region', 'accessKeyId', 'secretAccessKey'].filter((k) => !(s3 as any)[k])
    if (missing.length) {
      warnings.push(`S3 из env задан частично, нет ${missing.join(', ')} - должны быть в MABASE_S3_* или в mabase.config.ts`)
    }
    out.storage = { s3 }
    sources.storage = 'MABASE_S3_*'
  }

  // Почта: SMTP целиком из env или никак
  const smtp: Partial<SmtpOptions> = {}
  const smtpHost = get('MABASE_SMTP_HOST')
  if (smtpHost) smtp.host = smtpHost
  const smtpPort = num('MABASE_SMTP_PORT', 1, 65535)
  if (smtpPort !== undefined) smtp.port = smtpPort
  const smtpUser = get('MABASE_SMTP_USER')
  if (smtpUser) smtp.user = smtpUser
  const smtpPass = get('MABASE_SMTP_PASS')
  if (smtpPass) smtp.pass = smtpPass
  const smtpSecure = bool('MABASE_SMTP_SECURE')
  if (smtpSecure !== undefined) smtp.secure = smtpSecure
  const from = get('MABASE_MAIL_FROM')
  if (Object.keys(smtp).length || from) {
    if (Object.keys(smtp).length && !smtp.host) throw new TypeError('Почта: нужен MABASE_SMTP_HOST')
    out.mail = { ...(from !== undefined && { from }), ...(Object.keys(smtp).length && { smtp }) }
    sources.mail = 'MABASE_SMTP_*'
  }

  // Вход: адрес приложения и ключи провайдеров
  const auth: EnvAuth = {}
  const appUrl = get('MABASE_APP_URL')
  if (appUrl) auth.appUrl = appUrl.replace(/\/$/, '')
  const oauth: Partial<Record<'google' | 'github', Partial<OAuthClient>>> = {}
  for (const p of ['google', 'github'] as const) {
    const id = get(`MABASE_${p.toUpperCase()}_ID`)
    const secretKey = get(`MABASE_${p.toUpperCase()}_SECRET`)
    if (id === undefined && secretKey === undefined) continue
    if (!id || !secretKey) throw new TypeError(`${p}: нужны обе переменные MABASE_${p.toUpperCase()}_ID и MABASE_${p.toUpperCase()}_SECRET`)
    oauth[p] = { clientId: id, clientSecret: secretKey }
  }
  if (Object.keys(oauth).length) auth.oauth = oauth
  if (auth.appUrl !== undefined || auth.oauth) {
    out.auth = auth
    sources.auth = [auth.appUrl !== undefined && 'MABASE_APP_URL', auth.oauth && 'MABASE_GOOGLE_*/MABASE_GITHUB_*'].filter(Boolean).join(', ')
  }

  return { overrides: out, sources, warnings }
}

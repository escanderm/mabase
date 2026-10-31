// `mabase config`: итоговая конфигурация с источником каждого значения.
// Секреты не печатаются - только «есть» и откуда взяты. Смысл команды: когда
// порт, адрес или ключи «не те», видно, кто их задал - флаг, env, конфиг или
// умолчание (design.md §5, §17).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerConfig } from './server'

export type ConfigLine = { key: string; value: string; source: string }

const mask = (v: string | undefined) => (v ? '***' : '—')
const many = (list: string[], n = 6) => (list.length > n ? `${list.slice(0, n).join(', ')} … (${list.length})` : `${list.join(', ')} (${list.length})`)

export type ConfigViewOptions = { sources?: Record<string, string>; hooks?: string[] }

export function configView(cfg: ServerConfig, opts: ConfigViewOptions = {}): ConfigLine[] {
  const lines: ConfigLine[] = []
  const add = (key: string, value: string, source?: string) => lines.push({ key, value, source: source ?? '' })

  const src = opts.sources ?? {}
  add('папка данных', cfg.dataDir, src.dir)
  add('порт', String(cfg.port ?? 8090), src.port)
  add('хост', cfg.hostname ?? '0.0.0.0', src.host)
  if (cfg.http?.publicDir) add('статика', cfg.http.publicDir, src.public ?? 'config')
  add('публичный адрес', cfg.http?.serverUrl ?? '—', cfg.http?.serverUrl ? src.serverUrl ?? 'config' : 'не задан')
  add(
    'CORS',
    cfg.http?.cors === undefined ? 'только свой адрес' : Array.isArray(cfg.http.cors) ? cfg.http.cors.join(', ') : cfg.http.cors,
    cfg.http?.cors !== undefined ? src.cors ?? 'config' : 'по умолчанию',
  )

  const secretEnv = !!cfg.auth?.secret
  const secretFile = existsSync(join(cfg.dataDir, 'secret.key'))
  add('секрет подписи', secretEnv ? 'есть (env)' : secretFile ? 'есть (файл)' : 'будет создан', secretEnv ? src.secret ?? 'MABASE_SECRET' : secretFile ? 'mb_data/secret.key' : 'по умолчанию')

  const s3 = cfg.storage?.s3
  add(
    'файлы',
    s3 ? `S3 ${s3.bucket} @ ${s3.endpoint ?? 'aws'}${s3.prefix ? `/${s3.prefix}` : ''}, ключ ${mask(s3.secretAccessKey)}` : `локально ${join(cfg.dataDir, 'files')}`,
    s3 ? src.storage ?? 'config' : 'по умолчанию',
  )

  const smtp = cfg.mail?.smtp
  add(
    'почта',
    smtp ? `SMTP ${smtp.host}:${smtp.port ?? 587}${smtp.pass ? ', пароль ***' : ''}` : 'консоль (режим разработки)',
    smtp ? src.mail ?? 'config' : cfg.mail ? 'config' : 'по умолчанию',
  )
  if (cfg.mail?.from) add('письма от', cfg.mail.from, src.mail ?? 'config')

  const providers = cfg.auth?.providers ?? ['password']
  const oauth = Object.entries(cfg.auth?.oauth ?? {})
    .filter(([, v]) => v)
    .map(([p]) => p)
  add('вход', providers.join(', ') + (oauth.length ? `; OAuth: ${oauth.join(', ')}` : ''), src.auth ?? (cfg.auth ? 'config' : 'по умолчанию'))
  if (cfg.auth?.appUrl) add('адрес приложения', cfg.auth.appUrl, src.auth ?? 'config')

  const names = Object.keys(cfg.collections ?? {})
  add('коллекции', names.length ? many(names) : 'нет в коде (могут быть из админки)', names.length ? 'config' : '—')

  const hooks = opts.hooks ?? []
  add('хуки', hooks.length ? many(hooks) : 'нет', hooks.length ? 'mb_hooks/' : '—')

  if (cfg.limits) add('лимиты запросов', JSON.stringify(cfg.limits), 'config')
  if (cfg.db) add('база', JSON.stringify(cfg.db), 'config')
  if (cfg.scheduler) add('планировщик', JSON.stringify(cfg.scheduler), 'config')
  if (cfg.admin?.enabled === false) add('админка', 'выключена', 'config')
  return lines
}

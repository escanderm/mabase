// HTTP API (design.md §17) поверх Bun.serve, без фреймворка: путей мало.
// Обработчик - функция Request -> Response: тесты зовут её без сервера.
//
//   /api/health
//   /api/c/:collection          GET (filter, sort, limit, fields, count), POST
//   /api/c/:collection/:id      GET, PATCH ($set, $inc, ...), DELETE
//   /api/actions/:name          POST
//   /api/auth/*                 вход, токены, письма, OAuth
//   /api/admin/*                бэкап, компактирование, импорт: токен + localhost
//   всё остальное               статика фронтенда (publicDir), иначе 404
import { existsSync, realpathSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { clientErrors, type Access } from './access'
import { toClientError, type Actions } from './actions'
import { USERS, type Auth } from './auth'
import { parseExpand } from './expand'
import type { ByteRange, Upload } from './files'
import { importNdjson } from './import'
import { sdkBundle } from './sdk'
import type { User } from './db'
import { ActionError, ReadOnlyError, TxTimeoutError } from './errors'
import { adminAsset } from './admin/bundle'
import type { createAdminApi } from './admin-api'
import { superuserCommand, type Superusers } from './superusers'
import { tailResponse, type Tail } from './tail'

export type HttpOptions = {
  access: Access
  auth: Auth
  actions?: Actions
  serverUrl?: string // публичный адрес сервера - для колбэков OAuth; нет - из запроса
  cors?: string[] | '*' // откуда фронтенду можно ходить в API; нет - только свой адрес
  trustProxy?: boolean // IP клиента - последний в X-Forwarded-For (его дописал свой прокси)
  maxBodyBytes?: number // 1 МБ
  maxImportBytes?: number // импорт через admin: 256 МБ
  maxUploadBytes?: number // multipart-загрузка: 100 МБ
  adminToken?: string // /api/admin/*; нет - admin выключен
  tail?: Tail // GET /api/admin/tail - поток для mabase tail
  adminApi?: ReturnType<typeof createAdminApi> // /api/_/* и интерфейс /_/; нет - админки нет
  superusers?: Superusers // mabase superuser через работающий сервер
  publicDir?: string // статика; путь без расширения, которого нет, - index.html (SPA)
  onError?: (err: unknown, info: { method: string; path: string }) => void
}

export type RequestMeta = { ip?: string }

const RESERVED_PARAMS = new Set(['filter', 'sort', 'limit', 'fields', 'count', 'expand'])

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } })
const noContent = () => new Response(null, { status: 204 })
const bad = (message: string) => new ActionError('bad_request', message)

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

// Тело запроса не больше max байт: Content-Length не обязателен, считаем по потоку.
async function readBody(req: Request, max: number): Promise<string> {
  const len = Number(req.headers.get('content-length') ?? 0)
  if (len > max) throw new HttpError(413, 'too_large', `Тело запроса больше ${max} байт`)
  if (!req.body) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length
    if (size > max) throw new HttpError(413, 'too_large', `Тело запроса больше ${max} байт`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseJsonParam(v: string | null, name: string): unknown {
  if (v === null || v === '') return undefined
  try {
    return JSON.parse(v)
  } catch {
    throw bad(`${name}: не JSON`)
  }
}

const isLoopback = (ip: string | undefined) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

export function createHandler(opts: HttpOptions): (req: Request, meta?: RequestMeta) => Promise<Response> {
  const { access, auth } = opts
  const db = access.db
  const maxBody = opts.maxBodyBytes ?? 1 << 20
  const maxImport = opts.maxImportBytes ?? 256 << 20
  const maxUpload = opts.maxUploadBytes ?? 100 << 20
  const onError = opts.onError ?? ((err, info) => console.error(`[mabase] ${info.method} ${info.path}`, err))
  const logged = new WeakSet<object>() // ошибки действий Actions уже записал в журнал
  const publicDir = opts.publicDir && existsSync(opts.publicDir) ? realpathSync(opts.publicDir) : null

  function cors(req: Request): Record<string, string> {
    const origin = req.headers.get('origin')
    if (!origin || !opts.cors) return {}
    if (opts.cors !== '*' && !opts.cors.includes(origin)) return {}
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
  }

  function clientIp(req: Request, meta: RequestMeta): string | undefined {
    if (opts.trustProxy) {
      const xff = req.headers.get('x-forwarded-for')
      if (xff) return xff.split(',').at(-1)!.trim()
    }
    return meta.ip
  }

  // Ошибка -> ответ. Ожидаемые - с кодом и текстом; остальные - 500 без подробностей.
  function errorResponse(err: unknown, req: Request, path: string): Response {
    if (err instanceof HttpError) return json({ code: err.code, message: err.message }, err.status)
    if (err instanceof ActionError) {
      const e = toClientError(err)
      return json({ code: e.code, message: e.message, ...(e.details !== undefined && { details: e.details }) }, e.status)
    }
    if (!(err && typeof err === 'object' && logged.has(err))) onError(err, { method: req.method, path })
    // Таймаут транзакции и база "только чтение" - сервер не справился сейчас, а не запрос плохой.
    if (err instanceof TxTimeoutError || err instanceof ReadOnlyError) {
      return json({ code: 'unavailable', message: 'Сервер не успел выполнить запрос, повторите позже' }, 503)
    }
    return json({ code: 'internal', message: 'Внутренняя ошибка сервера' }, 500)
  }

  return async function handle(req: Request, meta: RequestMeta = {}): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method
    const extra = cors(req)
    if (method === 'OPTIONS' && Object.keys(extra).length) {
      return new Response(null, {
        status: 204,
        headers: {
          ...extra,
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
        },
      })
    }
    let res: Response
    try {
      if (path === '/api' || path.startsWith('/api/')) res = await api(req, url, meta)
      else if (opts.adminApi && (path === '/_' || path.startsWith('/_/'))) res = await adminAsset(req, path)
      else res = await staticFile(req, path)
    } catch (err) {
      res = errorResponse(err, req, path)
    }
    if (path.startsWith('/api/') && !res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'no-store')
    for (const [k, v] of Object.entries(extra)) res.headers.set(k, v)
    return res
  }

  async function api(req: Request, url: URL, meta: RequestMeta): Promise<Response> {
    const parts = url.pathname.slice('/api/'.length).split('/').map(decodeURIComponent)
    const method = req.method
    const route = `${method} ${parts[0] ?? ''}`

    // Пользователь по Authorization. Токен есть, но неверный или истёк - 401:
    // SDK обновит его, а не получит молча "ничего не видно" как гость.
    let userCache: Promise<User | null> | undefined
    const user = () =>
      (userCache ??= (async () => {
        const h = req.headers.get('authorization')
        if (!h) return null
        const m = /^Bearer (\S+)$/.exec(h)
        const u = m ? await auth.verify(m[1]) : null
        if (!u) throw new ActionError('unauthorized', 'Токен недействителен или истёк')
        return u
      })())

    const body = async (): Promise<any> => {
      const type = req.headers.get('content-type') ?? ''
      const text = await readBody(req, maxBody)
      if (text === '') return {}
      if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'unsupported_media_type', 'Нужен Content-Type: application/json')
      try {
        return JSON.parse(text)
      } catch {
        throw bad('Тело запроса - не JSON')
      }
    }

    // Тело записи: JSON или multipart/form-data. В multipart текстовые части -
    // поля документа (значение - JSON), файловые - в поля из collection.files.
    const parseBody = async (): Promise<{ doc: any; files: Record<string, Upload[]> }> => {
      const type = req.headers.get('content-type') ?? ''
      if (!/^multipart\/form-data/i.test(type)) return { doc: await body(), files: {} }
      const len = Number(req.headers.get('content-length') ?? 0)
      if (len > maxUpload) throw new HttpError(413, 'too_large', `Загрузка больше ${maxUpload} байт`)
      let form: FormData
      try {
        form = await req.formData()
      } catch {
        throw bad('Тело multipart не разобралось')
      }
      const doc: Record<string, unknown> = {}
      const files: Record<string, Upload[]> = {}
      // Форма может отдать и строку, и File: в типах Bun строки уже, приводим сами
      for (const [k, v] of form.entries() as IterableIterator<[string, string | File]>) {
        if (typeof v === 'string') {
          try {
            doc[k] = JSON.parse(v)
          } catch {
            doc[k] = v
          }
        } else {
          const bytes = new Uint8Array(await v.arrayBuffer())
          if (bytes.byteLength > maxUpload) throw new HttpError(413, 'too_large', `Файл ${v.name || ''} больше ${maxUpload} байт`)
          ;(files[k] ??= []).push({ name: v.name, type: v.type, bytes })
        }
      }
      return { doc, files }
    }

    if (route === 'GET health' && parts.length === 1) return json({ ok: true })
    if (route === 'GET client.js' && parts.length === 1) {
      return new Response(await sdkBundle(), { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' } })
    }

    if (parts[0] === 'files' && parts.length === 2 && (method === 'GET' || method === 'HEAD')) {
      const session = access.forUser(await user())
      const meta = await session.fileInfo(parts[1])
      const name = encodeURIComponent(meta.name)
      const disposition = url.searchParams.get('download') ? 'attachment' : 'inline'
      const base = {
        'Content-Type': meta.mime,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${name}`,
        'Cache-Control': 'private, max-age=300',
        'Accept-Ranges': 'bytes',
      }
      const range = parseRange(req.headers.get('range'), meta.size)
      if (range === 'invalid') {
        return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${meta.size}`, 'Content-Length': '0' } })
      }
      if (range) {
        const bytes = await session.readFile(meta, range)
        return new Response(method === 'HEAD' ? null : (bytes as unknown as BodyInit), {
          status: 206,
          headers: {
            ...base,
            'Content-Range': `bytes ${range.start}-${range.end}/${meta.size}`,
            'Content-Length': String(bytes.byteLength),
          },
        })
      }
      const bytes = method === 'HEAD' ? null : await session.readFile(meta)
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          ...base,
          'Content-Length': String(meta.size),
        },
      })
    }

    if (parts[0] === 'c' && parts[1]) {
      const c = parts[1]
      const coll = access.forUser(await user()).c[c]!
      if (parts.length === 2) {
        if (method === 'GET') {
          const q = url.searchParams
          const filter = parseJsonParam(q.get('filter'), 'filter') ?? {}
          if (q.get('count') === '1' || q.get('count') === 'true') return json({ count: await coll.count(filter) })
          const sort = parseJsonParam(q.get('sort'), 'sort') as Record<string, 1 | -1> | undefined
          const limitRaw = q.get('limit')
          const limit = limitRaw === null ? undefined : Number(limitRaw)
          if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw bad('limit: целое число больше 0')
          const fields = q.get('fields')?.split(',').filter(Boolean)
          for (const k of q.keys()) if (!RESERVED_PARAMS.has(k)) throw bad(`неизвестный параметр ${k}`)
          return json(await coll.list(filter, { sort, limit, fields, expand: parseExpand(q.get('expand')) }))
        }
        if (method === 'POST') {
          const { doc, files } = await parseBody()
          return json(await coll.insert(doc, { files }))
        }
        if (method === 'PATCH') {
          // Массовое обновление: без filter не бывает, как и у DELETE.
          const params = url.searchParams
          if (!params.has('filter')) throw bad('PATCH коллекции требует filter; одна запись - /api/c/:коллекция/:id')
          for (const k of params.keys()) if (k !== 'filter' && k !== 'limit') throw bad(`неизвестный параметр ${k}`)
          const filter = parseJsonParam(params.get('filter'), 'filter')
          const { doc, files } = await parseBody()
          if (Object.keys(files).length) throw bad('массовое обновление не принимает файлы: загрузите их через PATCH /:id')
          const limitRaw = params.get('limit')
          const limit = limitRaw === null ? undefined : Number(limitRaw)
          return json(await coll.updateMany(filter, doc, { limit }))
        }
        if (method === 'DELETE') {
          // Массовое удаление: только явным фильтром, чтобы ?filter= уронил случайную чистку.
          const params = url.searchParams
          if (!params.has('filter')) throw bad('DELETE коллекции требует filter; одна запись - /api/c/:коллекция/:id')
          for (const k of params.keys()) if (k !== 'filter' && k !== 'limit') throw bad(`неизвестный параметр ${k}`)
          const filter = parseJsonParam(params.get('filter'), 'filter')
          const limitRaw = params.get('limit')
          const limit = limitRaw === null ? undefined : Number(limitRaw)
          return json(await coll.removeMany(filter, { limit }))
        }
      }
      if (parts.length === 3) {
        const id = parts[2]!
        if (method === 'GET') {
          const q = url.searchParams
          return json(await coll.get(id, { fields: q.get('fields')?.split(',').filter(Boolean), expand: parseExpand(q.get('expand')) }))
        }
        if (method === 'PATCH') {
          const { doc, files } = await parseBody()
          return json(await coll.update(id, doc, { files }))
        }
        if (method === 'DELETE') {
          await coll.remove(id)
          return noContent()
        }
      }
      throw new HttpError(405, 'method_not_allowed', `${method} не поддерживается`)
    }

    if (route === 'POST actions' && parts.length === 2 && opts.actions) {
      const input = await body()
      try {
        return json(await opts.actions.run(parts[1]!, input, await user()))
      } catch (err) {
        if (err && typeof err === 'object') logged.add(err)
        throw err
      }
    }

    if (parts[0] === 'auth') return authRoute(req, url, parts.slice(1).join('/'), meta, user, body)
    if (parts[0] === 'admin' && opts.adminToken) return admin(req, parts.slice(1), meta)
    if (parts[0] === '_' && opts.adminApi) return opts.adminApi({ req, url, parts: parts.slice(1), ip: clientIp(req, meta), body })
    throw new HttpError(404, 'not_found', 'Нет такого адреса')
  }

  async function authRoute(
    req: Request,
    url: URL,
    sub: string,
    meta: RequestMeta,
    user: () => Promise<User | null>,
    body: () => Promise<any>,
  ): Promise<Response> {
    const info = { ip: clientIp(req, meta) }
    const m = req.method
    if (sub === 'providers' && req.method === 'GET') return json(auth.listProviders())
    const oauth = /^oauth\/([^/]+)(?:\/(start|callback))?$/.exec(sub)
    if (oauth && sub !== 'oauth/exchange') {
      const [, provider, step] = oauth as unknown as [string, string, string | undefined]
      if (m === 'POST' && step === 'start') {
        const b = await body()
        const base = (opts.serverUrl ?? url.origin).replace(/\/$/, '')
        const redirectUri = `${base}/api/auth/oauth/${encodeURIComponent(provider)}/callback`
        return json(auth.oauthStart(provider, { redirectUri, challenge: b.challenge, returnTo: b.returnTo, user: await user() }))
      }
      if (m === 'GET' && step === 'callback') {
        const q = url.searchParams
        const r = await auth.oauthCallback(provider, { code: q.get('code') ?? undefined, state: q.get('state') ?? undefined, error: q.get('error') ?? undefined })
        return new Response(null, { status: 302, headers: { Location: r.redirect } })
      }
      if (m === 'DELETE' && !step) {
        await auth.oauthUnlink(await user(), provider)
        return noContent()
      }
    }
    if (m === 'GET' && sub === 'me') {
      const u = await user()
      if (!u) throw new ActionError('unauthorized', 'Нужен вход')
      return json(await access.forUser(u).c[USERS]!.get(u.id))
    }
    if (m !== 'POST') throw new HttpError(404, 'not_found', 'Нет такого адреса')
    switch (sub) {
      case 'register':
        return json(await auth.register(await body(), info))
      case 'login':
        return json(await auth.login(await body(), info))
      case 'phone':
        return json(await auth.loginWithPhone(await body(), info))
      case 'refresh':
        return json(await auth.refresh((await body()).refreshToken))
      case 'logout':
        await auth.logout((await body()).refreshToken)
        return noContent()
      case 'password':
        return json(await auth.changePassword(await user(), await body()))
      case 'verify-email/request':
        await auth.requestVerification(await user())
        return noContent()
      case 'verify-email/confirm':
        await auth.confirmVerification((await body()).token)
        return noContent()
      case 'reset-password/request':
        await auth.requestPasswordReset(await body(), info)
        return noContent()
      case 'reset-password/confirm':
        await auth.confirmPasswordReset(await body())
        return noContent()
      case 'change-email/request':
        await auth.requestEmailChange(await user(), await body())
        return noContent()
      case 'change-email/confirm':
        await auth.confirmEmailChange((await body()).token)
        return noContent()
      case 'oauth/exchange':
        return json(await auth.oauthExchange(await body()))
    }
    throw new HttpError(404, 'not_found', 'Нет такого адреса')
  }

  // Только с этой машины и только с токеном из файла в папке данных: за
  // прокси на той же машине все запросы приходят с 127.0.0.1, одной
  // проверки адреса мало.
  async function admin(req: Request, parts: string[], meta: RequestMeta): Promise<Response> {
    const token = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
    if (!isLoopback(meta.ip) || !token || !safeEqualStr(token, opts.adminToken!)) throw new HttpError(404, 'not_found', 'Нет такого адреса')
    const [cmd, arg] = parts
    if (cmd === 'tail' && !arg && req.method === 'GET' && opts.tail) return tailResponse(opts.tail)
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Только POST')
    if (cmd === 'compact' && !arg) {
      await db.compact()
      return json({ tx: db.lastTx })
    }
    if (cmd === 'backup' && !arg) {
      let b: any
      try {
        b = JSON.parse((await readBody(req, maxBody)) || '{}')
      } catch {
        throw bad('Тело запроса - не JSON')
      }
      if (typeof b.dir !== 'string' || !b.dir) throw bad('dir - папка для бэкапа')
      return json(await db.backup(resolve(b.dir)))
    }
    if (cmd === 'superuser' && !arg && opts.superusers) {
      const text = await readBody(req, maxBody)
      return json(await clientErrors(async () => superuserCommand(opts.superusers!, JSON.parse(text || '{}'))))
    }
    // Импорт: NDJSON, пачками по 1000 в транзакции, мимо правил и лимитов.
    // Документ с _id, который уже есть, пропускается: повторный импорт безопасен.
    if (cmd === 'import' && arg) return json(await clientErrors(async () => importNdjson(db, arg, await readBody(req, maxImport))))
    throw new HttpError(404, 'not_found', 'Нет такого адреса')
  }

  async function staticFile(req: Request, path: string): Promise<Response> {
    if (!publicDir || (req.method !== 'GET' && req.method !== 'HEAD')) throw new HttpError(404, 'not_found', 'Нет такого адреса')
    let rel: string
    try {
      rel = decodeURIComponent(path)
    } catch {
      throw new HttpError(400, 'bad_request', 'Неверный адрес')
    }
    const file = resolve(join(publicDir, rel))
    if (file !== publicDir && !file.startsWith(publicDir + sep)) throw new HttpError(404, 'not_found', 'Нет такого адреса')
    if (existsSync(file) && statSync(file).isFile() && realpathSync(file).startsWith(publicDir + sep)) return new Response(Bun.file(file))
    const dirIndex = join(file, 'index.html')
    if (existsSync(dirIndex) && realpathSync(dirIndex).startsWith(publicDir + sep)) return new Response(Bun.file(dirIndex))
    // SPA: путь без расширения - страница приложения
    const index = join(publicDir, 'index.html')
    if (!extname(file) && existsSync(index)) return new Response(Bun.file(index))
    throw new HttpError(404, 'not_found', 'Нет такого файла')
  }
}

function safeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// Range: bytes=start-end | start- | -suffix. Несколько диапазонов не
// поддерживаем - отдаём файл целиком (так разрешает RFC 9110).
// 'invalid' - 416 (запрошен кусок за концом файла).
export function parseRange(header: string | null, size: number): ByteRange | 'invalid' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, a, b] = m
  if (a === '' && b === '') return null
  let start: number
  let end: number
  if (a === '') {
    // суффикс: последние N байт
    const n = Number(b)
    if (!n) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid'
  return { start, end }
}

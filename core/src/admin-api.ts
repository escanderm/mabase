// API админки /_/ (design.md §17): /api/_/*. Суперпользователь видит и правит
// всё мимо правил доступа, но хуки и схемы коллекций работают - как у импорта.
//
//   GET  setup                 нужна ли первичная настройка
//   POST setup                 первый суперпользователь по ссылке из консоли
//   POST login | logout        вход по email и паролю; GET me
//   GET  info                  сервер и коллекции
//   GET  c/:c                  поиск: filter, sort, fields, skip, limit -> items, total, explain
//   GET  c/:c/meta             индексы, схема zod, правила, виды полей
//   GET  c/:c/schema           что на самом деле лежит в документах (по выборке)
//   POST c/:c | PUT c/:c/:id | DELETE c/:c/:id | POST c/:c/delete-many
//   GET  tail                  живой журнал
//   POST backup | compact
//   GET|POST superusers, DELETE superusers/:id
//   GET|PUT settings           способы входа, почта, что есть в каждой коллекции
//   POST settings/test-mail    проверить почту
//   POST collections | PUT|DELETE collections/:c   коллекции из админки
//
// Скрытые поля (hidden, например passwordHash) админка не видит и не пишет:
// замена документа их сохраняет. _superusers и _superuserSessions здесь не
// показываются - для них свои адреса.
import { z } from 'zod'
import { clientErrors, type Access } from './access'
import type { Doc, Query } from './db'
import { ActionError } from './errors'
import { validateQuery } from './query'
import { SUPERUSER_SESSIONS, SUPERUSERS, type Superuser, type Superusers } from './superusers'
import type { Mailer } from './mail'
import { COLLECTIONS, type Registry } from './registry'
import { SETTINGS, type Settings, type StoredSettings } from './settings'
import { tailResponse, type Tail } from './tail'
import { VERSION } from './version'

export type AdminApiOptions = {
  access: Access
  superusers: Superusers
  settings: Settings
  registry: Registry
  mail: Mailer
  tail?: Tail
  startedAt?: number
}

type Req = { req: Request; url: URL; parts: string[]; ip?: string; body: () => Promise<any> }

// Свои адреса и формы: руками через документы не трогать
const HIDDEN_COLLECTIONS = new Set([SUPERUSERS, SUPERUSER_SESSIONS, SETTINGS, COLLECTIONS])
const SYSTEM = ['_id', '_createdAt', '_updatedAt']
const MAX_LIMIT = 1000
const bad = (m: string) => new ActionError('bad_request', m)
const json = (body: unknown, status = 200) => Response.json(body, { status })

export function createAdminApi(o: AdminApiOptions): (r: Req) => Promise<Response> {
  const db = o.access.db
  const su = o.superusers
  const startedAt = o.startedAt ?? Date.now()

  const hidden = (c: string) => o.access._def(c).hidden
  const strip = (c: string, d: Doc): Doc => {
    const h = hidden(c)
    if (!h.size) return d
    const out: Doc = { ...d }
    for (const f of h) delete out[f]
    return out
  }
  const collection = (c: string | undefined) => {
    if (!c || HIDDEN_COLLECTIONS.has(c)) throw new ActionError('not_found', 'Нет такой коллекции')
    return db.c[c]!
  }
  const checkFields = (c: string, doc: unknown): Record<string, unknown> => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad('документ - объект')
    for (const f of hidden(c)) if (f in (doc as object)) throw bad(`поле ${f} скрытое: админка его не пишет`)
    return doc as Record<string, unknown>
  }
  const by = (me: Superuser, op: string, fields: Record<string, unknown>) => o.tail?.publish('admin', { by: me.email, op, ...fields })

  return (r) =>
    clientErrors(async () => {
      const { req, url, parts } = r
      const m = req.method
      const [top, a, b, c3] = parts

      // ---------- без входа ----------
      if (top === 'setup' && !a) {
        if (m === 'GET') return json({ needed: (await su.count()) === 0 })
        if (m === 'POST') return json(await su.setup(await r.body()))
      }
      if (top === 'login' && !a && m === 'POST') return json(await su.login(await r.body(), { ip: r.ip }))

      // ---------- дальше - только суперпользователь ----------
      const token = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
      const me = token ? await su.verify(token) : null
      if (!me) throw new ActionError('unauthorized', 'Нужен вход администратора')

      if (top === 'logout' && !a && m === 'POST') {
        await su.logout(token)
        return new Response(null, { status: 204 })
      }
      if (top === 'me' && !a && m === 'GET') return json(me)

      if (top === 'info' && !a && m === 'GET') {
        const mem = process.memoryUsage()
        return json({
          version: VERSION,
          startedAt,
          uptimeMs: Date.now() - startedAt,
          memory: { rss: mem.rss, heapUsed: mem.heapUsed },
          db: db.stats,
          collections: db
            .inspect()
            .filter((x) => !HIDDEN_COLLECTIONS.has(x.name))
            .map(({ name, count, indexes, schema }) => ({ name, count, indexes, schema: !!schema, system: name.startsWith('_'), source: o.registry.source(name) })),
        })
      }

      if (top === 'tail' && !a && m === 'GET') {
        if (!o.tail) throw new ActionError('not_found', 'Журнал выключен')
        return tailResponse(o.tail)
      }
      if (top === 'compact' && !a && m === 'POST') {
        await db.compact()
        by(me, 'compact', {})
        return json({ tx: db.lastTx, ...db.stats })
      }
      if (top === 'backup' && !a && m === 'POST') {
        const { dir } = await r.body()
        if (typeof dir !== 'string' || !dir.startsWith('/')) throw bad('dir: абсолютный путь к папке на сервере')
        const res = await db.backup(dir)
        by(me, 'backup', { dir })
        return json(res)
      }

      if (top === 'settings') {
        if (!a && m === 'GET') return json(settingsView(url.origin))
        if (!a && m === 'PUT') {
          await o.settings.save((await r.body()) as StoredSettings)
          by(me, 'settings', {})
          return json(settingsView(url.origin))
        }
        if (a === 'test-mail' && m === 'POST') {
          const { to } = await r.body()
          if (typeof to !== 'string') throw bad('to: адрес получателя')
          try {
            await o.mail.send({ to, subject: `Проверка почты - ${o.mail.appName}`, text: 'Это проверочное письмо из админки MaBase. Раз оно дошло, почта настроена.\n' })
          } catch (err) {
            throw bad(`письмо не ушло: ${(err as Error).message}`)
          }
          return json({ mode: o.mail.mode })
        }
      }

      if (top === 'collections') {
        if (!a && m === 'POST') {
          const { name, indexes } = await r.body()
          await o.registry.create(name, indexes ?? [])
          by(me, 'collection.create', { c: name, indexes })
          return json({ name, source: o.registry.source(name) })
        }
        if (a && !b && m === 'PUT') {
          const { indexes } = await r.body()
          await o.registry.setIndexes(a, indexes)
          by(me, 'collection.indexes', { c: a, indexes })
          return json({ name: a, indexes })
        }
        if (a && !b && m === 'DELETE') {
          const deleted = await o.registry.drop(a)
          by(me, 'collection.drop', { c: a, deleted })
          return json({ deleted })
        }
      }

      if (top === 'superusers') {
        if (!a && m === 'GET') return json(await su.list())
        if (!a && m === 'POST') {
          const { email, password } = await r.body()
          const res = await su.upsert(email, password)
          by(me, res.created ? 'superuser.create' : 'superuser.password', { email: res.email })
          return json(res)
        }
        if (a && !b && m === 'DELETE') {
          await su.remove(a)
          by(me, 'superuser.delete', { id: a })
          return new Response(null, { status: 204 })
        }
      }

      if (top === 'c' && a) {
        const coll = collection(a)
        if (!b && m === 'GET') {
          const q = url.searchParams
          const filter = param(q, 'filter') ?? {}
          validateQuery(filter as Query)
          const sort = param(q, 'sort') as Record<string, 1 | -1> | undefined
          if (sort && !Object.values(sort).every((v) => v === 1 || v === -1)) throw bad('sort: { поле: 1 или -1 }')
          const fields = param(q, 'fields') as Record<string, 0 | 1> | undefined
          const skip = int(q.get('skip'), 0, 'skip')
          const limit = Math.min(int(q.get('limit'), 20, 'limit') || 20, MAX_LIMIT)
          const t0 = performance.now()
          const found = await coll.find(filter as Query, { sort, limit: skip + limit })
          const items = found.slice(skip).map((d) => project(strip(a, d), fields))
          const ms = performance.now() - t0
          const [total, explain] = await Promise.all([coll.count(filter as Query), coll.explain(filter as Query, { sort, limit: skip + limit })])
          return json({ items, total, explain, ms: Math.round(ms * 100) / 100 })
        }
        if (!b && m === 'POST') {
          const doc = await coll.insert(checkFields(a, await r.body()))
          by(me, 'insert', { c: a, id: doc._id })
          return json(strip(a, doc))
        }
        if (b === 'meta' && !c3 && m === 'GET') return json(meta(a))
        if (b === 'schema' && !c3 && m === 'GET') {
          const sample = Math.min(int(url.searchParams.get('sample'), 1000, 'sample') || 1000, 10_000)
          const total = await coll.count()
          const docs = (await coll.find({}, { sort: { _id: -1 }, limit: sample })).map((d) => strip(a, d))
          return json({ total, sampled: docs.length, fields: analyze(docs) })
        }
        if (b === 'delete-many' && !c3 && m === 'POST') {
          const { filter } = await r.body()
          if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw bad('filter - объект; удалить всё - filter: {}')
          validateQuery(filter)
          const deleted = await coll.removeMany(filter)
          by(me, 'delete-many', { c: a, filter, deleted })
          return json({ deleted })
        }
        if (b && !c3) {
          if (m === 'GET') {
            const d = await coll.findOne({ _id: b })
            if (!d) throw new ActionError('not_found', 'Нет такого документа')
            return json(strip(a, d))
          }
          // Замена целиком: что убрали из JSON - удаляется.
          // Скрытые и служебные поля не трогаем.
          if (m === 'PUT') {
            const next = checkFields(a, await r.body())
            if (next._id !== undefined && next._id !== b) throw bad('_id менять нельзя')
            const cur = await coll.findOne({ _id: b })
            if (!cur) throw new ActionError('not_found', 'Нет такого документа')
            const $set: Record<string, unknown> = {}
            const $unset: Record<string, ''> = {}
            for (const [k, v] of Object.entries(next)) if (!SYSTEM.includes(k)) $set[k] = v
            for (const k of Object.keys(strip(a, cur))) if (!SYSTEM.includes(k) && !(k in next)) $unset[k] = ''
            const update = { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) }
            const doc = Object.keys(update).length ? await coll.update(b, update) : cur
            by(me, 'replace', { c: a, id: b })
            return json(strip(a, doc))
          }
          if (m === 'DELETE') {
            await coll.remove(b)
            by(me, 'delete', { c: a, id: b })
            return new Response(null, { status: 204 })
          }
        }
      }
      throw new ActionError('not_found', 'Нет такого адреса')
    })

  function settingsView(origin: string) {
    return {
      ...o.settings.view(),
      callbacks: { google: `${origin}/api/auth/oauth/google/callback`, github: `${origin}/api/auth/oauth/github/callback` },
      db: { systemFields: SYSTEM_FIELDS_INFO, limits: o.access.limits, dir: db.stats.dir },
    }
  }

  // Что объявлено в конфиге: схема, индексы, правила (их исходный код), поля.
  function meta(c: string) {
    const info = db.inspect().find((x) => x.name === c)
    const def = o.access._def(c)
    let jsonSchema: unknown = null
    if (info?.schema) {
      try {
        jsonSchema = z.toJSONSchema(info.schema as z.ZodType, { unrepresentable: 'any' })
      } catch {}
    }
    const src = (f: unknown) => (typeof f === 'function' ? f.toString().slice(0, 4000) : f === undefined ? null : String(f))
    const rules = def.rules
    return {
      name: c,
      count: info?.count ?? 0,
      system: c.startsWith('_'),
      source: o.registry.source(c),
      indexes: info?.indexes ?? [],
      schema: jsonSchema,
      rules: { list: src(rules.list), view: src(rules.view), create: src(rules.create), update: src(rules.update), delete: src(rules.delete) },
      dependsOn: rules.dependsOn ?? [],
      owner: def.owner,
      fields: { readonly: [...def.readonly], immutable: [...def.immutable], private: [...def.private], hidden: [...def.hidden] },
    }
  }
}

// Что есть в каждой коллекции - для раздела "База" в настройках.
const SYSTEM_FIELDS_INFO = [
  { name: '_id', type: 'string', about: 'ULID: уникальный, по нему сортируется порядок создания. Можно задать свой строкой при вставке' },
  { name: '_createdAt', type: 'number', about: 'когда создан, мс с 1970 (Date.now()); ставит сервер' },
  { name: '_updatedAt', type: 'number', about: 'когда изменён последний раз, мс; ставит сервер' },
]

function param(q: URLSearchParams, name: string): Record<string, unknown> | undefined {
  const v = q.get(name)
  if (v === null || v === '') return undefined
  let p: unknown
  try {
    p = JSON.parse(v)
  } catch {
    throw bad(`${name}: не JSON`)
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad(`${name}: нужен объект`)
  return p as Record<string, unknown>
}

function int(v: string | null, def: number, name: string): number {
  if (v === null || v === '') return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw bad(`${name}: целое число от 0`)
  return n
}

// Проекция: { a: 1 } - только a (и _id), { a: 0 } - всё, кроме a.
function project(d: Doc, fields?: Record<string, 0 | 1>): Doc {
  if (!fields || !Object.keys(fields).length) return d
  const include = Object.entries(fields).filter(([, v]) => v)
  if (include.length) {
    const out: Doc = { _id: d._id }
    for (const [k] of include) if (k in d) out[k] = d[k]
    if (fields._id === 0) delete (out as any)._id
    return out
  }
  const out: Doc = { ...d }
  for (const k of Object.keys(fields)) delete out[k]
  return out
}

export type FieldStat = { path: string; count: number; types: Record<string, number>; examples: unknown[]; min?: number; max?: number }

// Что лежит в документах: поле -> сколько раз встретилось, каких типов,
// примеры значений. Вложенные объекты - через точку, элементы массивов - path[].
export function analyze(docs: Doc[]): FieldStat[] {
  const stats = new Map<string, FieldStat & { seen: Set<string> }>()
  const visit = (path: string, v: unknown, depth: number) => {
    let s = stats.get(path)
    if (!s) stats.set(path, (s = { path, count: 0, types: {}, examples: [], seen: new Set() }))
    s.count++
    const t = typeOf(v)
    s.types[t] = (s.types[t] ?? 0) + 1
    if (t === 'int' || t === 'double') {
      s.min = Math.min(s.min ?? Infinity, v as number)
      s.max = Math.max(s.max ?? -Infinity, v as number)
    }
    if (t !== 'object' && t !== 'array' && s.examples.length < 6) {
      const key = JSON.stringify(v)
      if (!s.seen.has(key)) {
        s.seen.add(key)
        s.examples.push(typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '...' : v)
      }
    }
    if (depth >= 4) return
    if (t === 'object') for (const [k, x] of Object.entries(v as object)) visit(`${path}.${k}`, x, depth + 1)
    if (t === 'array') for (const x of v as unknown[]) visit(`${path}[]`, x, depth + 1)
  }
  for (const d of docs) for (const [k, v] of Object.entries(d)) visit(k, v, 1)
  return [...stats.values()].map(({ seen, ...s }) => s).sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path))
}

const order = (p: string) => (p === '_id' ? 0 : p.startsWith('_') ? 2 : 1)

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double'
  return typeof v // string, boolean, object
}

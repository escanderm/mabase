// Доступ клиента к коллекциям (design.md §11): правила, виды полей, лимиты
// фильтров. Слой над ядром: серверный код (хуки, действия) идёт мимо него и
// ограничений не имеет. HTTP и сокет (шаги 7-8) работают только через него.
import { project, type CollectionApi, type Db, type Doc, type FindOptions, type Query, type Update, type User } from './db'
import { ActionError, NotFoundError, QueryError, ValidationError } from './errors'
import { expandDocs } from './expand'
import { FILES, type FileFields, type FileMeta, type FileStore, type Upload } from './files'
import { forbiddenSegment } from './paths'
import { ulid } from './ulid'
import { applyUpdate, SYSTEM_FIELDS, validateQuery, validateUpdate } from './query'

type Collections = Record<string, CollectionApi>
type Awaitable<T> = T | Promise<T>

// list и view возвращают фильтр (true - без ограничений) или false.
type FilterRule = false | ((user: User | null, ctx: { db: Collections }) => Awaitable<Query | boolean>)
type CheckRule<C> = false | ((user: User | null, ctx: C & { db: Collections }) => Awaitable<boolean>)

export type Rules = {
  list?: FilterRule
  view?: FilterRule
  create?: CheckRule<{ doc: Record<string, unknown> }>
  update?: CheckRule<{ before: Doc; after: Doc }>
  delete?: CheckRule<{ before: Doc }>
  // Коллекции, которые читает правило. Изменились - подписки пересчитают
  // фильтр (шаг 8). Пока только объявляются.
  dependsOn?: string[]
}

export type Fields = {
  readonly?: string[] // клиент не пишет никогда
  immutable?: string[] // клиент задаёт при создании, потом нет
  private?: string[] // видит только владелец записи
  hidden?: string[] // не уходит наружу никогда, даже владельцу
}

export type AccessDef = { rules?: Rules; fields?: Fields; owner?: string; files?: FileFields }

export type ClientLimits = {
  defaultLimit: number // limit не указан
  maxLimit: number
  maxScanned: number // документов на один запрос; больше - ошибка "добавьте индекс"
  maxRegexLength: number
}

const DEFAULT_LIMITS: ClientLimits = { defaultLimit: 100, maxLimit: 1000, maxScanned: 20_000, maxRegexLength: 64 }
const MAX_KEYS = 8 // полей в sort и fields на один клиентский запрос

type Resolved = {
  rules: Rules
  readonly: Set<string>
  immutable: Set<string>
  private: Set<string>
  hidden: Set<string>
  files: FileFields
  owner: string | null // поле с id владельца; у users - сама запись
}

// Встроенная users: зарезервированные поля и правила "каждый видит и правит себя".
const USERS_FIELDS: Required<Fields> = {
  readonly: ['email', 'phone', 'verified', 'roles'], // меняются только через вход и действия
  immutable: [],
  private: ['email', 'phone'],
  hidden: ['passwordHash'],
}
const USERS_RULES: Rules = {
  list: (user) => (user ? { _id: user.id } : false),
  view: (user) => (user ? { _id: user.id } : false),
  update: (user, { before }) => user?.id === before._id,
}

const bad = (message: string, details?: unknown) => new ActionError('bad_request', message, details)

// Путь, который клиент прислал в фильтре, сортировке, fields или в самом
// документе: имена прототипа - это не поля, а запись в Object.prototype.
function assertFieldPath(path: string, where: string): void {
  const forbidden = forbiddenSegment(path)
  if (forbidden) throw bad(`${where}: имя ${forbidden} в пути недопустимо`)
}

// Регулярное выражение от клиента: без групп, альтернатив и обратных ссылок.
// Повторов * и + - не больше двух, и не больше одного из них на '.': именно
// '.*a.*b' и подобное даёт квадратичный перебор на строке в 1 МБ - это минуты
// работы event loop, а таймаут транзакции не спасает, regexp синхронный.
// Два повтора по классам ('[a-z]+\d*') безопасны: группы и альтернативы
// запрещены, вложенных повторов не бывает.
export function checkClientRegex(pattern: string, maxLength: number): void {
  if (pattern.length > maxLength) throw bad(`$regex длиннее ${maxLength} символов`)
  let unbounded = 0
  let dotUnbounded = 0
  let prev = ''
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '\\') {
      if (/[1-9k]/.test(pattern[i + 1] ?? '')) throw bad('$regex: обратные ссылки не поддерживаются')
      i++
      prev = '' // экранированный символ - не точка и не класс
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      prev = ''
    } else if (ch === '(' || ch === ')') throw bad('$regex: группы не поддерживаются')
    else if (ch === '|') throw bad('$regex: альтернативы (|) не поддерживаются - используйте $in или $or')
    else if (ch === '*' || ch === '+') {
      unbounded++
      if (prev === '.') dotUnbounded++
    } else if (ch === '{' && /^\{\d+,\}/.test(pattern.slice(i))) {
      unbounded++
      if (prev === '.') dotUnbounded++
    } else prev = ch
  }
  if (dotUnbounded > 1) throw bad('$regex: больше одного повтора .* или .+ - перебор займёт процесс')
  if (unbounded > 2) throw bad('$regex: больше двух повторов * или + в одном выражении')
}

export type AccessOptions = {
  // mabase serve --dev: правило list/view читает коллекцию не из dependsOn -
  // предупредить. Иначе подписки не узнают, что доступ изменился (design.md §11).
  onRuleWarning?: (message: string) => void
  // Хранилище файлов; нет - поля-файлы и загрузка недоступны.
  files?: FileStore
}

export class Access {
  private defs = new Map<string, Resolved>()
  private warned = new Set<string>()
  readonly limits: ClientLimits

  constructor(
    readonly db: Db,
    defs: Record<string, AccessDef>,
    limits: Partial<ClientLimits> = {},
    readonly opts: AccessOptions = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    for (const [name, def] of Object.entries({ users: {}, ...defs })) this.defs.set(name, this.resolve(name, def))
  }

  private resolve(name: string, def: AccessDef): Resolved {
    const isUsers = name === 'users'
    const f = def.fields ?? {}
    const set = (k: keyof Fields) => new Set([...(isUsers ? USERS_FIELDS[k] : []), ...(f[k] ?? [])])
    const r: Resolved = {
      rules: def.rules ?? (isUsers ? USERS_RULES : {}),
      readonly: set('readonly'),
      immutable: set('immutable'),
      private: set('private'),
      hidden: set('hidden'),
      files: def.files ?? {},
      owner: isUsers ? '_id' : (def.owner ?? null),
    }
    for (const k of ['readonly', 'immutable', 'private', 'hidden'] as const) {
      for (const field of r[k]) {
        if (field.includes('.')) throw new TypeError(`${name}: fields.${k} - только поля верхнего уровня, "${field}" нельзя`)
        if ((SYSTEM_FIELDS as readonly string[]).includes(field)) throw new TypeError(`${name}: ${field} - служебное поле`)
      }
    }
    for (const [field, def] of Object.entries(r.files)) {
      if (field.includes('.')) throw new TypeError(`${name}: files.${field} - только поля верхнего уровня`)
      if ((SYSTEM_FIELDS as readonly string[]).includes(field)) throw new TypeError(`${name}: ${field} - служебное поле`)
      if (!def || typeof def !== 'object') throw new TypeError(`${name}: files.${field} - объект { maxBytes?, accept?, many? }`)
      if (def.maxBytes !== undefined && (!Number.isInteger(def.maxBytes) || def.maxBytes <= 0)) throw new TypeError(`${name}: files.${field}.maxBytes - целое больше нуля`)
      if (def.accept !== undefined && (!Array.isArray(def.accept) || !def.accept.every((a) => typeof a === 'string' && a))) {
        throw new TypeError(`${name}: files.${field}.accept - список mime-префиксов`)
      }
    }
    if (r.private.size && !r.owner) throw new TypeError(`${name}: fields.private требует owner - поле с id владельца`)
    // Владелец - не то поле, которое выбирает клиент: иначе private обходится
    // одним PATCH'ем ('$set': { ownerId: 'я' }) и приватное поле вернётся в ответе.
    // Задаёт его хук или действие.
    if (r.owner && !isUsers) {
      r.readonly.add(r.owner)
      r.immutable.add(r.owner)
    }
    const deps = r.rules.dependsOn ?? []
    if (!Array.isArray(deps) || !deps.every((d) => typeof d === 'string' && d)) throw new TypeError(`${name}: dependsOn - список коллекций`)
    return r
  }

  // Коллекции, правила которых читают c: изменение c меняет их фильтры.
  dependents(c: string): string[] {
    return [...this.defs].filter(([, d]) => d.rules.dependsOn?.includes(c)).map(([name]) => name)
  }

  // Один пользователь, один запрос: результаты list/view кэшируются на всё время сессии.
  forUser(user: User | null): ClientSession {
    return new ClientSession(this, user ? Object.freeze({ ...user }) : null)
  }

  // Коллекции, которые правило прочитает через этот db, - на проверку dependsOn.
  /** @internal */ watch(c: string, kind: string, db: Collections): Collections {
    const warn = this.opts.onRuleWarning
    if (!warn) return db
    const deps = new Set(this._def(c).rules.dependsOn ?? [])
    return new Proxy(db, {
      get: (target, name) => {
        if (typeof name === 'string' && name !== c && !deps.has(name)) {
          const key = `${c}.${kind}:${name}`
          if (!this.warned.has(key)) {
            this.warned.add(key)
            warn(
              `Правило ${c}.${kind} читает коллекцию ${name}, а в dependsOn её нет. ` +
                `Подписки на ${c} не узнают, что доступ изменился из-за ${name}: добавьте dependsOn: ['${name}']`,
            )
          }
        }
        return (target as any)[name]
      },
    })
  }

  _def(c: string): Resolved {
    return this.defs.get(c) ?? this.resolve(c, {}) // нет описания - нет правил - доступа нет
  }
}

export class ClientSession {
  private cache = new Map<string, Promise<Query>>()
  readonly c: Record<string, ClientCollection>

  constructor(
    readonly access: Access,
    readonly user: User | null,
  ) {
    this.c = new Proxy({} as Record<string, ClientCollection>, {
      get: (_, name) => (typeof name === 'string' ? new ClientCollection(this, name) : undefined),
    })
  }

  // _expand через правило view целевой коллекции и её виды полей: по связи
  // видно ровно то, что клиент увидел бы, читая ту коллекцию сам.
  async expand(c: string, docs: Doc[], fields?: string[]): Promise<Doc[]> {
    if (!fields?.length) return docs
    for (const f of fields) this.checkField(c, f, 'expand')
    await expandDocs(docs, fields, this.access.db.relations(c), async (to, ids) => {
      let rule: Query
      try {
        rule = await this.ruleFilter(to, 'view')
      } catch (err) {
        if (err instanceof ActionError) return [] // нет доступа к той коллекции - ничего не подтягиваем
        throw err
      }
      return (await this.access.db.c[to]!.find(and(rule, { _id: { $in: ids } }))).map((d) => this.strip(to, d))
    })
    return docs
  }

  deny(): ActionError {
    return this.user ? new ActionError('forbidden', 'Нет доступа') : new ActionError('unauthorized', 'Нужен вход')
  }

  // Фильтр правила list или view. db - где читает правило: база или транзакция записи.
  async ruleFilter(c: string, kind: 'list' | 'view', db?: Collections): Promise<Query> {
    const compute = async () => {
      const rule = this.access._def(c).rules[kind]
      if (!rule) throw this.deny()
      const r = await rule(this.user, { db: this.access.watch(c, kind, db ?? this.access.db.c) })
      if (r === false || r === null || r === undefined) throw this.deny()
      if (r === true) return {}
      validateQuery(r)
      return r
    }
    if (db) return compute() // внутри записи - всегда свежий
    const key = `${c}\0${kind}`
    let p = this.cache.get(key)
    if (!p) this.cache.set(key, (p = compute()))
    return p
  }

  async check<K extends 'create' | 'update' | 'delete'>(c: string, kind: K, ctx: any): Promise<void> {
    const rule = this.access._def(c).rules[kind] as CheckRule<any> | undefined
    if (!rule || !(await rule(this.user, ctx))) throw this.deny()
  }

  isOwner(c: string, doc: Doc): boolean {
    const owner = this.access._def(c).owner
    return !!this.user && !!owner && doc[owner] === this.user.id
  }

  // Убрать то, что этому пользователю не положено видеть.
  strip(c: string, doc: Doc, fields?: string[]): Doc {
    const d = this.access._def(c)
    const out: Doc = { ...doc }
    for (const f of d.hidden) delete out[f]
    if (!this.isOwner(c, doc)) for (const f of d.private) delete out[f]
    return fields ? project(out, fields) : out
  }

  // Поле, которое клиент упоминает в фильтре, сортировке или fields, должно быть ему видно.
  // private закрыто и владельцу: фильтр шёл бы по чужим записям.
  // Путь через прототип (__proto__, constructor) - не поле документа: отказ.
  checkField(c: string, path: string, where: string): void {
    const d = this.access._def(c)
    assertFieldPath(path, where)
    const root = path.split('.')[0]!
    if (d.hidden.has(root) || d.private.has(root)) throw bad(`${where}: поле ${root} недоступно`)
  }

  checkFilter(c: string, filter: unknown): asserts filter is Query {
    try {
      validateQuery(filter)
    } catch (err) {
      throw err instanceof QueryError ? bad(err.message) : err
    }
    const max = this.access.limits.maxRegexLength
    const regex = (v: unknown): void => {
      if (v instanceof RegExp) checkClientRegex(v.source, max)
      else if (Array.isArray(v)) v.forEach(regex)
      else if (v && typeof v === 'object') {
        for (const [op, x] of Object.entries(v)) {
          if (op === '$regex') checkClientRegex(x instanceof RegExp ? x.source : String(x), max)
          else if (op === '$not' || op === '$in' || op === '$nin') regex(x)
        }
      }
    }
    const walk = (q: Query) => {
      for (const [k, v] of Object.entries(q)) {
        if (k === '$and' || k === '$or') (v as Query[]).forEach(walk)
        else {
          this.checkField(c, k, 'фильтр')
          regex(v)
        }
      }
    }
    walk(filter)
  }

  // Файл по id: виден, только если видна запись, к которой он приложен
  // (правило view родительской коллекции). Нет доступа - 404, как и записи.
  async file(id: unknown): Promise<{ meta: FileMeta; bytes: Uint8Array }> {
    if (typeof id !== 'string' || !id) throw bad('id файла - строка')
    const store = this.access.opts.files
    const meta = (await this.access.db.c[FILES]!.findOne({ _id: id })) as FileMeta | null
    if (!store || !meta) throw new ActionError('not_found', 'Файл не найден')
    const rule = await this.ruleFilter(meta.collection, 'view').catch((err) => {
      if (err instanceof ActionError) return false as const
      throw err
    })
    if (rule === false) throw new ActionError('not_found', 'Файл не найден')
    const parent = await this.access.db.c[meta.collection]!.findOne(and(rule, { _id: meta.recordId }))
    if (!parent) throw new ActionError('not_found', 'Файл не найден')
    try {
      return { meta, bytes: store.read(meta) }
    } catch {
      throw new ActionError('not_found', 'Файл не найден')
    }
  }

  checkWrite(c: string, paths: string[], mode: 'create' | 'update', before?: Doc): void {
    const d = this.access._def(c)
    for (const path of paths) {
      assertFieldPath(path, 'поле')
      const root = path.split('.')[0]!
      if ((SYSTEM_FIELDS as readonly string[]).includes(root)) throw new ActionError('forbidden', `поле ${root} задаёт сервер`)
      // Поле-файл приходит не значением, а загрузкой: значение (id) ставит сервер.
      if (root in d.files) {
        if (d.hidden.has(root) || d.readonly.has(root)) throw new ActionError('forbidden', `поле ${root} клиент не меняет`)
        if (mode === 'update' && d.immutable.has(root)) throw new ActionError('forbidden', `поле ${root} задаётся только при создании`)
        continue
      }
      if (d.hidden.has(root) || d.readonly.has(root)) throw new ActionError('forbidden', `поле ${root} клиент не меняет`)
      if (mode === 'update' && d.immutable.has(root)) throw new ActionError('forbidden', `поле ${root} задаётся только при создании`)
      if (mode === 'update' && d.private.has(root) && !this.isOwner(c, before!)) throw new ActionError('forbidden', `поле ${root} меняет только владелец`)
    }
  }
}

// Ошибки ядра, вызванные запросом клиента, - 400/404, а не 500.
export async function clientErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof QueryError) throw bad(err.message)
    if (err instanceof ValidationError) throw bad(err.message, err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })))
    if (err instanceof NotFoundError) throw new ActionError('not_found', 'Запись не найдена')
    throw err
  }
}

export const and = (a: Query, b: Query): Query =>
  Object.keys(a).length === 0 ? b : Object.keys(b).length === 0 ? a : { $and: [a, b] }

export type ClientFindOptions = FindOptions & { expand?: string[] }

export class ClientCollection {
  constructor(
    private s: ClientSession,
    private name: string,
  ) {}

  private get core(): CollectionApi {
    return this.s.access.db.c[this.name]!
  }

  private opts(opts: FindOptions): FindOptions {
    const { defaultLimit, maxLimit, maxScanned } = this.s.access.limits
    const limit = opts.limit ?? defaultLimit
    if (limit > maxLimit) throw bad(`limit больше ${maxLimit}`)
    // Сотни ключей сортировки - это клиентская нагрузка на единственный
    // процесс: сортировка становится дороже самого перебора.
    if (Object.keys(opts.sort ?? {}).length > MAX_KEYS) throw bad(`sort: не больше ${MAX_KEYS} полей`)
    if ((opts.fields ?? []).length > MAX_KEYS) throw bad(`fields: не больше ${MAX_KEYS} полей`)
    for (const k of Object.keys(opts.sort ?? {})) this.s.checkField(this.name, k, 'sort')
    for (const f of opts.fields ?? []) this.s.checkField(this.name, f, 'fields')
    return { sort: opts.sort, limit, maxScanned }
  }

  find(filter: unknown = {}, opts: ClientFindOptions = {}): Promise<Doc[]> {
    return clientErrors(async () => {
      this.s.checkFilter(this.name, filter)
      const o = this.opts(opts)
      const rule = await this.s.ruleFilter(this.name, 'list')
      const docs = await this.core.find(and(rule, filter), o)
      return this.s.expand(this.name, docs.map((d) => this.s.strip(this.name, d, opts.fields)), opts.expand)
    })
  }

  // То же, что find, плюс tx, на котором прочитано: клиент применит из
  // буфера подписки только события с большим tx (design.md §12, реконнект).
  list(filter: unknown = {}, opts: ClientFindOptions = {}): Promise<{ items: Doc[]; tx: number }> {
    return clientErrors(async () => {
      this.s.checkFilter(this.name, filter)
      const o = this.opts(opts)
      const rule = await this.s.ruleFilter(this.name, 'list')
      // core.find без транзакции читает синхронно при вызове: tx и данные - одного момента
      const tx = this.s.access.db.lastTx
      const docs = await this.core.find(and(rule, filter), o)
      const items = await this.s.expand(this.name, docs.map((d) => this.s.strip(this.name, d, opts.fields)), opts.expand)
      return { items, tx }
    })
  }

  count(filter: unknown = {}): Promise<number> {
    return clientErrors(async () => {
      this.s.checkFilter(this.name, filter)
      const rule = await this.s.ruleFilter(this.name, 'list')
      return this.core.count(and(rule, filter), { maxScanned: this.s.access.limits.maxScanned })
    })
  }

  // Одна запись по id через правило view. Не видна - 404: не говорим, что она есть.
  get(id: string, opts: Pick<ClientFindOptions, 'fields' | 'expand'> = {}): Promise<Doc> {
    return clientErrors(async () => {
      if (typeof id !== 'string') throw bad('id - строка')
      for (const f of opts.fields ?? []) this.s.checkField(this.name, f, 'fields')
      const rule = await this.s.ruleFilter(this.name, 'view')
      const doc = await this.core.findOne(and(rule, { _id: id }))
      if (!doc) throw new ActionError('not_found', 'Запись не найдена')
      return (await this.s.expand(this.name, [this.s.strip(this.name, doc, opts.fields)], opts.expand))[0]!
    })
  }

  insert(doc: unknown, opts: { files?: Record<string, Upload[]> } = {}): Promise<Doc> {
    return clientErrors(async () => {
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad('документ должен быть объектом')
      const def = this.s.access._def(this.name)
      const store = this.s.access.opts.files
      const uploads = this.prepareUploads(def.files, store, opts.files, (doc as Record<string, unknown>))
      const id = typeof (doc as any)._id === 'string' ? (doc as any)._id : ulid()
      // Файлы - на диск до транзакции: откат удалит их, а метаданные в _files
      // попали бы в ту же строку лога, что и запись.
      const saved = uploads ? store!.save(this.name, id, def.files, uploads) : null
      try {
        // Поля-файлы приходят загрузкой, их значения (id) пишет сервер; всё
        // остальное - как обычно: скрытое и readonly клиент не задаёт.
        this.s.checkWrite(this.name, [...Object.keys(doc as object), ...Object.keys(saved?.values ?? {})], 'create')
        const db = this.s.access.db
        const out = await db.transaction(async (tx) => {
          for (const m of saved?.metas ?? []) await tx.c[FILES]!.insert(m as unknown as Record<string, unknown>)
          const full = { ...(doc as Record<string, unknown>), _id: id, ...(saved?.values ?? {}) }
          await this.s.check(this.name, 'create', { doc: structuredClone(full), db: tx.c })
          return tx.c[this.name]!.insert(full)
        }, { user: this.s.user, origin: 'api' })
        return this.s.strip(this.name, out)
      } catch (err) {
        if (saved) store!.removeMany(saved.metas)
        throw err
      }
    })
  }

  // Загрузки: только в объявленные поля-файлы, и только загрузкой - значение
  // (id файла) ставит сервер. Иначе клиент мог бы сослаться на чужой файл.
  private prepareUploads(def: FileFields, store: FileStore | undefined, uploads: Record<string, Upload[]> | undefined, doc: Record<string, unknown>): Record<string, Upload[]> | null {
    const list = uploads ?? {}
    for (const [field, value] of Object.entries(list)) {
      if (!(field in def)) throw bad(`${this.name}: поле ${field} не объявлено как файл (files)`)
      if (!value?.length) throw bad(`${this.name}: поле ${field} - пустая загрузка`)
    }
    const provided = Object.keys(list).filter((f) => list[f]!.length)
    for (const field of Object.keys(doc)) {
      if (field in def && !provided.includes(field)) throw bad(`${this.name}.${field}: файл загружается, а не задаётся значением`)
    }
    if (!provided.length) return null
    if (!store) throw bad('файлы не настроены на сервере')
    return Object.fromEntries(provided.map((f) => [f, list[f]!]))
  }

  update(id: string, update: unknown, opts: { files?: Record<string, Upload[]> } = {}): Promise<Doc> {
    return clientErrors(async () => {
      validateUpdate(update)
      const def = this.s.access._def(this.name)
      const store = this.s.access.opts.files
      const uploads = this.prepareUploads(def.files, store, opts.files, (update as any).$set ?? {})
      const saved = uploads ? store!.save(this.name, id, def.files, uploads) : null
      // Значение поля-файла меняется через $set: новые id приходят из загрузки.
      const upd = saved ? { ...(update as object), $set: { ...(update as Update).$set, ...saved.values } } : (update as Update)
      try {
        const db = this.s.access.db
        const out = await db.transaction(async (tx) => {
          for (const m of saved?.metas ?? []) await tx.c[FILES]!.insert(m as unknown as Record<string, unknown>)
          // видимость и правило - в той же транзакции, что запись: между проверкой и записью ничего не изменится
          const view = await this.s.ruleFilter(this.name, 'view', tx.c)
          const before = await tx.c[this.name]!.findOne(and(view, { _id: id }))
          if (!before) throw new ActionError('not_found', 'Запись не найдена')
          this.s.checkWrite(this.name, Object.values(upd).flatMap((f) => Object.keys(f ?? {})), 'update', before)
          const after = applyUpdate(before, upd)
          await this.s.check(this.name, 'update', { before, after, db: tx.c })
          return tx.c[this.name]!.update(id, upd)
        }, { user: this.s.user, origin: 'api' })
        return this.s.strip(this.name, out)
      } catch (err) {
        if (saved) store!.removeMany(saved.metas)
        throw err
      }
    })
  }

  remove(id: string): Promise<void> {
    return clientErrors(async () => {
      const db = this.s.access.db
      await db.transaction(async (tx) => {
        const view = await this.s.ruleFilter(this.name, 'view', tx.c)
        const before = await tx.c[this.name]!.findOne(and(view, { _id: id }))
        if (!before) throw new ActionError('not_found', 'Запись не найдена')
        await this.s.check(this.name, 'delete', { before, db: tx.c })
        await tx.c[this.name]!.remove(id)
      }, { user: this.s.user, origin: 'api' })
    })
  }
}

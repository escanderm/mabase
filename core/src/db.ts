// Ядро: транзакции, общая очередь записи, overlay, хуки (из прототипа 02),
// коллекции, индексы, планировщик, схемы (design.md §6-§9).
import { AsyncLocalStorage } from 'node:async_hooks'
import { crashPoint } from './crash'
import { Disk, type Data, type LogOp } from './disk'
import {
  DefinitionError,
  DepthError,
  DuplicateIdError,
  NotFoundError,
  QueryError,
  ReadOnlyError,
  TxAbortedError,
  TxTimeoutError,
} from './errors'
import { FieldIndex, sortedInsert, sortedRemove } from './indexes'
import { runFind, type CollState, type Explain, type FindOptions } from './planner'
import { applyUpdate, assertJson, getPath, validateQuery, type Doc, type Query, type Update } from './query'
import { checkIndexes, validateDoc, type Schema } from './schema'
import { WriteQueue } from './queue'
import { ulid } from './ulid'

export type { Doc, Query, Update } from './query'
export type { Explain, FindOptions } from './planner'

type BeforeCtx = { db: Db; signal: AbortSignal; depth: number }
export type Hooks = {
  beforeCreate?: (ctx: BeforeCtx & { doc: Doc }) => unknown
  beforeUpdate?: (ctx: BeforeCtx & { prev: Doc; next: Doc }) => unknown
  beforeDelete?: (ctx: BeforeCtx & { prev: Doc }) => unknown
  afterCreate?: (ctx: { db: Db; doc: Doc }) => unknown
  afterUpdate?: (ctx: { db: Db; prev: Doc; doc: Doc }) => unknown
  afterDelete?: (ctx: { db: Db; prev: Doc }) => unknown
}
export type CollectionDef = { schema?: Schema; indexes?: string[]; hooks?: Hooks }

// Событие из транзакции. Уходит подписчикам onCommit только после коммита.
export type TxEvent = { event: string; data: unknown }
// events-only транзакция (без записей) получает tx = последний сохранённый номер.
export type CommitInfo = { tx: number; ops: LogOp[]; holdMs: number; events: readonly TxEvent[] }
export type EmitOptions = { after?: number | string; key?: string }
export type HookErrorInfo = { where: string; collection?: string }

export type DbOptions = {
  dir: string
  fsync?: boolean
  txTimeoutMs?: number
  compactMinBytes?: number // компактировать, когда лог больше снапшота и больше этого; 0 - не компактировать само
  bigTxOps?: number // транзакция больше - предупреждение
  maxDepth?: number
  onError?: (err: unknown, info: HookErrorInfo) => void
  onWarning?: (message: string) => void
}

type TxState = 'open' | 'committing' | 'committed' | 'aborted'

class Tx {
  state: TxState = 'open'
  overlay = new Map<string, Map<string, Doc | null>>() // null = удалён в транзакции
  after: Array<{ collection: string; run: () => unknown }> = []
  events: TxEvent[] = []
  scheduled: Array<TxEvent & { runAt: number; key?: string }> = []
  abort = new AbortController()
  release: (() => void) | null = null
  acquiring: Promise<void> | null = null
  acquiredAt = 0
  timer: ReturnType<typeof setTimeout> | null = null
  fail: (err: unknown) => void = () => {}
}

type Store = { tx: Tx; depth: number }

export type TxApi = {
  c: Record<string, CollectionApi>
  signal: AbortSignal
  // Без after - событие подписчикам после коммита. С after - задача в _scheduled
  // в той же строке лога (design.md §13); доставка - шаг 10.
  emit: (event: string, data?: unknown, opts?: EmitOptions) => void
}

export const SCHEDULED = '_scheduled'

// '0s', '500ms', '5m', '2h', '1d' или миллисекунды числом.
export function parseDuration(v: number | string): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  const m = typeof v === 'string' ? /^(\d+)(ms|s|m|h|d)$/.exec(v) : null
  if (!m) throw new QueryError(`after: непонятная длительность ${JSON.stringify(v)}, пример: '30s', '5m'`)
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms']
}

const clone = <T>(v: T): T => structuredClone(v)

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const x of Object.values(v)) deepFreeze(x)
  }
  return v
}

const INSERT_BATCH = 1000

// Все _id по порядку. Снапшот и лог пишутся почти в порядке ULID, поэтому
// сначала проверяем порядок за один проход: сортировка 1 млн строк - ~1 с.
function sortedIds(docs: Map<string, Doc>): string[] {
  const ids = [...docs.keys()]
  for (let i = 1; i < ids.length; i++) if (ids[i - 1]! >= ids[i]!) return ids.sort()
  return ids
}

// Только нужные поля. _id - всегда.
function project(doc: Doc, fields: string[] | undefined): Doc {
  if (!fields) return clone(doc)
  const out: any = { _id: doc._id }
  for (const f of fields) {
    const v = getPath(doc, f)
    if (v === undefined) continue
    const parts = f.split('.')
    let cur = out
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]!] ??= {}
    cur[parts[parts.length - 1]!] = clone(v)
  }
  return out
}

// Поля, которые фильтр задаёт равенством, - их получит новый документ в upsert.
function equalityFields(filter: Query): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$') || k.includes('.')) continue
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v
  }
  return out
}

export class CollectionApi {
  constructor(
    private db: Db,
    private name: string,
    private bound: Tx | null,
  ) {}

  private tx(): Tx | null {
    return this.bound ?? this.db._currentTx()
  }

  // Запись вне транзакции - отдельная корневая транзакция из одной операции.
  private write<T>(f: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = this.tx()
    return tx ? f(tx) : this.db.transaction(() => f(this.db._currentTx()!))
  }

  insert(doc: Record<string, any>): Promise<Doc> {
    return this.write((tx) => this.db._insert(tx, this.name, doc))
  }

  // Вне транзакции - пачками по 1000, каждая пачка своя транзакция и один fsync.
  // Упали посередине - сохранённые пачки остаются (design.md §15).
  // Внутри транзакции - всё в ней.
  async insertMany(docs: Array<Record<string, any>>): Promise<Doc[]> {
    const tx = this.tx()
    const out: Doc[] = []
    if (tx) {
      for (const d of docs) out.push(await this.db._insert(tx, this.name, d))
      return out
    }
    for (let i = 0; i < docs.length; i += INSERT_BATCH) {
      const chunk = docs.slice(i, i + INSERT_BATCH)
      await this.db.transaction(async () => {
        const t = this.db._currentTx()!
        for (const d of chunk) out.push(await this.db._insert(t, this.name, d))
      })
    }
    return out
  }

  update(id: string, update: Update): Promise<Doc> {
    return this.write((tx) => this.db._update(tx, this.name, id, update))
  }

  // Нашёлся по фильтру - $set полей doc. Нет - новый документ из doc и
  // равенств фильтра (так своё _id из фильтра попадает в документ).
  upsert(filter: Query, doc: Record<string, any>): Promise<Doc> {
    validateQuery(filter)
    return this.write(async (tx) => {
      const [found] = await this.db._find(tx, this.name, filter, { limit: 1 })
      if (found) return Object.keys(doc).length ? this.db._update(tx, this.name, found._id, { $set: doc }) : found
      return this.db._insert(tx, this.name, { ...equalityFields(filter), ...doc })
    })
  }

  remove(id: string): Promise<void> {
    return this.write((tx) => this.db._remove(tx, this.name, id))
  }

  // Одна транзакция. Про большие удаления - design.md §10.
  removeMany(filter: Query): Promise<number> {
    return this.write(async (tx) => {
      const found = await this.db._find(tx, this.name, filter, { fields: ['_id'], unordered: true })
      for (const d of found) await this.db._remove(tx, this.name, d._id)
      return found.length
    })
  }

  find(query: Query = {}, opts: FindOptions = {}): Promise<Doc[]> {
    return this.db._find(this.tx(), this.name, query, opts)
  }

  async findOne(query: Query = {}, opts: Omit<FindOptions, 'limit'> = {}): Promise<Doc | null> {
    return (await this.find(query, { ...opts, limit: 1 }))[0] ?? null
  }

  count(query: Query = {}): Promise<number> {
    return this.db._count(this.tx(), this.name, query)
  }

  // Как выполнится запрос: источник кандидатов, сколько проверено, сортировалось ли в памяти.
  explain(query: Query = {}, opts: FindOptions = {}): Promise<Explain> {
    return this.db._explain(this.tx(), this.name, query, opts)
  }
}

export class Db {
  readonly c: Record<string, CollectionApi>
  lastTx: number
  readonly recovery: { droppedTailBytes: number }

  private als = new AsyncLocalStorage<Store>()
  private queue = new WriteQueue()
  private defs = new Map<string, CollectionDef>()
  private states = new Map<string, CollState>()
  private listeners: Array<(info: CommitInfo) => void> = []
  private readOnly: Error | null = null
  private compacting: Promise<void> | null = null
  private opts: Required<DbOptions>

  private constructor(
    private disk: Disk,
    private data: Data,
    lastTx: number,
    droppedTailBytes: number,
    opts: DbOptions,
  ) {
    this.lastTx = lastTx
    this.recovery = { droppedTailBytes }
    this.opts = {
      fsync: true,
      txTimeoutMs: 2000,
      compactMinBytes: 16 << 20,
      bigTxOps: 10_000,
      maxDepth: 10,
      onError: (err, info) => console.error(`[mabase] ошибка в ${info.where}`, err),
      onWarning: (message) => console.warn(`[mabase] ${message}`),
      ...opts,
    }
    if (droppedTailBytes > 0) {
      this.opts.onWarning(
        `При запуске отброшена недописанная транзакция в конце лога (${droppedTailBytes} байт). ` +
          'Процесс упал посреди записи; подтверждённые транзакции не затронуты',
      )
    }
    for (const c of data.keys()) this.state(c)
    this.collection(SCHEDULED, { indexes: ['key', 'runAt'] })
    this.c = new Proxy({} as Record<string, CollectionApi>, {
      get: (_, name) => (typeof name === 'string' ? new CollectionApi(this, name, null) : undefined),
    })
  }

  static async open(opts: DbOptions): Promise<Db> {
    const disk = new Disk(opts.dir, opts.fsync ?? true)
    const { data, lastTx, droppedTailBytes } = await disk.open()
    return new Db(disk, data, lastTx, droppedTailBytes, opts)
  }

  collection(name: string, def: CollectionDef = {}): this {
    if (!name || name.includes('/')) throw new QueryError(`недопустимое имя коллекции "${name}"`)
    if (name === SCHEDULED && this.defs.has(SCHEDULED)) throw new DefinitionError(`${SCHEDULED} - системная коллекция`)
    const fields = [...new Set(def.indexes ?? [])]
    checkIndexes(name, def.schema, fields)
    this.defs.set(name, def)
    const state = this.state(name)
    state.indexes = new Map(fields.map((f) => [f, this.buildIndex(state, f)]))
    return this
  }

  // Состояние коллекции: документы, все _id по порядку, индексы.
  private state(c: string): CollState {
    let st = this.states.get(c)
    if (!st) {
      let docs = this.data.get(c)
      if (!docs) this.data.set(c, (docs = new Map()))
      st = { docs, ids: sortedIds(docs), indexes: new Map() }
      this.states.set(c, st)
    }
    return st
  }

  onCommit(fn: (info: CommitInfo) => void): void {
    this.listeners.push(fn)
  }

  get stats() {
    return {
      lastTx: this.lastTx,
      gen: this.disk.gen,
      logSize: this.disk.logSize,
      snapshotSize: this.disk.snapshotSize,
      dir: this.disk.dir,
    }
  }

  // ---------- транзакции ----------

  transaction<T>(fn: (tx: TxApi) => T | Promise<T>): Promise<T> {
    const store = this.als.getStore()
    if (store) {
      // вложенная транзакция присоединяется к текущей
      this.ensureOpen(store.tx)
      return Promise.resolve().then(() => fn(this.txApi(store.tx)))
    }
    const tx = new Tx()
    return new Promise<T>((resolve, reject) => {
      tx.fail = reject
      this.als.run({ tx, depth: 0 }, () => {
        Promise.resolve()
          .then(() => fn(this.txApi(tx)))
          .then(
            (result) => this.commit(tx).then(() => resolve(result), reject),
            (err) => this.abortTx(tx, err),
          )
      })
    })
  }

  _currentTx(): Tx | null {
    return this.als.getStore()?.tx ?? null
  }

  private txApi(tx: Tx): TxApi {
    return {
      c: new Proxy({} as Record<string, CollectionApi>, {
        get: (_, name) => (typeof name === 'string' ? new CollectionApi(this, name, tx) : undefined),
      }),
      signal: tx.abort.signal,
      emit: (event, data = null, opts = {}) => {
        this.ensureOpen(tx)
        if (typeof event !== 'string' || event === '') throw new QueryError('emit: нужно имя события')
        assertJson(data)
        const frozen = deepFreeze(JSON.parse(JSON.stringify(data ?? null)))
        if (opts.after === undefined) {
          tx.events.push({ event, data: frozen })
          return
        }
        if (opts.key !== undefined && (typeof opts.key !== 'string' || opts.key === '')) throw new QueryError('emit: key - непустая строка')
        tx.scheduled.push({ event, data: frozen, runAt: Date.now() + parseDuration(opts.after), key: opts.key })
      },
    }
  }

  // Отложенные события - обычные документы _scheduled в этой же транзакции.
  // key: пока есть задача с этим ключом, новая не ставится.
  private stageScheduled(tx: Tx): void {
    const st = this.state(SCHEDULED)
    const byKey = st.indexes.get('key')!
    const taken = (key: string) => {
      const ov = tx.overlay.get(SCHEDULED) // появляется после первой постановки
      for (const id of byKey.eq(key)) if (!ov?.has(id)) return true
      for (const d of ov?.values() ?? []) if (d?.key === key) return true
      return false
    }
    for (const s of tx.scheduled) {
      if (s.key !== undefined && taken(s.key)) continue
      const id = ulid()
      const now = Date.now()
      const doc: Doc = { _id: id, event: s.event, data: s.data, runAt: s.runAt, attempts: 0, _createdAt: now, _updatedAt: now }
      if (s.key !== undefined) doc.key = s.key
      this.stage(tx, SCHEDULED, id, this.finalize(SCHEDULED, doc))
    }
    tx.scheduled = []
  }

  private ensureOpen(tx: Tx): void {
    if (tx.state !== 'open') throw new TxAbortedError()
  }

  // Очередь берётся при первом обращении к базе (SPEC §5.1).
  private async enter(tx: Tx): Promise<void> {
    this.ensureOpen(tx)
    if (tx.release) return
    if (!tx.acquiring) {
      tx.acquiring = this.queue.acquire().then((release) => {
        tx.release = release
        if (tx.state !== 'open') {
          release() // транзакцию отменили, пока она ждала очередь
          return
        }
        tx.acquiredAt = performance.now()
        tx.timer = setTimeout(() => this.timeoutTx(tx), this.opts.txTimeoutMs)
      })
    }
    await tx.acquiring
    this.ensureOpen(tx)
  }

  private holdMs(tx: Tx): number {
    return tx.acquiredAt ? Math.round(performance.now() - tx.acquiredAt) : 0
  }

  private timeoutTx(tx: Tx): void {
    if (tx.state !== 'open') return
    this.abortTx(tx, new TxTimeoutError(this.holdMs(tx)))
  }

  private abortTx(tx: Tx, err: unknown): void {
    if (tx.state !== 'open') return
    tx.state = 'aborted'
    if (tx.timer) clearTimeout(tx.timer)
    tx.abort.abort(err)
    tx.overlay.clear()
    tx.release?.()
    tx.fail(err)
  }

  private async commit(tx: Tx): Promise<void> {
    if (tx.state !== 'open') return // таймаут уже ответил вызывающему
    if (tx.scheduled.length) {
      await this.enter(tx) // запись в _scheduled - запись в базу, нужна очередь
      this.stageScheduled(tx)
    }
    if (tx.timer) clearTimeout(tx.timer)

    // Документы замораживаются: они уйдут в память и подписчикам onCommit,
    // и никто не должен менять их в обход лога.
    const ops: LogOp[] = []
    for (const [c, ov] of tx.overlay) {
      for (const [id, doc] of ov) ops.push(doc ? { op: 'put', c, doc: deepFreeze(doc) } : { op: 'del', c, id })
    }
    deepFreeze(ops)
    if (ops.length > this.opts.bigTxOps) {
      this.opts.onWarning(
        `Транзакция на ${ops.length} операций (порог ${this.opts.bigTxOps}): большая строка лога и долго занятая очередь. ` +
          'Для больших удалений - мягкое удаление и дочистка пачками (design.md §10)',
      )
    }
    const events = deepFreeze(tx.events)
    if (!tx.release || ops.length === 0) {
      tx.state = 'committed'
      const holdMs = this.holdMs(tx)
      tx.release?.()
      if (events.length) this.notify({ tx: this.lastTx, ops, holdMs, events })
      return
    }
    if (this.readOnly) {
      this.abortTx(tx, this.readOnly)
      return
    }

    tx.state = 'committing'
    const txNo = this.lastTx + 1
    try {
      await this.disk.append(JSON.stringify({ tx: txNo, ts: Date.now(), ops }) + '\n')
    } catch (err) {
      if (err instanceof ReadOnlyError) this.readOnly = err
      tx.state = 'aborted'
      tx.release()
      throw err
    }
    crashPoint('log.afterFsyncBeforeApply')

    // синхронно, без await: никто не увидит половину пакета
    this.applyOps(ops)
    this.lastTx = txNo
    tx.state = 'committed'
    const holdMs = this.holdMs(tx)
    tx.release()

    this.notify({ tx: txNo, ops, holdMs, events })
    // after* - вне контекста завершённой транзакции (SPEC §5.6)
    if (tx.after.length) this.als.exit(() => setTimeout(() => this.runAfter(tx), 0))
    this.maybeCompact()
  }

  private notify(info: CommitInfo): void {
    for (const l of this.listeners) {
      try {
        l(info)
      } catch (err) {
        this.opts.onError(err, { where: 'onCommit' })
      }
    }
  }

  private async runAfter(tx: Tx): Promise<void> {
    for (const a of tx.after) {
      try {
        await a.run()
      } catch (err) {
        this.opts.onError(err, { where: 'after*', collection: a.collection })
      }
    }
  }

  // Ошибка в before* или превышение глубины отменяет всю транзакцию,
  // даже если код действия поймает исключение.
  private async runBefore<T>(tx: Tx, depth: number, f: () => T | Promise<T>): Promise<T> {
    return this.als.run({ tx, depth: depth + 1 }, async () => {
      try {
        return await f()
      } catch (err) {
        this.abortTx(tx, err)
        throw err
      }
    })
  }

  private depthOf(tx: Tx): number {
    const store = this.als.getStore()
    const depth = store?.tx === tx ? store.depth : 0
    if (depth > this.opts.maxDepth) {
      const err = new DepthError(depth)
      this.abortTx(tx, err)
      throw err
    }
    return depth
  }

  // Сохранённое состояние синхронно, без очереди и overlay. Для тестов и onCommit.
  peek(c: string, id: string): Doc | null {
    const doc = this.data.get(c)?.get(id)
    return doc ? clone(doc) : null
  }

  // ---------- чтение и запись внутри транзакции ----------

  private get(tx: Tx | null, c: string, id: string): Doc | null {
    const ov = tx?.overlay.get(c)
    if (ov?.has(id)) return ov.get(id) ?? null
    return this.data.get(c)?.get(id) ?? null
  }

  private stage(tx: Tx, c: string, id: string, doc: Doc | null): void {
    let ov = tx.overlay.get(c)
    if (!ov) tx.overlay.set(c, (ov = new Map()))
    ov.set(id, doc)
  }

  async _insert(tx: Tx, c: string, input: Record<string, any>): Promise<Doc> {
    await this.enter(tx)
    const depth = this.depthOf(tx)
    const id: string = input._id ?? ulid()
    if (typeof id !== 'string' || id === '') throw new QueryError(`${c}: _id должен быть непустой строкой`)
    if (this.get(tx, c, id)) throw new DuplicateIdError(c, id)
    const now = Date.now()
    let doc: Doc = { ...clone(input), _id: id, _createdAt: now, _updatedAt: now }

    const hooks = this.defs.get(c)?.hooks
    if (hooks?.beforeCreate) {
      const h = hooks.beforeCreate
      const r = await this.runBefore(tx, depth, () =>
        h({ doc: clone(doc), db: this, signal: tx.abort.signal, depth: depth + 1 }),
      )
      if (r && typeof r === 'object') doc = { ...clone(r as object), _id: id, _createdAt: now, _updatedAt: now }
    }
    this.ensureOpen(tx)
    doc = this.finalize(c, doc)
    this.stage(tx, c, id, doc)
    if (hooks?.afterCreate) {
      const h = hooks.afterCreate
      const saved = clone(doc)
      tx.after.push({ collection: c, run: () => h({ doc: saved, db: this }) })
    }
    return clone(doc)
  }

  async _update(tx: Tx, c: string, id: string, update: Update): Promise<Doc> {
    await this.enter(tx)
    const depth = this.depthOf(tx)
    const prev = this.get(tx, c, id)
    if (!prev) throw new NotFoundError(c, id)
    const now = Date.now()
    let next: Doc = { ...applyUpdate(prev, update), _id: id, _createdAt: prev._createdAt, _updatedAt: now }

    const hooks = this.defs.get(c)?.hooks
    if (hooks?.beforeUpdate) {
      const h = hooks.beforeUpdate
      const r = await this.runBefore(tx, depth, () =>
        h({ prev: clone(prev), next: clone(next), db: this, signal: tx.abort.signal, depth: depth + 1 }),
      )
      if (r && typeof r === 'object') {
        next = { ...clone(r as object), _id: id, _createdAt: prev._createdAt, _updatedAt: now }
      }
    }
    this.ensureOpen(tx)
    next = this.finalize(c, next)
    this.stage(tx, c, id, next)
    if (hooks?.afterUpdate) {
      const h = hooks.afterUpdate
      const p = clone(prev)
      const d = clone(next)
      tx.after.push({ collection: c, run: () => h({ prev: p, doc: d, db: this }) })
    }
    return clone(next)
  }

  async _remove(tx: Tx, c: string, id: string): Promise<void> {
    await this.enter(tx)
    const depth = this.depthOf(tx)
    const prev = this.get(tx, c, id)
    if (!prev) throw new NotFoundError(c, id)

    const hooks = this.defs.get(c)?.hooks
    if (hooks?.beforeDelete) {
      const h = hooks.beforeDelete
      await this.runBefore(tx, depth, () =>
        h({ prev: clone(prev), db: this, signal: tx.abort.signal, depth: depth + 1 }),
      )
    }
    this.ensureOpen(tx)
    this.stage(tx, c, id, null)
    if (hooks?.afterDelete) {
      const h = hooks.afterDelete
      const p = clone(prev)
      tx.after.push({ collection: c, run: () => h({ prev: p, db: this }) })
    }
  }

  // Документ перед записью: схема, проверка на JSON и копия через JSON -
  // в памяти лежит ровно то, что прочитается из лога после рестарта.
  private finalize(c: string, doc: Doc): Doc {
    const schema = this.defs.get(c)?.schema
    if (schema) doc = validateDoc(c, schema, doc)
    assertJson(doc)
    return JSON.parse(JSON.stringify(doc))
  }

  // Внутри транзакции: overlay поверх сохранённого. Снаружи: только сохранённое, без очереди.
  async _find(tx: Tx | null, c: string, query: Query, opts: FindOptions & { unordered?: boolean } = {}): Promise<Doc[]> {
    if (tx) await this.enter(tx)
    const { docs } = runFind(this.state(c), query, opts, tx?.overlay.get(c))
    return docs.map((d) => project(d, opts.fields))
  }

  async _count(tx: Tx | null, c: string, query: Query): Promise<number> {
    if (tx) await this.enter(tx)
    return runFind(this.state(c), query, { unordered: true }, tx?.overlay.get(c)).docs.length
  }

  async _explain(tx: Tx | null, c: string, query: Query, opts: FindOptions): Promise<Explain> {
    if (tx) await this.enter(tx)
    return runFind(this.state(c), query, opts, tx?.overlay.get(c)).explain
  }

  // ---------- индексы ----------

  private buildIndex(state: CollState, field: string): FieldIndex {
    const idx = new FieldIndex(field)
    for (const id of state.ids) idx.add(state.docs.get(id)!)
    return idx
  }

  private applyOps(ops: LogOp[]): void {
    for (const op of ops) {
      const st = this.state(op.c)
      const id = op.op === 'put' ? op.doc._id : op.id
      const prev = st.docs.get(id)
      if (op.op === 'put') st.docs.set(id, op.doc)
      else st.docs.delete(id)

      if (!prev && op.op === 'put') sortedInsert(st.ids, id)
      if (prev && op.op === 'del') sortedRemove(st.ids, id)
      for (const idx of st.indexes.values()) {
        if (prev) idx.remove(prev)
        if (op.op === 'put') idx.add(op.doc)
      }
    }
  }

  // Сверить живые индексы с построенными заново. Пустой массив - всё в порядке.
  verifyIndexes(): string[] {
    const problems: string[] = []
    for (const [c, st] of this.states) {
      const ids = [...st.docs.keys()].sort()
      if (ids.join() !== st.ids.join()) problems.push(`${c}._id: список id не совпадает`)
      for (const [field, live] of st.indexes) problems.push(...live.verify(this.buildIndex(st, field), `${c}.${field}`))
    }
    return problems
  }

  // ---------- компактирование и закрытие ----------

  // Порог относительный: лог больше снапшота (и не меньше compactMinBytes).
  // Так работа на компактирование пропорциональна записи (design.md §6).
  private maybeCompact(): void {
    const min = this.opts.compactMinBytes
    if (!min || this.compacting || this.disk.logSize <= Math.max(min, this.disk.snapshotSize)) return
    this.als.exit(() => {
      this.compact().catch((err) => this.opts.onError(err, { where: 'compact' }))
    })
  }

  compact(): Promise<void> {
    if (this.als.getStore()) throw new Error('compact() нельзя вызывать внутри транзакции')
    if (this.compacting) return this.compacting
    this.compacting = (async () => {
      const release = await this.queue.acquire()
      try {
        await this.disk.compact(this.lastTx, this.data)
      } finally {
        release()
        this.compacting = null
      }
    })()
    return this.compacting
  }

  async close(): Promise<void> {
    if (this.compacting) await this.compacting
    const release = await this.queue.acquire()
    try {
      await this.disk.close()
    } finally {
      release()
    }
  }
}

export const openDb = (opts: DbOptions) => Db.open(opts)

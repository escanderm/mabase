// Ядро: транзакции, общая очередь записи, overlay, хуки, индексы (SPEC §5).
import { AsyncLocalStorage } from 'node:async_hooks'
import { crashPoint } from './crash'
import { Disk, type Data, type LogOp } from './disk'
import {
  DepthError,
  DuplicateIdError,
  NotFoundError,
  ReadOnlyError,
  TxAbortedError,
  TxTimeoutError,
} from './errors'
import { applyUpdate, getPath, matches, type Doc, type Query, type Update } from './query'
import { WriteQueue } from './queue'
import { ulid } from './ulid'

type BeforeCtx = { db: Db; signal: AbortSignal; depth: number }
export type Hooks = {
  beforeCreate?: (ctx: BeforeCtx & { doc: Doc }) => unknown
  beforeUpdate?: (ctx: BeforeCtx & { prev: Doc; next: Doc }) => unknown
  beforeDelete?: (ctx: BeforeCtx & { prev: Doc }) => unknown
  afterCreate?: (ctx: { db: Db; doc: Doc }) => unknown
  afterUpdate?: (ctx: { db: Db; prev: Doc; doc: Doc }) => unknown
  afterDelete?: (ctx: { db: Db; prev: Doc }) => unknown
}
export type CollectionDef = { indexes?: string[]; hooks?: Hooks }

export type CommitInfo = { tx: number; ops: LogOp[]; holdMs: number }
export type HookErrorInfo = { where: string; collection?: string }

export type DbOptions = {
  dir: string
  fsync?: boolean
  txTimeoutMs?: number
  compactAtBytes?: number // 0 - не компактировать само
  maxDepth?: number
  onError?: (err: unknown, info: HookErrorInfo) => void
  onWarning?: (message: string) => void
}

type TxState = 'open' | 'committing' | 'committed' | 'aborted'

class Tx {
  state: TxState = 'open'
  overlay = new Map<string, Map<string, Doc | null>>() // null = удалён в транзакции
  after: Array<{ collection: string; run: () => unknown }> = []
  abort = new AbortController()
  release: (() => void) | null = null
  acquiring: Promise<void> | null = null
  acquiredAt = 0
  timer: ReturnType<typeof setTimeout> | null = null
  fail: (err: unknown) => void = () => {}
}

type Store = { tx: Tx; depth: number }

export type TxApi = { c: Record<string, CollectionApi>; signal: AbortSignal }

const clone = <T>(v: T): T => structuredClone(v)

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const x of Object.values(v)) deepFreeze(x)
  }
  return v
}

function indexKey(v: unknown): string | undefined {
  switch (typeof v) {
    case 'string':
      return 's' + v
    case 'number':
      return 'n' + v
    case 'boolean':
      return 'b' + v
    default:
      return v === null ? 'z' : undefined
  }
}

function indexKeys(doc: Doc, field: string): string[] {
  const v = getPath(doc, field)
  const vals = Array.isArray(v) ? v : [v]
  const keys = new Set<string>()
  for (const x of vals) {
    const k = indexKey(x)
    if (k !== undefined) keys.add(k)
  }
  return [...keys]
}

// Списки id в индексе отсортированы по _id. Новые ULID обычно больше всех - просто push.
function sortedInsert(list: string[], id: string): void {
  if (list.length === 0 || list[list.length - 1]! < id) {
    list.push(id)
    return
  }
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid]! < id) lo = mid + 1
    else hi = mid
  }
  if (list[lo] !== id) list.splice(lo, 0, id)
}

function sortedRemove(list: string[], id: string): void {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid]! < id) lo = mid + 1
    else hi = mid
  }
  if (list[lo] === id) list.splice(lo, 1)
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

  update(id: string, update: Update): Promise<Doc> {
    return this.write((tx) => this.db._update(tx, this.name, id, update))
  }

  remove(id: string): Promise<void> {
    return this.write((tx) => this.db._remove(tx, this.name, id))
  }

  find(query: Query = {}): Promise<Doc[]> {
    return this.db._find(this.tx(), this.name, query)
  }

  async findOne(query: Query = {}): Promise<Doc | null> {
    return (await this.find(query))[0] ?? null
  }
}

export class Db {
  readonly c: Record<string, CollectionApi>
  lastTx: number
  readonly recovery: { droppedTailBytes: number }

  private als = new AsyncLocalStorage<Store>()
  private queue = new WriteQueue()
  private defs = new Map<string, CollectionDef>()
  private indexes = new Map<string, Map<string, Map<string, string[]>>>()
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
      compactAtBytes: 1 << 20,
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
    this.defs.set(name, def)
    const idx = new Map<string, Map<string, string[]>>()
    for (const field of def.indexes ?? []) idx.set(field, this.buildIndex(name, field))
    this.indexes.set(name, idx)
    return this
  }

  onCommit(fn: (info: CommitInfo) => void): void {
    this.listeners.push(fn)
  }

  get stats() {
    return { lastTx: this.lastTx, gen: this.disk.gen, logSize: this.disk.logSize, dir: this.disk.dir }
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
    }
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
    if (tx.timer) clearTimeout(tx.timer)

    // Документы замораживаются: они уйдут в память и подписчикам onCommit,
    // и никто не должен менять их в обход лога.
    const ops: LogOp[] = []
    for (const [c, ov] of tx.overlay) {
      for (const [id, doc] of ov) ops.push(doc ? { op: 'put', c, doc: deepFreeze(doc) } : { op: 'del', c, id })
    }
    deepFreeze(ops)
    if (!tx.release || ops.length === 0) {
      tx.state = 'committed'
      tx.release?.()
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

    for (const l of this.listeners) {
      try {
        l({ tx: txNo, ops, holdMs })
      } catch (err) {
        this.opts.onError(err, { where: 'onCommit' })
      }
    }
    // after* - вне контекста завершённой транзакции (SPEC §5.6)
    if (tx.after.length) this.als.exit(() => setTimeout(() => this.runAfter(tx), 0))
    this.maybeCompact()
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

  // Внутри транзакции: overlay поверх сохранённого. Снаружи: только сохранённое, без очереди.
  async _find(tx: Tx | null, c: string, query: Query): Promise<Doc[]> {
    if (tx) await this.enter(tx)
    const coll = this.data.get(c)
    const ov = tx?.overlay.get(c)
    const out: Doc[] = []

    const consider = (id: string) => {
      if (ov?.has(id)) return // версию из overlay проверим ниже
      const doc = coll?.get(id)
      if (doc && matches(doc, query)) out.push(doc)
    }

    const candidates = this.candidates(c, query)
    if (candidates) for (const id of candidates) consider(id)
    else if (coll) for (const id of coll.keys()) consider(id)

    if (ov) {
      for (const doc of ov.values()) if (doc && matches(doc, query)) out.push(doc)
      out.sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
    } else if (!candidates) {
      out.sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
    }
    return out.map(clone)
  }

  private candidates(c: string, query: Query): readonly string[] | null {
    if (typeof query._id === 'string') return [query._id]
    const idx = this.indexes.get(c)
    if (!idx) return null
    for (const [field, value] of Object.entries(query)) {
      const byValue = idx.get(field)
      const key = indexKey(value)
      if (byValue && key !== undefined) return byValue.get(key) ?? []
    }
    return null
  }

  // ---------- индексы ----------

  private buildIndex(c: string, field: string): Map<string, string[]> {
    const byValue = new Map<string, string[]>()
    for (const doc of this.data.get(c)?.values() ?? []) {
      for (const k of indexKeys(doc, field)) {
        let list = byValue.get(k)
        if (!list) byValue.set(k, (list = []))
        list.push(doc._id)
      }
    }
    for (const list of byValue.values()) list.sort()
    return byValue
  }

  private applyOps(ops: LogOp[]): void {
    for (const op of ops) {
      let coll = this.data.get(op.c)
      if (!coll) this.data.set(op.c, (coll = new Map()))
      const id = op.op === 'put' ? op.doc._id : op.id
      const prev = coll.get(id)
      if (op.op === 'put') coll.set(id, op.doc)
      else coll.delete(id)

      const idx = this.indexes.get(op.c)
      if (!idx) continue
      for (const [field, byValue] of idx) {
        if (prev) {
          for (const k of indexKeys(prev, field)) {
            const list = byValue.get(k)
            if (!list) continue
            sortedRemove(list, id)
            if (list.length === 0) byValue.delete(k)
          }
        }
        if (op.op === 'put') {
          for (const k of indexKeys(op.doc, field)) {
            let list = byValue.get(k)
            if (!list) byValue.set(k, (list = []))
            sortedInsert(list, id)
          }
        }
      }
    }
  }

  // Сверить живые индексы с построенными заново. Пустой массив - всё в порядке.
  verifyIndexes(): string[] {
    const problems: string[] = []
    for (const [c, idx] of this.indexes) {
      for (const [field, live] of idx) {
        const fresh = this.buildIndex(c, field)
        if (live.size !== fresh.size) problems.push(`${c}.${field}: ${live.size} ключей, ожидалось ${fresh.size}`)
        for (const [k, list] of fresh) {
          const got = live.get(k)
          if (!got || got.join() !== list.join()) problems.push(`${c}.${field}[${k}] не совпадает`)
        }
        for (const [k, list] of live) {
          for (let i = 1; i < list.length; i++) {
            if (!(list[i - 1]! < list[i]!)) problems.push(`${c}.${field}[${k}] не отсортирован`)
          }
        }
      }
    }
    return problems
  }

  // ---------- компактирование и закрытие ----------

  private maybeCompact(): void {
    const limit = this.opts.compactAtBytes
    if (!limit || this.compacting || this.disk.logSize <= limit) return
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

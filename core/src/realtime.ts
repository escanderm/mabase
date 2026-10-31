// Realtime (design.md §12): подписки по правилам, reset по dependsOn,
// события в сокет, клиентские события с allow/to, presence. Не зависит от
// транспорта: Bun.serve подключает его к WebSocket (server.ts), тесты - напрямую.
//
// Протокол - JSON-сообщения.
//   клиент -> сервер:
//     { type: 'hello', token? }                 первое сообщение, до 10 с
//     { type: 'auth', token }                   новый access-токен после обновления
//     { type: 'sub', id, collection, filter? }  подписка
//     { type: 'unsub', id }
//     { type: 'emit', event, data }             клиентское событие (from: 'client' в конфиге)
//     { type: 'ping' }
//   сервер -> клиент:
//     { type: 'ready', user, tx }
//     { type: 'subscribed', id, tx }
//     { type: 'changes', tx, items: [{ sub, op: 'added'|'updated', doc } | { sub, op: 'removed', id }] }
//     { type: 'reset', sub, tx }                фильтр правила изменился - перечитать
//     { type: 'revoked', sub }                  правило больше не пускает - подписка снята
//     { type: 'event', event, data, from?, tx?, eventId? }
//     { type: 'error', id?, code, message }
//     { type: 'pong' }
//   коды закрытия: 4000 - нет hello, 4001 - токен недействителен или сессия
//   закончилась (SDK обновит токен и переподключится), 4500 - сервер остановлен.
//
// Реконнект (клиент): подписаться -> складывать сообщения в буфер ->
// перечитать REST (ответ несёт tx) -> применить из буфера только tx больше.
import type { z } from 'zod'
import { and, type Access, type ClientSession } from './access'
import type { Auth } from './auth'
import type { CommitInfo, Doc, Query, User } from './db'
import { ActionError } from './errors'
import { compileQuery, type Matcher } from './query'
import type { Tail } from './tail'

type Collections = Access['db']['c']
type Awaitable<T> = T | Promise<T>

export type EventConfig = {
  from?: 'client' | 'server' // по умолчанию server: событие из emit() в транзакции
  input?: z.ZodType // для клиентских - обязательно
  allow?: (user: User, data: any, ctx: { db: Collections }) => Awaitable<boolean> // может ли отправитель
  to?: (data: any, ctx: { db: Collections }) => Awaitable<string[]> // id получателей, считается один раз
  broadcast?: 'all' | 'authenticated'
}

export type RealtimeOptions = {
  events?: Record<string, EventConfig>
  maxSubscriptions?: number // на соединение
  maxMessageBytes?: number
  clientEventsPerSecond?: number // на соединение; лишние отбрасываются с ошибкой
  helloTimeoutMs?: number
  verifyIntervalMs?: number // как часто перепроверять, что сессия жива; 5 с
  onError?: (err: unknown, where: string) => void
  tail?: Tail
}

export const PRESENCE = '_presence'

const EVENT_KEYS = new Set(['from', 'input', 'allow', 'to', 'broadcast'])

export function checkEvents(events: Record<string, EventConfig>): void {
  for (const [name, cfg] of Object.entries(events)) {
    for (const k of Object.keys(cfg)) {
      if (!EVENT_KEYS.has(k)) throw new TypeError(`events.${name}: неизвестное поле "${k}"`)
    }
    if (cfg.broadcast !== undefined && cfg.broadcast !== 'all' && cfg.broadcast !== 'authenticated') {
      throw new TypeError(`events.${name}.broadcast: 'all' или 'authenticated'. Для "кому можно" - to: (data) => id[]`)
    }
    if (cfg.to && cfg.broadcast) throw new TypeError(`events.${name}: либо to, либо broadcast`)
    if (!cfg.to && !cfg.broadcast) throw new TypeError(`events.${name}: кому доставлять - to или broadcast`)
    if (cfg.from === 'client') {
      if (!cfg.input) throw new TypeError(`events.${name}: клиентскому событию нужна схема input`)
      if (!cfg.allow) throw new TypeError(`events.${name}: клиентскому событию нужно allow - кто может его слать`)
    } else if (cfg.from !== undefined && cfg.from !== 'server') throw new TypeError(`events.${name}.from: 'client' или 'server'`)
  }
}

type Sub = { id: string; conn: Conn; collection: string; filter: Query; rule: Query; match: Matcher }

const errMsg = (err: unknown, id?: string) => {
  if (err instanceof ActionError) return { type: 'error', ...(id && { id }), code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) }
  return { type: 'error', ...(id && { id }), code: 'internal', message: 'Внутренняя ошибка сервера' }
}

export class Conn {
  readonly id = crypto.randomUUID()
  user: User | null = null
  session: ClientSession | null = null
  subs = new Map<string, Sub>()
  private ready = false
  private closed = false
  private token: string | null = null
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private sent: number[] = [] // время клиентских событий за последнюю секунду
  private queue: Promise<void> = Promise.resolve() // сообщения клиента - по порядку

  constructor(
    private rt: Realtime,
    private sendRaw: (text: string) => void,
    private closeRaw: (code: number, reason: string) => void,
  ) {
    this.timers.push(setTimeout(() => !this.ready && this.close(4000, 'нет hello'), rt.opts.helloTimeoutMs))
  }

  send(msg: object): void {
    if (!this.closed) this.sendRaw(JSON.stringify(msg))
  }

  close(code: number, reason: string): void {
    if (this.closed) return
    this.closeRaw(code, reason)
    void this.closedByClient()
  }

  receive(text: string): Promise<void> {
    return (this.queue = this.queue.then(() => this.handle(text)))
  }

  private async handle(text: string): Promise<void> {
    if (this.closed) return
    let msg: any
    if (text.length > this.rt.opts.maxMessageBytes) return this.send(errMsg(new ActionError('bad_request', 'Сообщение слишком большое')))
    try {
      msg = JSON.parse(text)
    } catch {
      return this.send(errMsg(new ActionError('bad_request', 'Сообщение - не JSON')))
    }
    const id = typeof msg?.id === 'string' ? msg.id : undefined
    try {
      if (!this.ready && msg?.type !== 'hello') throw new ActionError('bad_request', 'Первое сообщение - hello')
      switch (msg?.type) {
        case 'hello':
          return await this.hello(msg.token)
        case 'auth':
          return await this.reauth(msg.token)
        case 'sub':
          // Подписка синхронно считает правило list по базе: без лимита один
          // клиент в цикле занимает единственный процесс.
          if (!this.rateOk()) throw new ActionError('too_many_requests', 'Слишком часто: не больше 20 сообщений в секунду')
          return await this.rt.subscribe(this, msg)
        case 'unsub':
          if (id) this.rt.unsubscribe(this, id)
          return
        case 'emit':
          return await this.rt.clientEvent(this, msg.event, msg.data, this.rateOk())
        case 'ping':
          return this.send({ type: 'pong' })
      }
      throw new ActionError('bad_request', `Неизвестный тип сообщения ${JSON.stringify(msg?.type)}`)
    } catch (err) {
      if (!(err instanceof ActionError)) this.rt.opts.onError(err, `realtime ${msg?.type}`)
      this.send(errMsg(err, id))
    }
  }

  private rateOk(): boolean {
    const now = performance.now()
    this.sent = this.sent.filter((t) => now - t < 1000)
    if (this.sent.length >= this.rt.opts.clientEventsPerSecond) return false
    this.sent.push(now)
    return true
  }

  private async hello(token: unknown): Promise<void> {
    if (this.ready) throw new ActionError('bad_request', 'hello уже был')
    const user = token === undefined || token === null ? null : await this.rt.auth.verify(token)
    if (token != null && !user) return this.close(4001, 'токен недействителен или истёк')
    this.token = typeof token === 'string' ? token : null
    this.setUser(user)
    try {
      await this.rt.attach(this)
    } catch (err) {
      // Без attach (presence) соединение не готово: клиент должен получить
      // закрытие и обычный реконнект, а не висеть в 'connecting' навсегда.
      this.close(4500, 'не удалось подключить соединение')
      throw err
    }
    this.ready = true
    this.send({ type: 'ready', user: user?.id ?? null, tx: this.rt.db.lastTx })
    // Сессию закрыли (выход, смена пароля, удаление) - соединение закрывается.
    // Роли поменялись - правила подписок пересчитываются.
    const tick = setInterval(() => void this.reverify(), this.rt.opts.verifyIntervalMs)
    this.timers.push(tick as unknown as ReturnType<typeof setTimeout>)
  }

  private async reauth(token: unknown): Promise<void> {
    const user = await this.rt.auth.verify(token)
    if (!user || user.id !== this.user?.id) return this.close(4001, 'токен другого пользователя или недействителен')
    this.token = token as string
    await this.applyUser(user)
  }

  async reverify(): Promise<void> {
    if (!this.token || this.closed) return
    const user = await this.rt.auth.verify(this.token)
    if (!user) return this.close(4001, 'сессия закончилась')
    await this.applyUser(user)
  }

  private async applyUser(user: User): Promise<void> {
    const same = JSON.stringify(user.roles ?? []) === JSON.stringify(this.user?.roles ?? [])
    this.setUser(user)
    if (!same) await this.rt.recheck([...this.subs.values()], this.rt.db.lastTx)
  }

  private setUser(user: User | null): void {
    this.user = user
    this.session = this.rt.access.forUser(user)
  }

  private done: Promise<void> | null = null

  // Транспорт сообщил о закрытии (или закрыли мы). Повторный вызов ждёт того же.
  closedByClient(): Promise<void> {
    return (this.done ??= (async () => {
      this.closed = true
      for (const t of this.timers) clearTimeout(t)
      await this.rt.detach(this)
    })())
  }
}

export class Realtime {
  readonly opts: Required<Omit<RealtimeOptions, 'tail'>> & { tail?: Tail }
  readonly db: Access['db']
  private byCollection = new Map<string, Set<Sub>>()
  private byUser = new Map<string, Set<Conn>>()
  private conns = new Set<Conn>()
  private chain: Promise<void> = Promise.resolve() // коммиты - строго по порядку

  constructor(
    readonly access: Access,
    readonly auth: Auth,
    opts: RealtimeOptions = {},
  ) {
    this.db = access.db
    this.opts = {
      events: opts.events ?? {},
      maxSubscriptions: opts.maxSubscriptions ?? 100,
      maxMessageBytes: opts.maxMessageBytes ?? 64 << 10,
      clientEventsPerSecond: opts.clientEventsPerSecond ?? 20,
      helloTimeoutMs: opts.helloTimeoutMs ?? 10_000,
      // Выход и смена пароля должны закрывать и открытый сокет. Мгновенно это
      // делает проверка на каждом событии, но подписка может молчать - поэтому
      // перепроверяем раз в 5 секунд, а не раз в минуту.
      verifyIntervalMs: opts.verifyIntervalMs ?? 5_000,
      onError: opts.onError ?? ((err, where) => console.error(`[mabase] ошибка в ${where}`, err)),
      tail: opts.tail,
    }
    checkEvents(this.opts.events)
    this.db.onCommit((info) => {
      this.chain = this.chain.then(() => this.process(info)).catch((err) => this.opts.onError(err, 'realtime: коммит'))
    })
  }

  // Presence от прошлого запуска - устаревшие соединения: стереть.
  async start(): Promise<void> {
    await this.db.c[PRESENCE]!.removeMany({})
  }

  connect(send: (text: string) => void, close: (code: number, reason: string) => void): Conn {
    const c = new Conn(this, send, close)
    this.conns.add(c)
    return c
  }

  get connections(): number {
    return this.conns.size
  }

  // Все коммиты, обработанные до этого момента, доставлены. Для тестов.
  settled(): Promise<void> {
    return this.chain
  }

  async attach(c: Conn): Promise<void> {
    if (!c.user) return
    let set = this.byUser.get(c.user.id)
    if (!set) this.byUser.set(c.user.id, (set = new Set()))
    set.add(c)
    const userId = c.user.id
    await this.db.transaction(async (tx) => {
      await tx.c[PRESENCE]!.insert({ _id: c.id, userId, connectedAt: Date.now() })
      if ((await tx.c[PRESENCE]!.count({ userId })) === 1) tx.emit('user.online', { userId })
    })
    this.opts.tail?.publish('ws', { op: 'open', userId, conns: this.conns.size })
  }

  async detach(c: Conn): Promise<void> {
    this.conns.delete(c)
    for (const s of c.subs.values()) this.byCollection.get(s.collection)?.delete(s)
    c.subs.clear()
    if (!c.user) return
    const userId = c.user.id
    this.byUser.get(userId)?.delete(c)
    if (!this.byUser.get(userId)?.size) this.byUser.delete(userId)
    try {
      await this.db.transaction(async (tx) => {
        if (!(await tx.c[PRESENCE]!.findOne({ _id: c.id }, { fields: ['_id'] }))) return
        await tx.c[PRESENCE]!.remove(c.id)
        if ((await tx.c[PRESENCE]!.count({ userId })) === 0) tx.emit('user.offline', { userId })
      })
    } catch (err) {
      this.opts.onError(err, 'realtime: presence')
    }
    this.opts.tail?.publish('ws', { op: 'close', userId, conns: this.conns.size })
  }

  async subscribe(c: Conn, msg: any): Promise<void> {
    const { id, collection } = msg
    const filter = msg.filter ?? {}
    if (typeof id !== 'string' || !id || id.length > 64) throw new ActionError('bad_request', 'id подписки - строка до 64 символов')
    if (typeof collection !== 'string') throw new ActionError('bad_request', 'collection - строка')
    if (c.subs.has(id)) throw new ActionError('conflict', `Подписка ${id} уже есть`)
    if (c.subs.size >= this.opts.maxSubscriptions) throw new ActionError('too_many_requests', `Не больше ${this.opts.maxSubscriptions} подписок на соединение`)
    const session: ClientSession = c.session!
    session.checkFilter(collection, filter)
    const before = this.db.lastTx
    const rule = await session.ruleFilter(collection, 'list', this.db.c)
    const sub: Sub = { id, conn: c, collection, filter, rule, match: compileQuery(and(rule, filter)) }
    c.subs.set(id, sub)
    let set = this.byCollection.get(collection)
    if (!set) this.byCollection.set(collection, (set = new Set()))
    set.add(sub)
    // Пока считалось правило, мог пройти коммит в коллекцию из dependsOn -
    // и пересчёт подписок прошёл мимо этой. Досчитать: клиент ещё не читал.
    if (this.db.lastTx !== before) await this.recheck([sub], this.db.lastTx, { silent: true })
    if (c.subs.has(id)) c.send({ type: 'subscribed', id, tx: this.db.lastTx })
  }

  unsubscribe(c: Conn, id: string): void {
    const s = c.subs.get(id)
    if (!s) return
    c.subs.delete(id)
    this.byCollection.get(s.collection)?.delete(s)
  }

  // Пересчитать фильтр правила. Изменился - reset; правило больше не пускает - revoked.
  async recheck(subs: Sub[], tx: number, opts: { silent?: boolean } = {}): Promise<void> {
    for (const s of subs) {
      if (s.conn.subs.get(s.id) !== s) continue
      let rule: Query
      try {
        rule = await s.conn.session!.ruleFilter(s.collection, 'list', this.db.c)
      } catch (err) {
        if (!(err instanceof ActionError)) this.opts.onError(err, `realtime: правило ${s.collection}.list`)
        this.unsubscribe(s.conn, s.id)
        s.conn.send({ type: 'revoked', sub: s.id })
        continue
      }
      if (JSON.stringify(rule) === JSON.stringify(s.rule)) continue
      s.rule = rule
      s.match = compileQuery(and(rule, s.filter))
      if (!opts.silent) s.conn.send({ type: 'reset', sub: s.id, tx })
    }
  }

  // Коммит: сначала правила по dependsOn (иначе выгнанный успеет получить
  // сообщение комнаты), потом изменения записей, потом события.
  private async process(info: CommitInfo): Promise<void> {
    const touched = new Set(info.changes.map((ch) => ch.c))
    const deps = new Set<string>()
    for (const c of touched) for (const d of this.access.dependents(c)) deps.add(d)
    for (const d of deps) await this.recheck([...(this.byCollection.get(d) ?? [])], info.tx)

    const out = new Map<Conn, object[]>()
    for (const ch of info.changes) {
      const subs = this.byCollection.get(ch.c)
      if (!subs?.size) continue
      for (const s of subs) {
        const was = !!ch.prev && s.match(ch.prev as Doc)
        const now = !!ch.doc && s.match(ch.doc as Doc)
        if (!was && !now) continue
        let item: object
        if (now) item = { sub: s.id, op: was ? 'updated' : 'added', doc: s.conn.session!.strip(ch.c, ch.doc as Doc) }
        else item = { sub: s.id, op: 'removed', id: ch.id } // без данных: доступа больше нет
        let list = out.get(s.conn)
        if (!list) out.set(s.conn, (list = []))
        list.push(item)
      }
    }
    for (const [conn, items] of out) conn.send({ type: 'changes', tx: info.tx, items })

    for (let i = 0; i < info.events.length; i++) {
      const { event, data } = info.events[i]!
      const cfg = this.opts.events[event]
      if (!cfg || cfg.from === 'client') continue // без описания событие - только для on() на сервере
      await this.deliver(cfg, { type: 'event', event, data, tx: info.tx, eventId: `${info.tx}:${i}` })
    }
  }

  private async deliver(cfg: EventConfig, msg: object): Promise<number> {
    let targets: Iterable<Conn>
    if (cfg.broadcast === 'all') targets = this.conns
    else if (cfg.broadcast === 'authenticated') targets = [...this.conns].filter((c) => c.user)
    else {
      const ids = await cfg.to!((msg as any).data, { db: this.db.c })
      targets = (Array.isArray(ids) ? [...new Set(ids)] : []).flatMap((id) => [...(this.byUser.get(id) ?? [])])
    }
    let n = 0
    for (const c of targets) {
      c.send(msg)
      n++
    }
    return n
  }

  // Клиентское событие: только объявленное с from: 'client', схема, allow,
  // получатели из to. from в сообщении ставит сервер.
  async clientEvent(c: Conn, event: unknown, raw: unknown, rateOk: boolean): Promise<void> {
    const cfg = typeof event === 'string' ? this.opts.events[event] : undefined
    if (!cfg || cfg.from !== 'client') throw new ActionError('forbidden', `Событие ${String(event)} нельзя слать с клиента`)
    if (!c.user) throw new ActionError('unauthorized', 'Нужен вход')
    if (!rateOk) throw new ActionError('too_many_requests', 'Слишком много событий')
    const r = cfg.input!.safeParse(raw)
    if (!r.success) throw new ActionError('bad_request', 'Неверные данные события', r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })))
    if (!(await cfg.allow!(c.user, r.data, { db: this.db.c }))) throw new ActionError('forbidden', 'Нет доступа')
    const n = await this.deliver(cfg, { type: 'event', event, from: c.user.id, data: r.data })
    this.opts.tail?.publish('client', { event, from: c.user.id, to: n })
  }

  // Остановка сервера: закрыть все соединения.
  async stop(): Promise<void> {
    // 4500, а не 1001: Bun 1.3.12 отдаёт клиенту 1001 как 1000
    for (const c of [...this.conns]) c.close(4500, 'сервер остановлен')
    for (const c of [...this.conns]) await c.closedByClient()
    await this.chain
  }
}

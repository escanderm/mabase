// SDK MaBase для браузера - mabase/client (design.md §12). Без зависимостей:
// fetch, WebSocket, localStorage. В Bun работает так же (тесты).
//
//   const mb = createClient('https://chat.example.test')
//   await mb.auth.login({ email, password })
//   const feed = mb.live('messages', { roomId }, { sort: { _id: -1 }, limit: 50 })
//   feed.subscribe((list) => render(list))
//
// live() = подписка + чтение + перечитывание при реконнекте и reset.
// Токены SDK хранит и обновляет сам.
import { comparator, normalizeSort, parseSort } from './order'
import type { Doc } from './paths'

export class MabaseError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'MabaseError'
  }
}

export type KeyValueStorage = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export type ClientOptions = {
  storage?: KeyValueStorage // где хранить сессию; по умолчанию localStorage (общий для вкладок)
  sessionStorage?: KeyValueStorage // verifier OAuth на время перехода к провайдеру
  fetch?: typeof fetch
  WebSocket?: typeof WebSocket
  authphoneUrl?: string
  refreshBeforeMs?: number // обновить access-токен заранее; 60 с
  reconnectMs?: { min: number; max: number } // пауза перед переподключением растёт от min до max
  pingMs?: number
}

export type User = Doc & { id: string }
type Session = { user: Doc; accessToken: string; accessExpiresAt: number; refreshToken: string }
export type ConnectionState = 'offline' | 'connecting' | 'online' | 'reconnecting'
// expand: связанные документы в doc._expand.<поле> (поле объявлено связью)
export type FindOptions = { sort?: Record<string, 1 | -1>; limit?: number; fields?: string[]; expand?: string[] }
export type LiveOptions = FindOptions & { parent?: [collection: string, id: string] }

function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

function defaultStorage(name: 'localStorage' | 'sessionStorage'): KeyValueStorage {
  try {
    const s = (globalThis as any)[name] as KeyValueStorage | undefined
    if (s) {
      s.getItem('__mabase')
      return s
    }
  } catch {}
  return memoryStorage()
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function sha256b64url(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
}

export function createClient(url: string, opts: ClientOptions = {}): MabaseClient {
  return new MabaseClient(url, opts)
}

export class MabaseClient {
  readonly url: string
  readonly auth: AuthClient
  readonly c: Record<string, CollectionClient>
  /** @internal */ readonly opts: Required<Omit<ClientOptions, 'fetch' | 'WebSocket'>> & { fetch: typeof fetch; WebSocket: typeof WebSocket }
  /** @internal */ socket: Socket
  private listeners = new Map<string, Set<(arg: any) => void>>()

  constructor(url: string, opts: ClientOptions) {
    this.url = url.replace(/\/$/, '')
    this.opts = {
      storage: opts.storage ?? defaultStorage('localStorage'),
      sessionStorage: opts.sessionStorage ?? defaultStorage('sessionStorage'),
      fetch: opts.fetch ?? ((...a) => fetch(...a)),
      WebSocket: opts.WebSocket ?? (globalThis as any).WebSocket,
      authphoneUrl: (opts.authphoneUrl ?? 'https://authphone.su').replace(/\/$/, ''),
      refreshBeforeMs: opts.refreshBeforeMs ?? 60_000,
      reconnectMs: opts.reconnectMs ?? { min: 500, max: 10_000 },
      pingMs: opts.pingMs ?? 30_000,
    }
    this.auth = new AuthClient(this)
    this.socket = new Socket(this)
    const cache = new Map<string, CollectionClient>()
    this.c = new Proxy({} as Record<string, CollectionClient>, {
      get: (_, name) => {
        if (typeof name !== 'string') return undefined
        let c = cache.get(name)
        if (!c) cache.set(name, (c = new CollectionClient(this, name)))
        return c
      },
    })
  }

  // HTTP с токеном. 401 при токене - обновить токен и повторить один раз.
  async request<T = any>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    await this.auth.fresh()
    const token = this.auth.session?.accessToken
    const res = await this.opts.fetch(this.url + path, {
      method,
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 401 && token && retry && (await this.auth.refresh())) return this.request(method, path, body, false)
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      throw new MabaseError('internal', `Ответ сервера - не JSON (${res.status})`, res.status)
    }
    if (!res.ok) throw new MabaseError(data?.code ?? 'internal', data?.message ?? `HTTP ${res.status}`, res.status, data?.details)
    return data
  }

  action<R = any>(name: string, input?: unknown): Promise<R> {
    return this.request('POST', `/api/actions/${encodeURIComponent(name)}`, input ?? {})
  }

  live<T extends Doc = Doc>(collection: string, filter: Record<string, unknown> = {}, opts: LiveOptions = {}): Live<T> {
    // Связанные документы меняются отдельно от списка - в живой выборке их пока нет
    if (opts.expand?.length) throw new TypeError('live(): expand пока не поддерживается - связанные документы подтягивайте через find или отдельной live()')
    return new Live<T>(this, collection, filter, opts)
  }

  // Клиентское событие: только объявленные с from: 'client'. Ответа нет;
  // ошибки - в mb.on('error').
  emit(event: string, data: unknown): void {
    this.socket.send({ type: 'emit', event, data })
  }

  // Событие с сервера; 'connection' - состояние соединения; 'error' - ошибки сокета.
  on(event: string, fn: (arg: any) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn)
    if (event !== 'connection' && event !== 'error') this.socket.retain()
    return () => {
      if (set!.delete(fn) && event !== 'connection' && event !== 'error') this.socket.release()
    }
  }

  /** @internal */ fire(event: string, arg: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(arg)
      } catch (err) {
        console.error('[mabase] ошибка в обработчике', event, err)
      }
    }
  }

  close(): void {
    this.socket.shutdown()
    this.auth.stopTimer()
  }
}

// ---------- вход и токены ----------

class AuthClient {
  session: Session | null = null
  private key: string
  private refreshing: Promise<boolean> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<(user: User | null) => void>()
  readonly phone: { start: (phone: string) => Promise<void>; verify: (phone: string, code: string) => Promise<User> }

  constructor(private mb: MabaseClient) {
    this.key = `mabase:${mb.url}`
    this.session = this.read()
    this.schedule()
    this.phone = {
      // Код запрашивает браузер: лимит authphone.su - на IP пользователя, а не сервера.
      start: async (phone) => {
        const res = await mb.opts.fetch(`${mb.opts.authphoneUrl}/generate-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneNumber: phone }),
        })
        if (!res.ok) throw new MabaseError(res.status === 429 ? 'too_many_requests' : 'unavailable', 'authphone.su не выдал код', res.status)
      },
      verify: async (phone, code) => this.set(await mb.request('POST', '/api/auth/phone', { phone, code })),
    }
  }

  get user(): User | null {
    return this.session ? { ...this.session.user, id: this.session.user._id } : null
  }

  onChange(fn: (user: User | null) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async login(input: { email: string; password: string }): Promise<User> {
    return this.set(await this.mb.request('POST', '/api/auth/login', input))
  }

  async register(input: { email: string; password: string; data?: Record<string, unknown> }): Promise<User> {
    return this.set(await this.mb.request('POST', '/api/auth/register', input))
  }

  async logout(): Promise<void> {
    const s = this.session
    this.set(null)
    if (s) await this.mb.request('POST', '/api/auth/logout', { refreshToken: s.refreshToken }).catch(() => {})
  }

  // После перезагрузки страницы: сессия из хранилища, свежий профиль. Нет сессии - null.
  async restore(): Promise<User | null> {
    this.session = this.read()
    if (!this.session) return null
    try {
      const me = await this.mb.request<Doc>('GET', '/api/auth/me')
      if (this.session) {
        this.session = { ...this.session, user: me }
        this.write()
      }
      return this.user
    } catch (err) {
      if (err instanceof MabaseError && err.status === 401) this.set(null)
      else throw err
      return null
    }
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    this.set(await this.mb.request('POST', '/api/auth/password', { oldPassword, newPassword }))
  }

  requestVerification = () => this.mb.request<void>('POST', '/api/auth/verify-email/request')
  confirmVerification = (token: string) => this.mb.request<void>('POST', '/api/auth/verify-email/confirm', { token })
  requestPasswordReset = (email: string) => this.mb.request<void>('POST', '/api/auth/reset-password/request', { email })
  confirmPasswordReset = (token: string, password: string) => this.mb.request<void>('POST', '/api/auth/reset-password/confirm', { token, password })
  requestEmailChange = (newEmail: string, password?: string) => this.mb.request<void>('POST', '/api/auth/change-email/request', { newEmail, password })
  confirmEmailChange = (token: string) => this.mb.request<void>('POST', '/api/auth/change-email/confirm', { token })

  // Вход через Google/GitHub: verifier остаётся в браузере, на сервер уходит sha256.
  // В браузере - переход к провайдеру; иначе - адрес, куда перейти.
  async oauth(provider: string, opts: { returnTo?: string } = {}): Promise<string> {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
    this.mb.opts.sessionStorage.setItem(`${this.key}:oauth`, verifier)
    const { url } = await this.mb.request('POST', `/api/auth/oauth/${encodeURIComponent(provider)}/start`, {
      challenge: await sha256b64url(verifier),
      returnTo: opts.returnTo,
    })
    ;(globalThis as any).location?.assign?.(url)
    return url
  }

  // На странице возврата: код из # меняется на токены. Нет кода - null.
  async completeOAuth(hash: string = (globalThis as any).location?.hash ?? ''): Promise<User | null> {
    const h = new URLSearchParams(hash.replace(/^#/, ''))
    const code = h.get('mb_oauth')
    const error = h.get('mb_oauth_error')
    if (!code && !error) return null
    const loc = (globalThis as any).location
    ;(globalThis as any).history?.replaceState?.(null, '', loc ? loc.pathname + loc.search : '') // код из адресной строки - убрать
    if (error) throw new MabaseError(error, `Вход не удался: ${error}`)
    const verifier = this.mb.opts.sessionStorage.getItem(`${this.key}:oauth`)
    this.mb.opts.sessionStorage.removeItem(`${this.key}:oauth`)
    if (!verifier) throw new MabaseError('invalid_state', 'Вход начат в другой вкладке или устарел')
    return this.set(await this.mb.request('POST', '/api/auth/oauth/exchange', { code, verifier }))
  }

  unlink = (provider: string) => this.mb.request<void>('DELETE', `/api/auth/oauth/${encodeURIComponent(provider)}`)

  // Токен истекает - обновить до запроса.
  /** @internal */ async fresh(): Promise<void> {
    if (this.session && this.session.accessExpiresAt - Date.now() < 5_000) await this.refresh()
  }

  // Одно обновление на все одновременные запросы. 409 - другая вкладка уже
  // обновила: взять её токен из общего хранилища. false - сессии больше нет.
  /** @internal */ refresh(): Promise<boolean> {
    return (this.refreshing ??= (async () => {
      try {
        const s = this.session
        if (!s) return false
        const res = await this.mb.opts.fetch(this.mb.url + '/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: s.refreshToken }),
        })
        if (res.ok) {
          this.set(await res.json(), { quiet: true })
          return true
        }
        if (res.status === 409) {
          const stored = this.read()
          if (stored && stored.refreshToken !== s.refreshToken) {
            this.session = stored
            this.schedule()
            this.mb.socket.reauth()
            return true
          }
        }
        if (res.status === 401 || res.status === 409) {
          this.set(null)
          return false
        }
        throw new MabaseError('unavailable', `Обновление токена: HTTP ${res.status}`, res.status)
      } finally {
        this.refreshing = null
      }
    })())
  }

  private set(s: Session | null, opts: { quiet?: boolean } = {}): User {
    const before = this.session?.user._id ?? null
    this.session = s
    this.write()
    this.schedule()
    const after = s?.user._id ?? null
    if (before !== after) {
      this.mb.socket.userChanged() // другой пользователь - другие правила: переподключиться
      for (const fn of this.listeners) fn(this.user)
    } else if (!opts.quiet || s) this.mb.socket.reauth()
    return this.user!
  }

  private read(): Session | null {
    try {
      const raw = this.mb.opts.storage.getItem(this.key)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  private write(): void {
    try {
      if (this.session) this.mb.opts.storage.setItem(this.key, JSON.stringify(this.session))
      else this.mb.opts.storage.removeItem(this.key)
    } catch {}
  }

  private schedule(): void {
    this.stopTimer()
    if (!this.session) return
    const ms = Math.max(1_000, this.session.accessExpiresAt - Date.now() - this.mb.opts.refreshBeforeMs)
    this.timer = setTimeout(() => void this.refresh().catch(() => this.schedule()), ms)
  }

  stopTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

// ---------- коллекции ----------

const query = (filter: unknown, opts: FindOptions = {}) => {
  const q = new URLSearchParams()
  if (filter && Object.keys(filter).length) q.set('filter', JSON.stringify(filter))
  if (opts.sort) q.set('sort', JSON.stringify(opts.sort))
  if (opts.limit !== undefined) q.set('limit', String(opts.limit))
  if (opts.fields) q.set('fields', opts.fields.join(','))
  if (opts.expand?.length) q.set('expand', opts.expand.join(','))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export class CollectionClient<T extends Doc = Doc> {
  private base: string
  constructor(
    private mb: MabaseClient,
    readonly name: string,
  ) {
    this.base = `/api/c/${encodeURIComponent(name)}`
  }

  /** @internal */ list(filter: Record<string, unknown>, opts: FindOptions): Promise<{ items: T[]; tx: number }> {
    return this.mb.request('GET', this.base + query(filter, opts))
  }

  async find(filter: Record<string, unknown> = {}, opts: FindOptions = {}): Promise<T[]> {
    return (await this.list(filter, opts)).items
  }

  async count(filter: Record<string, unknown> = {}): Promise<number> {
    const q = query(filter)
    return (await this.mb.request('GET', `${this.base}${q ? q + '&' : '?'}count=1`)).count
  }

  get(id: string, opts: { fields?: string[]; expand?: string[] } = {}): Promise<T> {
    return this.mb.request('GET', `${this.base}/${encodeURIComponent(id)}${query({}, opts)}`)
  }

  insert(doc: Partial<T> & Record<string, unknown>): Promise<T> {
    return this.mb.request('POST', this.base, doc)
  }

  update(id: string, ops: Record<string, unknown>): Promise<T> {
    return this.mb.request('PATCH', `${this.base}/${encodeURIComponent(id)}`, ops)
  }

  remove(id: string): Promise<void> {
    return this.mb.request('DELETE', `${this.base}/${encodeURIComponent(id)}`)
  }
}

// ---------- соединение ----------

type ServerMsg = { type: string; [k: string]: any }

class Socket {
  state: ConnectionState = 'offline'
  private ws: WebSocket | null = null
  private users = 0 // сколько live() и обработчиков событий держат соединение
  private lives = new Map<string, Live<any>>()
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private seq = 0

  constructor(private mb: MabaseClient) {}

  nextId(): string {
    return `l${++this.seq}`
  }

  retain(): void {
    this.users++
    if (this.state === 'offline' && !this.stopped) this.open()
  }

  release(): void {
    if (--this.users <= 0) {
      this.users = 0
      this.closeWs()
      this.setState('offline')
    }
  }

  addLive(l: Live<any>): void {
    this.lives.set(l.subId, l)
    this.retain()
    if (this.state === 'online') l.attach()
  }

  removeLive(l: Live<any>): void {
    if (!this.lives.delete(l.subId)) return
    this.send({ type: 'unsub', id: l.subId })
    this.release()
  }

  send(msg: object): boolean {
    if (this.state !== 'online' || !this.ws) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  // Новый токен того же пользователя - серверу, без переподключения.
  reauth(): void {
    const t = this.mb.auth.session?.accessToken
    if (t) this.send({ type: 'auth', token: t })
  }

  userChanged(): void {
    if (!this.ws) return
    this.closeWs()
    this.open()
  }

  shutdown(): void {
    this.stopped = true
    this.closeWs()
    this.setState('offline')
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return
    this.state = s
    this.mb.fire('connection', s)
  }

  private open(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.setState(this.attempt ? 'reconnecting' : 'connecting')
    const ws = new this.mb.opts.WebSocket(this.mb.url.replace(/^http/, 'ws') + '/api/realtime')
    this.ws = ws
    ws.onopen = async () => {
      if (this.ws !== ws) return
      await this.mb.auth.fresh().catch(() => {})
      ws.send(JSON.stringify({ type: 'hello', token: this.mb.auth.session?.accessToken }))
    }
    ws.onmessage = (e) => {
      if (this.ws !== ws) return
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }
      this.dispatch(msg)
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.pingTimer) clearInterval(this.pingTimer)
      for (const l of this.lives.values()) l.detached()
      if (this.stopped || this.users === 0) return this.setState('offline')
      this.setState('reconnecting')
      // 4001: токен или сессия - обновить и сразу переподключиться
      if (e.code === 4001) {
        void this.mb.auth.refresh().catch(() => false).then(() => this.open())
        return
      }
      const { min, max } = this.mb.opts.reconnectMs
      const delay = Math.min(max, min * 2 ** this.attempt++) * (0.75 + Math.random() / 2)
      this.retryTimer = setTimeout(() => this.open(), delay)
    }
  }

  private closeWs(): void {
    const ws = this.ws
    this.ws = null
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    for (const l of this.lives.values()) l.detached()
    try {
      ws?.close(1000)
    } catch {}
  }

  private dispatch(msg: ServerMsg): void {
    switch (msg.type) {
      case 'ready':
        this.attempt = 0
        this.setState('online')
        if (this.pingTimer) clearInterval(this.pingTimer)
        this.pingTimer = setInterval(() => this.send({ type: 'ping' }), this.mb.opts.pingMs)
        for (const l of this.lives.values()) l.attach()
        return
      case 'subscribed':
        this.lives.get(msg.id)?.subscribed()
        return
      case 'changes': {
        const bySub = new Map<string, any[]>()
        for (const it of msg.items) {
          let list = bySub.get(it.sub)
          if (!list) bySub.set(it.sub, (list = []))
          list.push(it)
        }
        for (const [sub, items] of bySub) this.lives.get(sub)?.changes(msg.tx, items)
        return
      }
      case 'reset':
        this.lives.get(msg.sub)?.reset()
        return
      case 'revoked':
        this.lives.get(msg.sub)?.revoked()
        return
      case 'event':
        this.mb.fire(msg.event, { event: msg.event, data: msg.data, from: msg.from, tx: msg.tx })
        return
      case 'error': {
        const err = new MabaseError(msg.code, msg.message, 0, msg.details)
        const l = msg.id ? this.lives.get(msg.id) : undefined
        if (l) l.failed(err)
        else this.mb.fire('error', err)
        return
      }
    }
  }
}

// ---------- живая выборка ----------

type Change = { op: 'added' | 'updated' | 'removed'; doc?: Doc; id?: string }

// Состояние = чтение REST (на tx) + изменения с большим tx. Пока идёт чтение,
// изменения копятся в буфере. Новые записи, которые по сортировке позже
// последней загруженной, не добавляются: их принесёт loadMore.
export class Live<T extends Doc = Doc> {
  items: T[] = []
  loaded = false
  readonly subId: string
  private listeners = new Map<string, Set<(arg: any) => void>>()
  private cmp: (a: Doc, b: Doc) => number
  private buffer: Array<{ tx: number; items: Change[] }> | null = null
  private during: Array<{ tx: number; items: Change[] }> | null = null // изменения во время loadMore
  private size: number // сколько записей держим: limit + loadMore
  private exhausted = false // загружено всё, что есть
  private rereading = false
  private again = false
  private closed = false

  constructor(
    private mb: MabaseClient,
    readonly collection: string,
    readonly filter: Record<string, unknown>,
    readonly opts: LiveOptions,
  ) {
    this.subId = mb.socket.nextId()
    this.cmp = comparator(normalizeSort(parseSort(opts.sort)))
    this.size = opts.limit ?? 100
    mb.socket.addLive(this)
  }

  subscribe(fn: (items: T[]) => void): () => void {
    const off = this.on('change', fn)
    if (this.loaded) fn(this.items)
    return off
  }

  on(event: 'change' | 'reset' | 'revoked' | 'error', fn: (arg: any) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn)
    return () => set!.delete(fn)
  }

  // Ещё n записей после последней. 0 - больше нет.
  async loadMore(n: number): Promise<number> {
    if (this.exhausted || this.closed || !this.loaded) return 0
    const last = this.items.at(-1)
    const cursor = last ? this.after(last) : {}
    this.during = []
    try {
      const page = await this.mb.c[this.collection]!.list(and(this.filter, cursor), { sort: this.opts.sort, limit: n, fields: this.opts.fields })
      const have = new Set(this.items.map((d) => d._id))
      for (const d of page.items) if (!have.has(d._id)) this.items.push(d as T)
      this.size += n
      this.exhausted = page.items.length < n
      // изменения, пришедшие во время чтения страницы и после её tx, - поверх
      for (const b of this.during) if (b.tx > page.tx) this.apply(b.items)
      this.items.sort(this.cmp)
      this.emit('change', this.items)
      return page.items.length
    } finally {
      this.during = null
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.mb.socket.removeLive(this)
  }

  // ----- от соединения -----

  /** @internal */ attach(): void {
    if (this.closed) return
    this.buffer = []
    this.mb.socket.send({ type: 'sub', id: this.subId, collection: this.collection, filter: this.filter })
  }

  /** @internal */ detached(): void {
    this.buffer = null
  }

  /** @internal */ subscribed(): void {
    void this.reread()
  }

  /** @internal */ changes(tx: number, items: Change[]): void {
    if (this.closed) return
    if (this.buffer) return void this.buffer.push({ tx, items })
    this.during?.push({ tx, items })
    this.apply(items)
    this.items.sort(this.cmp)
    this.emit('change', this.items)
  }

  /** @internal */ reset(): void {
    this.emit('reset', undefined)
    void this.reread()
  }

  /** @internal */ revoked(): void {
    this.items = []
    this.emit('change', this.items)
    this.emit('revoked', undefined)
    this.close()
  }

  /** @internal */ failed(err: MabaseError): void {
    this.emit('error', err)
  }

  // ----- внутреннее -----

  private async reread(): Promise<void> {
    if (this.rereading) {
      this.again = true
      return
    }
    this.rereading = true
    this.buffer ??= []
    try {
      do {
        this.again = false
        const limit = Math.max(this.size, this.items.length) // окно не сжимается после loadMore
        const r = await this.mb.c[this.collection]!.list(this.filter, { sort: this.opts.sort, limit, fields: this.opts.fields })
        if (this.closed) return
        this.items = r.items as T[]
        this.exhausted = r.items.length < limit
        const buffered = this.buffer ?? []
        this.buffer = []
        for (const b of buffered) if (b.tx > r.tx) this.apply(b.items)
      } while (this.again)
      this.buffer = null
      this.items.sort(this.cmp)
      this.loaded = true
      if (this.opts.parent && !(await this.parentVisible())) return this.revoked()
      this.emit('change', this.items)
    } catch (err) {
      this.buffer = null
      this.emit('error', err)
    } finally {
      this.rereading = false
    }
  }

  // Родитель (комната для ленты) больше не виден - доступа нет: revoked.
  private async parentVisible(): Promise<boolean> {
    const [c, id] = this.opts.parent!
    try {
      await this.mb.c[c]!.get(id, { fields: ['_id'] })
      return true
    } catch (err) {
      if (err instanceof MabaseError && (err.status === 404 || err.status === 403)) return false
      throw err
    }
  }

  private apply(changes: Change[]): void {
    for (const ch of changes) {
      if (ch.op === 'removed') {
        this.items = this.items.filter((d) => d._id !== ch.id)
        continue
      }
      const doc = ch.doc as T
      const i = this.items.findIndex((d) => d._id === doc._id)
      if (i >= 0) this.items[i] = doc
      else if (this.exhausted || this.items.length === 0 || this.cmp(doc, this.items.at(-1)!) < 0) this.items.push(doc)
    }
  }

  // Фильтр "после записи last" в порядке сортировки (курсор для loadMore).
  private after(last: Doc): Record<string, unknown> {
    const keys = normalizeSort(parseSort(this.opts.sort))
    const or: Array<Record<string, unknown>> = []
    for (let i = 0; i < keys.length; i++) {
      const cond: Record<string, unknown> = {}
      for (let j = 0; j < i; j++) cond[keys[j]![0]] = getValue(last, keys[j]![0]) ?? null
      const [path, dir] = keys[i]!
      cond[path] = { [dir === 1 ? '$gt' : '$lt']: getValue(last, path) ?? null }
      or.push(cond)
    }
    return or.length === 1 ? or[0]! : { $or: or }
  }

  private emit(event: string, arg: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(arg)
      } catch (err) {
        console.error('[mabase] ошибка в обработчике live', err)
      }
    }
  }
}

function getValue(doc: Doc, path: string): unknown {
  let cur: any = doc
  for (const p of path.split('.')) cur = cur?.[p]
  return cur
}

const and = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  !Object.keys(a).length ? b : !Object.keys(b).length ? a : { $and: [a, b] }

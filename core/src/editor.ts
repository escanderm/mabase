// Типы для редактора (design.md §5): при старте MaBase кладёт в папку данных
// types.d.ts и типы zod рядом. В mabase.config.ts и mb_hooks/*.ts тогда
// работает автодополнение `import { defineCollection, z, on } from 'mabase'`
// без node_modules и без сборки.
//
// Файлы перезаписываются только если изменились: редактор не должен видеть
// мигание на каждом старте.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Внутри бинарника node_modules нет - типы zod вшиты сборкой (build.ts).
const compiled = import.meta.url.includes('$bunfs')

const DECLARATION = `// Сгенерировано MaBase - не править: файл перезаписывается при запуске.
// Типы API для редактора. Лежит в папке данных, редактор подхватывает сам.

declare module 'mabase' {
  /** Тот же zod, что внутри сервера: схемы проверяются им же. */
  export const z: typeof import('./types/zod/index.js').z
  export type ZodType = import('./types/zod/index.js').ZodType

  export type Doc = { _id: string; _createdAt: number; _updatedAt: number; [field: string]: any }
  export type Query = Record<string, unknown>
  export type Update = {
    $set?: Record<string, unknown>
    $unset?: Record<string, unknown>
    $inc?: Record<string, number>
    $push?: Record<string, unknown>
    $pull?: Record<string, unknown>
  }
  export type FindOptions = { sort?: Record<string, 1 | -1>; limit?: number; fields?: string[]; expand?: string[] }
  export type User = { readonly id: string; readonly roles?: readonly string[] }
  export type Origin = 'api' | 'action' | 'hook' | 'system' | 'seed'

  export interface CollectionApi<T extends Doc = Doc> {
    find(filter?: Query, opts?: FindOptions): Promise<T[]>
    findOne(filter?: Query, opts?: Omit<FindOptions, 'limit'>): Promise<T | null>
    count(filter?: Query): Promise<number>
    insert(doc: Record<string, unknown>): Promise<T>
    insertMany(docs: Array<Record<string, unknown>>): Promise<T[]>
    update(id: string, update: Update): Promise<T>
    upsert(filter: Query, doc: Record<string, unknown>): Promise<T>
    remove(id: string): Promise<void>
    removeMany(filter: Query): Promise<number>
    explain(filter?: Query, opts?: FindOptions): Promise<{ plan: string; scanned: number; ms: number }>
  }
  /** Коллекции по имени: db.rooms.find(...). Типы документов - свои через generic. */
  export type Db = Record<string, CollectionApi>

  export type Fields = {
    readonly?: string[]
    immutable?: string[]
    private?: string[]
    hidden?: string[]
  }
  export type FileField = { maxBytes?: number; accept?: string[]; many?: boolean }
  export type Relation = { to: string; many?: boolean; onDelete?: 'restrict' | 'cascade' | 'unset' | 'pull' }
  export type FilterRule = false | ((user: User | null, ctx: { db: Db }) => Query | boolean | Promise<Query | boolean>)
  export type CheckRule<C = any> = false | ((user: User | null, ctx: C & { db: Db }) => boolean | Promise<boolean>)
  export type Rules = {
    list?: FilterRule
    view?: FilterRule
    create?: CheckRule<{ doc: Record<string, unknown> }>
    update?: CheckRule<{ before: Doc; after: Doc }>
    delete?: CheckRule<{ before: Doc }>
    dependsOn?: string[]
  }
  export type HookCtx = {
    db: Db
    user: User | null
    origin: Origin
    depth: number
    signal: AbortSignal
  }
  export type Hooks = {
    beforeCreate?: (ctx: HookCtx & { doc: Doc }) => unknown
    beforeUpdate?: (ctx: HookCtx & { prev: Doc; next: Doc }) => unknown
    beforeDelete?: (ctx: HookCtx & { prev: Doc }) => unknown
    afterCreate?: (ctx: Omit<HookCtx, 'signal' | 'depth'> & { doc: Doc }) => unknown
    afterUpdate?: (ctx: Omit<HookCtx, 'signal' | 'depth'> & { prev: Doc; doc: Doc }) => unknown
    afterDelete?: (ctx: Omit<HookCtx, 'signal' | 'depth'> & { prev: Doc }) => unknown
  }

  type CollectionDefNoSchema = { [key: string]: unknown }
  export type CollectionDefinition<S extends ZodType | undefined = ZodType | undefined, N extends string = string> = CollectionDefNoSchema & {
    name: N
    schema?: S
  }

  export function defineCollection<N extends string, S extends ZodType | undefined = undefined>(
    name: N,
    def?: {
      schema?: S
      indexes?: string[]
      owner?: string
      fields?: Fields
      rules?: Rules
      hooks?: Hooks
      relations?: Record<string, Relation>
      files?: Record<string, FileField>
    },
  ): CollectionDefinition<S, N>

  export type ActionCtx<I = any> = {
    input: I
    user: User | null
    db: Db
    emit: (event: string, data: unknown, opts?: { after?: number | string; key?: string }) => void
    signal: AbortSignal
  }
  export type InputOf<S> = S extends ZodType ? import('./types/zod/index.js').output<S> : undefined
  export type ActionDef<I = unknown, N extends string = string, S extends ZodType = ZodType> = {
    name: N
    input?: S
    public?: boolean
    handler: (ctx: any) => unknown
  }
  export function defineAction<N extends string, S extends ZodType | undefined = undefined>(
    name: N,
    def: { input?: S; public?: boolean; handler: (ctx: ActionCtx<InputOf<S>>) => unknown | Promise<unknown> },
  ): ActionDef<InputOf<S>, N, S extends ZodType ? S : ZodType>

  export type MailMessage = { to: string; subject: string; text: string; html?: string }
  export const mail: { send(msg: MailMessage): Promise<void> }

  export interface AuthApi {
    upsertUser(input: { email?: string; phone?: string; password?: string; [field: string]: unknown }): Promise<Doc>
    setPassword(userId: string, password: string): Promise<void>
    revokeSessions(userId: string): Promise<number>
  }
  export type SeedCtx = { db: Db; auth: AuthApi }
  export type SeedDefinition = { seed: (ctx: SeedCtx) => unknown | Promise<unknown> }
  export function defineSeed(seed: (ctx: SeedCtx) => unknown | Promise<unknown>): SeedDefinition

  export type Domain = { enabled?: boolean }
  export type EventHandler = (ctx: {
    event: string
    data: any
    tx: number
    db: Db
    signal: AbortSignal
    task?: { id: string; attempt: number; runAt: number }
  }) => unknown
  /** События записей и свои: <коллекция>.created | updated | deleted, emit('order.paid') */
  export function on(event: string, fn: EventHandler): void

  export type AppConfig<
    C extends readonly CollectionDefinition<any, any>[] = CollectionDefinition<any, any>[],
    A extends readonly ActionDef<any, any, any>[] = ActionDef<any, any, any>[],
  > = {
    collections?: C
    actions?: A
    auth?: Record<string, unknown>
    mail?: Record<string, unknown>
    http?: Record<string, unknown>
    limits?: Record<string, number>
    db?: Record<string, number>
    realtime?: boolean
    events?: Record<string, Record<string, unknown>>
    scheduler?: Record<string, unknown>
    admin?: Record<string, unknown>
  }
  export function defineConfig<C extends readonly CollectionDefinition<any, any>[], A extends readonly ActionDef<any, any, any>[]>(
    cfg: AppConfig<C, A>,
  ): AppConfig<C, A>

  export type ActionErrorCode =
    | 'bad_request'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'invalid_credentials'
    | 'too_many_requests'
    | 'too_large'
    | 'unavailable'
  export class ActionError extends Error {
    constructor(code: ActionErrorCode, message: string, details?: unknown)
    readonly code: ActionErrorCode
    readonly details?: unknown
  }

  export type ClientLimits = { defaultLimit: number; maxLimit: number; maxScanned: number; maxRegexLength: number }
}

// ---------- клиент для браузера ----------
// Типы SDK. В браузере он подключается с сервера:
//   import { createClient } from '/api/client.js'
// а типы берутся отсюда: createClient<typeof config> выводит коллекции и
// действия из zod-схем конфига. Если нужен один импорт - добавьте в проект
// файл client.d.ts:
//   declare module '/api/client.js' { export * from 'mabase/client' }

declare module 'mabase/client' {
  export type Doc = { _id: string; _createdAt: number; _updatedAt: number; [field: string]: any }
  export type Query = Record<string, unknown>
  export type Update = {
    $set?: Record<string, unknown>
    $unset?: Record<string, unknown>
    $inc?: Record<string, number>
    $push?: Record<string, unknown>
    $pull?: Record<string, unknown>
  }
  export type FindOptions = { sort?: Record<string, 1 | -1>; limit?: number; fields?: string[]; expand?: string[] }
  export type User = { id: string; email?: string; roles?: string[]; [field: string]: unknown }

  type ZodLike = import('./types/zod/index.js').ZodType
  type SchemaOf<D> = D extends { schema?: infer S } ? (S extends ZodLike ? S : never) : never
  export type DocOf<D> = [SchemaOf<D>] extends [never] ? Doc : { _id: string; _createdAt: number; _updatedAt: number } & import('./types/zod/index.js').output<SchemaOf<D>>
  export type InsertOf<D> = [SchemaOf<D>] extends [never]
    ? Record<string, unknown>
    : Omit<import('./types/zod/index.js').output<SchemaOf<D>>, '_id' | '_createdAt' | '_updatedAt'> & { _id?: string }
  export type CollectionsOf<C extends readonly { name: string }[]> = {
    [D in C[number] as D['name']]: CollectionClient<DocOf<D>, InsertOf<D>>
  }
  type ActionInputOf<D> = D extends { input?: infer S } ? (S extends ZodLike ? import('./types/zod/index.js').input<S> : undefined) : undefined
  export type ActionMap<A extends readonly { name: string }[]> = { [D in A[number] as D['name']]: ActionInputOf<D> }

  export interface CollectionClient<T = Doc, I = Record<string, unknown>> {
    find(filter?: Query, opts?: FindOptions): Promise<T[]>
    findOne(filter?: Query, opts?: FindOptions): Promise<T | null>
    count(filter?: Query): Promise<number>
    get(id: string, opts?: { fields?: string[]; expand?: string[] }): Promise<T>
    insert(doc: I & { _id?: string }, opts?: { files?: Record<string, File | File[]> }): Promise<T>
    update(id: string, update: Update, opts?: { files?: Record<string, File | File[]> }): Promise<T>
    remove(id: string): Promise<void>
  }
  export interface Live<T = Doc> {
    items: T[]
    loaded: boolean
    subscribe(fn: (items: T[]) => void): () => void
    on(event: 'change' | 'reset' | 'revoked' | 'error', fn: (arg: any) => void): () => void
    loadMore(n: number): Promise<number>
    close(): void
  }
  export type ActionErrorCode = 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid_credentials' | 'too_many_requests' | 'too_large' | 'unavailable'
  export class MabaseError extends Error {
    constructor(code: string, message: string, status?: number, details?: unknown)
    readonly code: string
    readonly status: number
    readonly details?: unknown
  }
  export type ClientOptions = {
    storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
    sessionStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
    fetch?: typeof fetch
    WebSocket?: unknown
    authphoneUrl?: string
    refreshBeforeMs?: number
    reconnectMs?: { min: number; max: number }
    pingMs?: number
  }
  export interface MabaseClient {
    readonly url: string
    readonly c: Record<string, CollectionClient>
    readonly auth: {
      user: User | null
      session: { user: User; accessToken: string; refreshToken: string; accessExpiresAt: number } | null
      register(input: { email?: string; phone?: string; password?: string; data?: Record<string, unknown> }): Promise<User>
      login(input: { email?: string; phone?: string; password?: string; code?: string }): Promise<User>
      logout(): Promise<void>
      restore(): Promise<User | null>
      onChange(fn: (user: User | null) => void): () => void
      setPassword(oldPassword: string, newPassword: string): Promise<void>
    }
    action<R = any>(name: string, input?: unknown): Promise<R>
    live<T = Doc>(collection: string, filter?: Query, opts?: FindOptions): Live<T>
    emit(event: string, data: unknown): void
    on(event: string, fn: (arg: any) => void): () => void
    fileUrl(id: string): string
    request<R = any>(method: string, path: string, body?: unknown): Promise<R>
    close(): void
  }
  export type TypedClient<
    Config extends { collections?: readonly { name: string }[]; actions?: readonly { name: string }[] },
  > = Omit<MabaseClient, 'c' | 'action'> & {
    c: CollectionsOf<NonNullable<Config['collections']>>
    action<N extends keyof ActionMap<NonNullable<Config['actions']>> & string>(
      name: N,
      ...args: ActionMap<NonNullable<Config['actions']>>[N] extends undefined
        ? [input?: undefined]
        : [input: ActionMap<NonNullable<Config['actions']>>[N]]
    ): Promise<any>
  }

  export function createClient(url: string, opts?: ClientOptions): MabaseClient
  export function createClient<Config extends { collections?: readonly { name: string }[]; actions?: readonly { name: string }[] }>(
    url: string,
    opts?: ClientOptions,
  ): TypedClient<Config>
}
`

async function zodTypes(): Promise<Record<string, string>> {
  if (compiled) return (await import('./generated/zod-types')).default
  return readZodTypes(new URL('../node_modules/zod', import.meta.url).pathname)
}

// Из исходников: берём .d.ts прямо из node_modules/zod (пути сохраняются,
// потому что импорты внутри zod относительные).
function readZodTypes(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const next = rel ? `${rel}/${name}` : name
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs, next)
      else if (name.endsWith('.d.ts')) out[next] = readFileSync(abs, 'utf8')
    }
  }
  walk(root, '')
  return out
}

export async function editorFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = { 'types.d.ts': DECLARATION }
  for (const [path, content] of Object.entries(await zodTypes())) files[`types/zod/${path}`] = content
  return files
}

// Записать в папку данных то, чего там нет или что изменилось. Возвращает
// число записанных файлов (0 - всё уже на месте).
export async function writeEditorTypes(dataDir: string): Promise<{ written: number; total: number }> {
  const files = await editorFiles()
  let written = 0
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dataDir, rel)
    if (existsSync(path)) {
      try {
        if (readFileSync(path, 'utf8') === content) continue
      } catch {}
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    written++
  }
  return { written, total: Object.keys(files).length }
}

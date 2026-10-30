// Модуль 'mabase' - то, что импортируют mabase.config.ts, mb_hooks/*.ts и
// seed.ts. В бинарнике он виртуальный (Bun.plugin), без node_modules.
import { z } from 'zod'
import type { AccessDef } from './access'
import { defineAction, type ActionDef } from './actions'
import type { Auth, AuthOptions } from './auth'
import type { CollectionApi, CollectionDef, DbOptions } from './db'
import { ActionError } from './errors'
import type { HttpOptions } from './http'
import type { MailMessage, Mailer, MailOptions } from './mail'
import type { ClientLimits } from './access'
import type { Handler } from './bus'
import type { EventConfig } from './realtime'

export { z, ActionError, defineAction }
export type { ActionDef, MailMessage }

// Коллекции внутри правила, хука, действия, сида: db.rooms.find(...).
export type Db = Record<string, CollectionApi>

export type CollectionDefinition = CollectionDef & AccessDef & { name: string }

export function defineCollection(name: string, def: CollectionDef & AccessDef = {}): CollectionDefinition {
  if (typeof name !== 'string' || !/^_?[A-Za-z][\w-]*$/.test(name)) throw new TypeError(`defineCollection: недопустимое имя "${name}"`)
  return { ...def, name }
}

export type AppConfig = {
  collections?: CollectionDefinition[] // users - расширение встроенной
  actions?: ActionDef[]
  auth?: Omit<AuthOptions, 'secret' | 'users' | 'mail' | 'fetch' | 'now'>
  mail?: MailOptions
  http?: Omit<HttpOptions, 'access' | 'auth' | 'actions' | 'adminToken' | 'onError'>
  limits?: Partial<ClientLimits>
  db?: Pick<DbOptions, 'txTimeoutMs' | 'compactMinBytes' | 'bigTxOps' | 'maxDepth'>
  realtime?: boolean // WebSocket /api/realtime
  events?: Record<string, EventConfig> // что уходит в сокет (design.md §12)
}

const CONFIG_KEYS = new Set(['collections', 'actions', 'auth', 'mail', 'http', 'limits', 'db', 'realtime', 'events'])

export function defineConfig(cfg: AppConfig): AppConfig {
  for (const k of Object.keys(cfg)) if (!CONFIG_KEYS.has(k)) throw new TypeError(`defineConfig: неизвестный раздел "${k}"`)
  const names = new Set<string>()
  for (const c of cfg.collections ?? []) {
    if (!c || typeof c.name !== 'string') throw new TypeError('defineConfig: collections - результаты defineCollection')
    if (names.has(c.name)) throw new TypeError(`defineConfig: коллекция ${c.name} объявлена дважды`)
    names.add(c.name)
  }
  return cfg
}

export type SeedCtx = { db: Db; auth: Auth }
export type SeedDefinition = { seed: (ctx: SeedCtx) => Promise<void> | void }

export function defineSeed(seed: SeedDefinition['seed']): SeedDefinition {
  return { seed }
}

// ---------- обработчики событий из mb_hooks ----------
// После коммита, вне транзакции: события из emit() и '<коллекция>.created |
// updated | deleted' с { doc, prev }. Отложенные (emit с after) - шаг 10.

export type EventHandler = Handler
const handlers = new Map<string, EventHandler[]>()

export function on(event: string, fn: EventHandler): void {
  if (typeof event !== 'string' || !event || typeof fn !== 'function') throw new TypeError('on(событие, обработчик)')
  handlers.set(event, [...(handlers.get(event) ?? []), fn])
}

export function eventHandlers(): ReadonlyMap<string, readonly EventHandler[]> {
  return handlers
}

// ---------- почта для хуков и действий ----------
// import { mail } from 'mabase'; await mail.send({ to, subject, text })

let currentMailer: Mailer | null = null

export const mail = {
  send(msg: MailMessage): Promise<void> {
    if (!currentMailer) return Promise.reject(new Error('mail.send: сервер ещё не запущен'))
    return currentMailer.send(msg)
  },
}

export function bindMailer(m: Mailer | null): void {
  currentMailer = m
}

// Сбросить состояние модуля (тесты, повторная загрузка конфига).
export function resetApi(): void {
  handlers.clear()
  currentMailer = null
}

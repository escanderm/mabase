// Модуль 'mabase' - то, что импортируют mabase.config.ts, mb_hooks/*.ts и
// seed.ts. В бинарнике он виртуальный (Bun.plugin), без node_modules.
import { z } from 'zod'
import type { AccessDef } from './access'
import { defineAction, type ActionDef } from './actions'
import { checkCron } from './cron'
import type { Auth, AuthOptions } from './auth'
import type { CollectionApi, CollectionDef, DbOptions } from './db'
import { ActionError } from './errors'
import type { HttpOptions } from './http'
import type { MailMessage, Mailer, MailOptions } from './mail'
import type { ClientLimits } from './access'
import type { Handler } from './bus'
import type { EventConfig } from './realtime'
import type { SchedulerOptions } from './scheduler'
import type { SuperuserOptions } from './superusers'

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
  http?: Omit<HttpOptions, 'access' | 'auth' | 'actions' | 'adminToken' | 'adminApi' | 'superusers' | 'onError'>
  limits?: Partial<ClientLimits>
  db?: Pick<DbOptions, 'txTimeoutMs' | 'compactMinBytes' | 'bigTxOps' | 'maxDepth'>
  realtime?: boolean // WebSocket /api/realtime
  events?: Record<string, EventConfig> // что уходит в сокет (design.md §12)
  scheduler?: Omit<SchedulerOptions, 'onError' | 'tail'> // отложенные события: попытки, паузы
  admin?: { enabled?: boolean; superusers?: Omit<SuperuserOptions, 'now'> } // админка /_/
}

const CONFIG_KEYS = new Set(['collections', 'actions', 'auth', 'mail', 'http', 'limits', 'db', 'realtime', 'events', 'scheduler', 'admin'])

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
// updated | deleted' с { doc, prev }. Отложенные (emit с after) - когда придёт
// время, с task: { attempt, runAt }; минимум один раз - обработчик идемпотентный.

export type EventHandler = Handler
const handlers = new Map<string, EventHandler[]>()

export function on(event: string, fn: EventHandler): void {
  if (typeof event !== 'string' || !event || typeof fn !== 'function') throw new TypeError('on(событие, обработчик)')
  handlers.set(event, [...(handlers.get(event) ?? []), fn])
}

export function eventHandlers(): ReadonlyMap<string, readonly EventHandler[]> {
  return handlers
}

// ---------- периодические задачи (design.md §13) ----------
export type ScheduleDef = { event: string; cron: string; data?: unknown }
const schedules: ScheduleDef[] = []

// schedule('digest.daily', '0 9 * * *', { to: 'team' }) в mabase.config.ts или
// mb_hooks/*.ts: сервер поставит задачу в _scheduled и будет повторять её по
// cron (локальное время сервера). Обработчик - обычный on('digest.daily').
export function schedule(event: string, cron: string, data?: unknown): void {
  if (typeof event !== 'string' || !event) throw new TypeError('schedule(событие, cron, данные)')
  if (typeof cron !== 'string') throw new TypeError(`schedule(${event}): cron - строка, например '0 9 * * *'`)
  checkCron(cron)
  if (schedules.some((s) => s.event === event)) throw new TypeError(`schedule: ${event} уже запланировано`)
  schedules.push({ event, cron, ...(data !== undefined && { data }) })
}

export function scheduledTasks(): readonly ScheduleDef[] {
  return schedules
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
// Снимок и восстановление реестров - для перезагрузки хуков: если новый файл
// не загрузился, работают прежние обработчики (design.md §5).
export type HooksSnapshot = { handlers: Map<string, EventHandler[]>; schedules: ScheduleDef[] }

/** @internal */ export function snapshotHooks(): HooksSnapshot {
  return { handlers: new Map([...handlers].map(([k, v]) => [k, [...v]])), schedules: schedules.map((s) => ({ ...s })) }
}

/** @internal */ export function restoreHooks(s: HooksSnapshot): void {
  handlers.clear()
  for (const [k, v] of s.handlers) handlers.set(k, v)
  schedules.length = 0
  schedules.push(...s.schedules)
}

/** @internal */ export function resetHooks(): void {
  handlers.clear()
  schedules.length = 0
}

export function resetApi(): void {
  resetHooks()
  currentMailer = null
}

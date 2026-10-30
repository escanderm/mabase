// Действия (design.md §10): явная операция бизнес-логики, одна транзакция.
// Слой над ядром: ядро про действия не знает.
import type { z } from 'zod'
import type { CollectionApi, Db, TxApi, User } from './db'
import { ActionError, type ActionErrorCode } from './errors'
import { assertJson } from './query'

export type { User } from './db'

export type ActionCtx<I, U> = {
  input: I
  user: U
  db: Record<string, CollectionApi> // коллекции внутри транзакции действия
  emit: TxApi['emit']
  signal: AbortSignal // отменится по таймауту транзакции - передайте в fetch
}

type Input<S> = S extends z.ZodType ? z.output<S> : undefined

export type ActionDef = {
  name: string
  input?: z.ZodType
  public: boolean
  handler: (ctx: ActionCtx<any, any>) => unknown
}

// По умолчанию нужен вход: user не null. public: true - без входа.
export function defineAction<S extends z.ZodType | undefined = undefined, R = unknown>(
  name: string,
  def: { input?: S; public?: false; handler: (ctx: ActionCtx<Input<S>, User>) => R | Promise<R> },
): ActionDef
export function defineAction<S extends z.ZodType | undefined = undefined, R = unknown>(
  name: string,
  def: { input?: S; public: true; handler: (ctx: ActionCtx<Input<S>, User | null>) => R | Promise<R> },
): ActionDef
export function defineAction(
  name: string,
  def: { input?: z.ZodType; public?: boolean; handler: (ctx: ActionCtx<any, any>) => unknown },
): ActionDef {
  if (!/^[A-Za-z][\w.-]*$/.test(name)) throw new TypeError(`defineAction: недопустимое имя "${name}"`)
  return { name, input: def.input, public: def.public === true, handler: def.handler }
}

// Ответ клиенту. Наружу уходят только ActionError и ошибки input;
// всё остальное - 500 без подробностей, подробности - в onError и tail.
export type ClientError = { status: number; code: ActionErrorCode | 'internal'; message: string; details?: unknown }

export function toClientError(err: unknown): ClientError {
  if (err instanceof ActionError) {
    return { status: err.status, code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) }
  }
  return { status: 500, code: 'internal', message: 'Внутренняя ошибка сервера' }
}

export type ActionRunInfo = {
  name: string
  userId: string | null
  ms: number // всё время действия, включая ожидание очереди
  ok: boolean
  code?: ClientError['code']
  error?: unknown // исходная ошибка - только для логов и tail
}

export type ActionsOptions = {
  onError?: (err: unknown, info: ActionRunInfo) => void
}

export class Actions {
  private defs = new Map<string, ActionDef>()
  private listeners: Array<(info: ActionRunInfo) => void> = []
  private onError: NonNullable<ActionsOptions['onError']>

  constructor(
    private db: Db,
    defs: ActionDef[],
    opts: ActionsOptions = {},
  ) {
    for (const d of defs) {
      if (this.defs.has(d.name)) throw new TypeError(`Действие ${d.name} объявлено дважды`)
      this.defs.set(d.name, d)
    }
    this.onError = opts.onError ?? ((err, info) => console.error(`[mabase] действие ${info.name} упало`, err))
  }

  onRun(fn: (info: ActionRunInfo) => void): void {
    this.listeners.push(fn)
  }

  // Бросает ActionError (ожидаемые) или исходную ошибку (внутренние).
  // Что отдать клиенту - toClientError.
  async run(name: string, rawInput: unknown, user: User | null): Promise<unknown> {
    const t0 = performance.now()
    const userId = user?.id ?? null
    try {
      const result = await this.execute(name, rawInput, user)
      this.report({ name, userId, ms: performance.now() - t0, ok: true })
      return result
    } catch (err) {
      const info: ActionRunInfo = { name, userId, ms: performance.now() - t0, ok: false, code: toClientError(err).code, error: err }
      if (info.code === 'internal') this.onError(err, info)
      this.report(info)
      throw err
    }
  }

  private async execute(name: string, rawInput: unknown, user: User | null): Promise<unknown> {
    const def = this.defs.get(name)
    if (!def) throw new ActionError('not_found', `Действие ${name} не найдено`)
    if (!def.public && !user) throw new ActionError('unauthorized', 'Нужен вход')

    // Вход проверяется до транзакции: неверный запрос очередь не занимает.
    let input: unknown
    if (def.input) {
      const r = def.input.safeParse(rawInput)
      if (!r.success) {
        throw new ActionError(
          'bad_request',
          'Неверные входные данные',
          r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
        )
      }
      input = r.data
    } else if (rawInput !== undefined && rawInput !== null && !(isEmptyObject(rawInput))) {
      throw new ActionError('bad_request', `У действия ${name} нет входных данных`)
    }

    return this.db.transaction(
      async (tx) => {
        const result = await def.handler({ input, user: tx.user, db: tx.c, emit: tx.emit, signal: tx.signal })
        // ответ уйдёт по HTTP или сокету: проверяем здесь, пока транзакцию можно отменить
        assertJson(result)
        return result === undefined ? null : JSON.parse(JSON.stringify(result))
      },
      { user },
    )
  }

  private report(info: ActionRunInfo): void {
    for (const l of this.listeners) {
      try {
        l(info)
      } catch (err) {
        console.error('[mabase] ошибка в onRun', err)
      }
    }
  }
}

const isEmptyObject = (v: unknown) =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0

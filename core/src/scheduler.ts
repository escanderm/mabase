// Отложенные события (design.md §13): emit('x', data, { after: '5s', key })
// кладёт задачу в _scheduled в той же транзакции; здесь она выполняется.
//
// - Доставка - минимум один раз: задача удаляется только после успешного
//   обработчика. Упал процесс посреди обработчика - после старта задача
//   выполнится снова. Обработчик должен быть идемпотентным.
// - Ошибка - повтор с паузой (5 с, 10 с, 20 с ... до часа). После
//   maxAttempts попыток задача остаётся в _scheduled с failed: true и видна в
//   tail; её key освобождается (переезжает в failedKey), иначе новые задачи с
//   тем же ключом не ставились бы никогда.
// - Пропущенные за время простоя - выполняются при старте. Обработчик видит
//   task.runAt и сам решает, не устарело ли.
// - Нет обработчика - тоже ошибка: опечатка в имени события будет видна.
import type { Handler, TaskInfo } from './bus'
import { nextCronRun } from './cron'
import { SCHEDULED, type Db, type Doc } from './db'
import { NotFoundError } from './errors'
import type { Tail } from './tail'

// Периодические задачи (schedule в конфиге или хуках): одна задача на событие,
// key = cron:<событие>. Просроченная - выполнится при старте; после успеха
// получает следующее время, а не удаляется.
export async function ensureSchedules(db: Db, list: readonly { event: string; cron: string; data?: unknown }[]): Promise<void> {
  for (const s of list) {
    const key = `cron:${s.event}`
    await db.transaction(async (tx) => {
      const data = s.data === undefined ? null : s.data
      const runAt = nextCronRun(s.cron, Date.now())
      let existing = await tx.c[SCHEDULED]!.findOne({ key })
      if (existing?.failed) {
        // Проваленная задача cron не останавливает: начинаем заново.
        await tx.c[SCHEDULED]!.remove(existing._id)
        existing = null
      }
      if (!existing) {
        await tx.c[SCHEDULED]!.insert({ event: s.event, data, runAt, key, cron: s.cron, attempts: 0 })
        return
      }
      const set: Record<string, unknown> = { event: s.event, cron: s.cron, data }
      if (!(Number(existing.runAt) > Date.now())) set.runAt = runAt
      await tx.c[SCHEDULED]!.update(existing._id, { $set: set })
    }, { origin: 'system' })
  }
}

export type SchedulerOptions = {
  maxAttempts?: number // 5
  retryBaseMs?: number // пауза после первой ошибки, дальше вдвое больше; 5 с
  retryMaxMs?: number // 1 час
  concurrency?: number // задач одновременно; 4
  timeoutMs?: number // на обработчик; 30 с
  onError?: (err: unknown, where: string) => void
  tail?: Tail
}

const PENDING = { failed: { $exists: false } }

export class Scheduler {
  private o: Required<Omit<SchedulerOptions, 'tail'>> & { tail?: Tail }
  private running = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextAt = Infinity
  private ticking: Promise<void> | null = null
  private again = false
  private stopped = true

  constructor(
    private db: Db,
    private handlers: () => ReadonlyMap<string, readonly Handler[]>,
    opts: SchedulerOptions = {},
  ) {
    this.o = {
      maxAttempts: opts.maxAttempts ?? 5,
      retryBaseMs: opts.retryBaseMs ?? 5_000,
      retryMaxMs: opts.retryMaxMs ?? 3_600_000,
      concurrency: opts.concurrency ?? 4,
      timeoutMs: opts.timeoutMs ?? 30_000,
      onError: opts.onError ?? ((err, where) => console.error(`[mabase] ошибка в ${where}`, err)),
      tail: opts.tail,
    }
    // Новая задача в транзакции - проснуться к её времени.
    db.onCommit((info) => {
      if (this.stopped) return
      for (const ch of info.changes) if (ch.c === SCHEDULED && ch.doc && !ch.doc.failed) this.wake(ch.doc.runAt)
    })
  }

  // Сколько задач просрочено к старту (пропущены за время простоя).
  async start(): Promise<number> {
    this.stopped = false
    const overdue = await this.db.c[SCHEDULED]!.count({ ...PENDING, runAt: { $lte: Date.now() } })
    this.wake(0)
    return overdue
  }

  // Остановка: новые не берём, начатые ждём не дольше timeoutMs.
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const all = Promise.allSettled([...this.running.values()])
    await Promise.race([all, new Promise((r) => setTimeout(r, this.o.timeoutMs))])
  }

  // Ничего не выполняется и ничего не просрочено. Для тестов.
  async idle(): Promise<void> {
    while (true) {
      if (this.ticking) await this.ticking
      if (this.running.size) {
        await Promise.allSettled([...this.running.values()])
        continue
      }
      const due = await this.db.c[SCHEDULED]!.count({ ...PENDING, runAt: { $lte: Date.now() } })
      if (!due || this.stopped) return
      await this.tick()
    }
  }

  private wake(at: number): void {
    if (this.stopped || at >= this.nextAt) return
    if (this.timer) clearTimeout(this.timer)
    this.nextAt = at
    // setTimeout держит не больше ~24.8 суток; дальние задачи - перепроверим
    this.timer = setTimeout(() => void this.tick(), Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1))
  }

  private tick(): Promise<void> {
    if (this.ticking) {
      this.again = true
      return this.ticking
    }
    this.ticking = (async () => {
      try {
        do {
          this.again = false
          this.nextAt = Infinity
          if (this.timer) clearTimeout(this.timer)
          this.timer = null
          if (this.stopped) return
          const free = this.o.concurrency - this.running.size
          if (free > 0) {
            const due = await this.db.c[SCHEDULED]!.find({ ...PENDING, runAt: { $lte: Date.now() } }, { sort: { runAt: 1 }, limit: free + this.running.size })
            for (const t of due) if (!this.running.has(t._id) && this.running.size < this.o.concurrency) this.run(t)
          }
          // следующая по времени, которая ещё не выполняется
          const next = await this.db.c[SCHEDULED]!.find(PENDING, { sort: { runAt: 1 }, limit: this.running.size + 1 })
          const t = next.find((d) => !this.running.has(d._id))
          if (t && this.running.size < this.o.concurrency) this.wake(t.runAt)
        } while (this.again)
      } catch (err) {
        this.o.onError(err, 'отложенные события')
        this.wake(Date.now() + 1000)
      } finally {
        this.ticking = null
      }
    })()
    return this.ticking
  }

  private run(t: Doc): void {
    const attempt = (t.attempts ?? 0) + 1
    const t0 = performance.now()
    let handler: Promise<void> | null = null
    const p = (async () => {
      try {
        const hs = this.handlers().get(t.event) ?? []
        if (!hs.length) throw new Error(`нет обработчика on('${t.event}')`)
        const signal = AbortSignal.timeout(this.o.timeoutMs)
        const task: TaskInfo = { id: t._id, attempt, runAt: t.runAt }
        // Таймаут только сигналит обработчику: Promise.race перестаёт ждать, а
        // сам обработчик продолжает работать. Поэтому результат попытки пишем
        // после фактического завершения - иначе повтор через retryBaseMs
        // запустил бы вторую копию параллельно с первой.
        handler = (async () => {
          for (const h of hs) await h({ event: t.event, data: t.data, tx: this.db.lastTx, db: this.db.c, signal, task })
        })()
        await Promise.race([
          handler,
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error(`таймаут ${this.o.timeoutMs} мс`)), { once: true })),
        ])
        // Периодическая задача после успеха получает следующее время, обычная -
        // удаляется (key освобождается).
        const next = typeof t.cron === 'string' ? nextCronRun(t.cron, Date.now()) : null
        if (next) {
          await this.db.c[SCHEDULED]!.update(t._id, { $set: { runAt: next, attempts: 0 }, $unset: { lastError: '' } }).catch((err) => {
            if (!(err instanceof NotFoundError)) throw err
          })
        } else {
          await this.db.c[SCHEDULED]!.remove(t._id).catch((err) => {
            if (!(err instanceof NotFoundError)) throw err
          })
        }
        this.o.tail?.publish('task', { event: t.event, id: t._id, attempt, ms: Math.round(performance.now() - t0), ok: true, ...(next ? { next } : {}) })
      } catch (err) {
        if (handler) await handler.catch(() => {}) // дождаться брошенного обработчика
        await this.failed(t, attempt, err, performance.now() - t0)
      }
    })().finally(() => {
      this.running.delete(t._id)
      void this.tick()
    })
    this.running.set(t._id, p)
  }

  private async failed(t: Doc, attempt: number, err: unknown, ms: number): Promise<void> {
    const error = err instanceof Error ? err.message : String(err)
    const last = attempt >= this.o.maxAttempts
    const retryAt = Date.now() + Math.min(this.o.retryMaxMs, this.o.retryBaseMs * 2 ** (attempt - 1))
    this.o.tail?.publish('task', { event: t.event, id: t._id, attempt, ms: Math.round(ms), ok: false, error, ...(last ? { failed: true } : { retryAt }) })
    try {
      if (last) {
        this.o.onError(err, `отложенное событие ${t.event}: провалено после ${attempt} попыток, задача ${t._id} оставлена в _scheduled`)
        await this.db.c[SCHEDULED]!.update(t._id, {
          $set: { attempts: attempt, failed: true, failedAt: Date.now(), lastError: error, ...(t.key !== undefined && { failedKey: t.key }) },
          $unset: { key: '' },
        })
      } else {
        this.o.onError(err, `отложенное событие ${t.event}, попытка ${attempt}`)
        await this.db.c[SCHEDULED]!.update(t._id, { $set: { attempts: attempt, runAt: retryAt, lastError: error } })
      }
    } catch (e) {
      if (!(e instanceof NotFoundError)) this.o.onError(e, 'отложенные события: запись результата')
    }
  }
}

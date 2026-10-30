// Доставка событий обработчикам on() из mb_hooks (design.md §9, §12):
// после коммита, вне очереди записи и вне транзакции.
//   - события из emit() в транзакции - по имени;
//   - события записей - '<коллекция>.created | updated | deleted' с { doc, prev }.
// Ошибка обработчика не отменяет сохранённое: она идёт в onError и tail.
// Отложенные события (emit с after) - шаг 10.
import type { Change, CommitInfo, Db } from './db'
import type { Tail } from './tail'

export type HandlerCtx = { event: string; data: any; tx: number; db: Db['c']; signal: AbortSignal }
export type Handler = (ctx: HandlerCtx) => unknown

export function recordEvent(ch: Change): { event: string; data: unknown } {
  const op = !ch.prev ? 'created' : !ch.doc ? 'deleted' : 'updated'
  return { event: `${ch.c}.${op}`, data: { doc: ch.doc, prev: ch.prev } }
}

export class Bus {
  private pending = new Set<Promise<void>>()

  constructor(
    private db: Db,
    private handlers: () => ReadonlyMap<string, readonly Handler[]>,
    private opts: { onError: (err: unknown, where: string) => void; tail?: Tail; timeoutMs?: number },
  ) {
    db.onCommit((info) => this.dispatch(info))
  }

  private dispatch(info: CommitInfo): void {
    const map = this.handlers()
    if (!map.size) return
    const events = [...info.events, ...info.changes.filter((ch) => !ch.c.startsWith('_') || ch.c === '_presence').map(recordEvent)]
    for (const e of events) {
      for (const h of map.get(e.event) ?? []) this.run(h, e.event, e.data, info.tx)
    }
  }

  // Своя очередь у каждого вызова: медленный обработчик не держит остальных.
  run(h: Handler, event: string, data: unknown, tx: number): void {
    const t0 = performance.now()
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000)
    const p = (async () => {
      try {
        await h({ event, data, tx, db: this.db.c, signal })
        this.opts.tail?.publish('handler', { event, tx, ms: Math.round(performance.now() - t0), ok: true })
      } catch (err) {
        this.opts.tail?.publish('handler', { event, tx, ms: Math.round(performance.now() - t0), ok: false, error: String(err) })
        this.opts.onError(err, `on(${event})`)
      }
    })().finally(() => this.pending.delete(p))
    this.pending.add(p)
  }

  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}

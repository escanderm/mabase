// Журнал для mabase tail (design.md §14): коммиты со временем удержания
// очереди, действия, события, обработчики, сокеты, ошибки. Слушателей нет -
// записи никуда не идут и ничего не стоят.
export type TailEntry = { ts: number; kind: string; [field: string]: unknown }

export class Tail {
  private listeners = new Set<(e: TailEntry) => void>()

  publish(kind: string, fields: Record<string, unknown> = {}): void {
    if (!this.listeners.size) return
    const e = { ts: Date.now(), kind, ...fields }
    for (const l of this.listeners) {
      try {
        l(e)
      } catch {}
    }
  }

  get active(): boolean {
    return this.listeners.size > 0
  }

  listen(fn: (e: TailEntry) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

// Одна строка для консоли.
export function formatTail(e: TailEntry): string {
  const t = new Date(e.ts).toISOString().slice(11, 23)
  const { ts, kind, ...rest } = e
  const parts = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
  return `${t} ${kind.padEnd(8)} ${parts.join(' ')}`
}

// Поток NDJSON для mabase tail и админки: строка на запись, пока клиент не
// отключится. Пустая строка раз в 5 с: иначе Bun.serve рвёт молчащее
// соединение через 10 с (idleTimeout). Читатели пустые строки пропускают.
export function tailResponse(tail: Tail): Response {
  let off = () => {}
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (line: string) => {
        try {
          ctrl.enqueue(enc.encode(line + '\n'))
        } catch {
          off()
        }
      }
      send(JSON.stringify({ ts: Date.now(), kind: 'tail', status: 'подключено' }))
      const unlisten = tail.listen((e) => send(JSON.stringify(e)))
      const beat = setInterval(() => send(''), 5000)
      off = () => {
        clearInterval(beat)
        unlisten()
      }
    },
    cancel() {
      off()
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } })
}

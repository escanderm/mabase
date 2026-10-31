// Cron для периодических задач (design.md §13): 5 полей - минута (0-59),
// час (0-23), день месяца (1-31), месяц (1-12), день недели (0-7, 0 и 7 -
// воскресенье). Локальное время сервера - как у системного cron.
//
// Поддерживается: `*`, число, `a-b`, `*/n`, `a-b/n`, `a/n`, списки через
// запятую. Как в cron: если ограничены и день месяца, и день недели, задача
// срабатывает при совпадении любого из них.

export type CronFields = {
  minutes: Set<number>
  hours: Set<number>
  dom: Set<number>
  months: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

const LIMITS: Array<{ name: string; min: number; max: number }> = [
  { name: 'минута', min: 0, max: 59 },
  { name: 'час', min: 0, max: 23 },
  { name: 'день месяца', min: 1, max: 31 },
  { name: 'месяц', min: 1, max: 12 },
  { name: 'день недели', min: 0, max: 7 },
]

export function parseCron(expr: string): CronFields {
  if (typeof expr !== 'string' || !expr.trim()) throw new TypeError('cron: пустое выражение')
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new TypeError(`cron: нужно 5 полей (минута час день месяц день-недели), а в "${expr}" их ${parts.length}`)
  }
  const [minutes, hours, dom, months, dow] = parts.map((p, i) => parseField(p, LIMITS[i]!))
  if (dow!.has(7)) {
    dow!.add(0)
    dow!.delete(7)
  }
  return { minutes: minutes!, hours: hours!, dom: dom!, months: months!, dow: dow!, domRestricted: parts[2] !== '*', dowRestricted: parts[4] !== '*' }
}

function parseField(field: string, limit: { name: string; min: number; max: number }): Set<number> {
  const out = new Set<number>()
  const { name, min, max } = limit
  for (const part of field.split(',')) {
    const m = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new TypeError(`cron: ${name} - не понимаю "${part}": можно *, число, a-b, */n, a-b/n, a/n, списки через запятую`)
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (!Number.isInteger(step) || step <= 0) throw new TypeError(`cron: ${name} - шаг в "${part}" должен быть больше нуля`)
    let from = min
    let to = max
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-').map(Number)
      from = a!
      to = b ?? (m[2] !== undefined ? max : a!) // a/n - от a до конца диапазона
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
        throw new TypeError(`cron: ${name} - "${part}" вне ${min}..${max}`)
      }
    }
    for (let v = from; v <= to; v += step) out.add(v)
  }
  if (!out.size) throw new TypeError(`cron: ${name} - пусто в "${field}"`)
  return out
}

export function checkCron(expr: string): string {
  parseCron(expr)
  return expr
}

const at = (d: Date, y: number, mo: number, day: number, h: number, mi: number) =>
  new Date(y, mo, day, h, mi, 0, 0)

// Следующее срабатывание строго после `from` (минута считается прошедшей).
export function nextCronRun(expr: string, from: Date | number = Date.now()): number {
  const c = parseCron(expr)
  let cur = new Date(typeof from === 'number' ? from : from.getTime())
  cur = at(cur, cur.getFullYear(), cur.getMonth(), cur.getDate(), cur.getHours(), cur.getMinutes() + 1)
  const limit = 366 * 24 * 60 * 4 // 4 года: 29 февраля бывает реже
  for (let i = 0; i < limit; i++) {
    if (!c.months.has(cur.getMonth() + 1)) {
      cur = at(cur, cur.getFullYear(), cur.getMonth() + 1, 1, 0, 0)
      continue
    }
    const domOk = c.dom.has(cur.getDate())
    const dowOk = c.dow.has(cur.getDay())
    const dayOk = c.domRestricted && c.dowRestricted ? domOk || dowOk : domOk && dowOk
    if (!dayOk) {
      cur = at(cur, cur.getFullYear(), cur.getMonth(), cur.getDate() + 1, 0, 0)
      continue
    }
    if (!c.hours.has(cur.getHours())) {
      cur = at(cur, cur.getFullYear(), cur.getMonth(), cur.getDate(), cur.getHours() + 1, 0)
      continue
    }
    if (!c.minutes.has(cur.getMinutes())) {
      cur = at(cur, cur.getFullYear(), cur.getMonth(), cur.getDate(), cur.getHours(), cur.getMinutes() + 1)
      continue
    }
    return cur.getTime()
  }
  throw new TypeError(`cron: "${expr}" не сработает в ближайшие 4 года`)
}

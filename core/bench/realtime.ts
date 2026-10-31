// Стоимость dependsOn-пересчёта: сколько времени от коммита до последнего reset.
// bun bench/realtime.ts [подписок] [пользователей]
//
// Подписки идут через настоящий WebSocket: сервер принимает 20 сообщений в
// секунду на соединение, поэтому подписка пачками по 20 раз в 1.05 с.
import { z } from 'zod'
import { startServer } from '../src/server'
import { tmpDir } from '../test/helpers'

const N = Number(process.argv[2] ?? 1000)
const USERS = Number(process.argv[3] ?? 10)
const MAX_PER_CONN = 100
const evals = { n: 0 }
const RULE_MS = Number(process.env.BENCH_RULE_MS ?? 0)
const until = (ms: number) => performance.now() + ms

const p = (m: string) => console.log(m)

const s = await startServer({
  dataDir: tmpDir('bench-realtime'),
  port: 0,
  hostname: '127.0.0.1',
  env: {},
  onWarning: () => {},
  db: { fsync: false },
  realtime: true,
  collections: {
    rooms: { schema: z.object({ participants: z.array(z.string()) }).passthrough(), rules: { list: (u) => (u ? { participants: u.id } : false), create: () => true } },
    messages: {
      schema: z.object({ text: z.string(), roomId: z.string() }).passthrough(),
      rules: {
        dependsOn: ['rooms'],
        list: async (u, { db }) => {
          evals.n++
          if (!u) return false
          const ids = (await db.rooms!.find({ participants: u.id }, { fields: ['_id'] })).map((r) => r._id)
          await Bun.sleep(RULE_MS) // насколько дорогое правило: BENCH_RULE_MS
          return { roomId: { $in: ids } }
        },
      },
    },
  },
})

const users: Array<{ _id: string; accessToken: string }> = []
for (let i = 0; i < USERS; i++) {
  const r = await fetch(`${s.url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `u${i}@example.test`, password: 'bench-pass-1' }),
  })
  const reg = await r.json()
  users.push({ _id: reg.user._id, accessToken: reg.accessToken })
}

// Подписки: N штук, поровну на пользователей, по 100 на соединение
const perUser = Math.ceil(N / USERS)
const conns: Array<{ ws: WebSocket; inbox: any[]; subs: number; resets: number }> = []
for (let ui = 0; ui < USERS; ui++) {
  for (let c = 0; c * MAX_PER_CONN < perUser; c++) {
    const subs = Math.min(MAX_PER_CONN, perUser - c * MAX_PER_CONN)
    if (conns.length * MAX_PER_CONN >= N) break
    const ws = new WebSocket(s.url.replace('http', 'ws') + '/api/realtime')
    const conn = { ws, inbox: [] as any[], subs, resets: 0 }
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      conn.inbox.push(m)
      if (m.type === 'reset') conn.resets++
    }
    ws.onerror = () => console.error('ws error')
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws: нет открытия за 5 с')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
    })
    ws.send(JSON.stringify({ type: 'hello', token: users[ui]!.accessToken }))
    conns.push(conn)
    await Bun.sleep(60) // не больше 20 сообщений в секунду на соединение
  }
}
let total = 0
await Promise.all(
  conns.map(async (conn) => {
    for (let round = 0; round < Math.ceil(conn.subs / 20); round++) {
      for (let i = round * 20; i < Math.min(conn.subs, (round + 1) * 20); i++) conn.ws.send(JSON.stringify({ type: 'sub', id: `s${i}`, collection: 'messages', filter: {} }))
      if ((round + 1) * 20 < conn.subs) await Bun.sleep(1050)
    }
    total += conn.subs
  }),
)
// ждём, пока сервер подтвердит все подписки: подписка сама считает правило,
// и её вызовы не должны попасть в замер коммита
while (performance.now() < until(Date.now()) && !conns.every((c) => c.inbox.filter((m) => m.type === 'subscribed').length >= c.subs)) await Bun.sleep(20)
p(`подписок открыто: ${total} на ${conns.length} соединениях, пользователей ${USERS}`)
await Bun.sleep(300)

// Коммит в зависимую коллекцию: добавляем комнату первому пользователю
evals.n = 0
const t0 = performance.now()
const created = await fetch(`${s.url}/api/c/rooms`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${users[0]!.accessToken}` },
  body: JSON.stringify({ participants: [users[0]!._id] }),
})
if (created.status !== 200) throw new Error(`rooms: ${created.status} ${await created.text()}`)
// ждём reset на подписках первого пользователя (только у него изменилось правило)
const first = conns.slice(0, Math.ceil(perUser / MAX_PER_CONN))
while (performance.now() < until(30_000) && !first.every((c) => c.resets >= c.subs)) await Bun.sleep(5)
if (!first.every((c) => c.resets >= c.subs)) throw new Error('не все reset доехали')
const ms = performance.now() - t0
p(JSON.stringify({ subs: total, users: USERS, ruleEvals: evals.n, ms: Math.round(ms) }))
for (const c of conns) c.ws.close()
await s.stop()
process.exit(0)

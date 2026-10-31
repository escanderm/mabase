// Тест 202: dependsOn на масштабе (design.md §12). Правило list зависит от
// пользователя и базы, но не от подписки: на 500 подписок одного пользователя
// при коммите в зависимую коллекцию оно должно посчитаться один раз, а не 500.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { startServer } from '../src/server'
import { tmpDir, waitFor } from './helpers'

const PASSWORD = 'alice-pass-1'

async function connect(url: string, token: string) {
  const ws = new WebSocket(url.replace('http', 'ws') + '/api/realtime')
  const inbox: any[] = []
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)))
  await new Promise((r) => (ws.onopen = r))
  ws.send(JSON.stringify({ type: 'hello', token }))
  return { ws, inbox }
}

describe('dependsOn на масштабе', () => {
  test('202. 500 подписок одного пользователя: правило считается один раз за коммит', async () => {
    const evals = { n: 0 }
    const s = await startServer({
      dataDir: tmpDir('deps-scale'),
      port: 0,
      hostname: '127.0.0.1',
      env: {},
      onWarning: () => {},
      db: { fsync: false },
      realtime: true,
      collections: {
        rooms: { schema: z.object({ name: z.string().optional(), participants: z.array(z.string()) }).passthrough(), rules: { list: (u) => (u ? { participants: u.id } : false), create: () => true } },
        messages: {
          schema: z.object({ text: z.string(), roomId: z.string() }).passthrough(),
          rules: {
            dependsOn: ['rooms'],
            list: async (u, { db }) => {
              evals.n++
              if (!u) return false
              const ids = (await db.rooms!.find({ participants: u.id }, { fields: ['_id'] })).map((r) => r._id)
              return { roomId: { $in: ids } }
            },
          },
        },
      },
    })
    try {
      const reg = await (
        await fetch(`${s.url}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.test', password: PASSWORD }) })
      ).json()
      const conns = await Promise.all(Array.from({ length: 5 }, () => connect(s.url, reg.accessToken)))
      // по 100 подписок на соединение (предел на соединение), всего 500.
      // Частоту держим: сервер принимает 20 сообщений в секунду на соединение.
      await Promise.all(
        conns.map(async ({ ws }) => {
          for (let round = 0; round < 5; round++) {
            for (let i = round * 20; i < (round + 1) * 20; i++) ws.send(JSON.stringify({ type: 'sub', id: `s${i}`, collection: 'messages', filter: {} }))
            if (round < 4) await Bun.sleep(1050)
          }
        }),
      )
      await waitFor(() => conns.every((c) => c.inbox.filter((m) => m.type === 'subscribed').length === 100), 10_000)

      // подписка тоже не должна считать правило на каждую подписку: 5 соединений
      // по 100 подписок. Кэш соединения живёт до коммита, а подписки идут с
      // паузами (лимит 20 сообщений в секунду) и между ними бывают коммиты
      // presence - поэтому запас, но всё равно в разы меньше 500.
      expect(evals.n).toBeLessThanOrEqual(20)
      evals.n = 0
      const created = await fetch(`${s.url}/api/c/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reg.accessToken}` },
        body: JSON.stringify({ participants: [reg.user._id] }),
      })
      expect(created.status).toBe(200)
      // правило стало другим (появилась комната) - каждой подписке reset
      await waitFor(() => conns.every((c) => c.inbox.filter((m) => m.type === 'reset').length === 100), 10_000)
      expect(evals.n).toBe(1) // до правки было бы 500
    } finally {
      await s.stop()
    }
  }, 40_000)
})

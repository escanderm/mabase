// Тесты 1-9b из SPEC §7: транзакции, очередь, хуки.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { openDb, type CommitInfo } from '../src/db'
import { DepthError, TxAbortedError, TxTimeoutError } from '../src/errors'
import { currentLogPath, sleep, tmpDir, waitFor } from './helpers'

describe('транзакции и очередь', () => {
  test('1. параллельные увеличения не теряются', async () => {
    const db = await openDb({ dir: tmpDir(), compactMinBytes: 0 })

    const a = await db.c.counters!.insert({ n: 0 })
    await Promise.all(Array.from({ length: 100 }, () => db.c.counters!.update(a._id, { $inc: { n: 1 } })))
    expect(db.peek('counters', a._id)!.n).toBe(100)

    // прочитать -> подумать -> записать: очередь держится с первого чтения
    const b = await db.c.counters!.insert({ n: 0 })
    await Promise.all(
      Array.from({ length: 100 }, () =>
        db.transaction(async (tx) => {
          const cur = await tx.c.counters!.findOne({ _id: b._id })
          await sleep(0)
          await tx.c.counters!.update(b._id, { $set: { n: cur!.n + 1 } })
        }),
      ),
    )
    expect(db.peek('counters', b._id)!.n).toBe(100)
    await db.close()
  })

  test('2. ошибка в before* отменяет весь пакет, включая вложенные записи', async () => {
    const dir = tmpDir()
    const setup = (db: Awaited<ReturnType<typeof openDb>>) =>
      db.collection('rooms', {
        hooks: {
          beforeUpdate: async ({ next, db }) => {
            await db.c.audit!.insert({ note: 'вложенная запись из хука' })
            if (next.locked) throw new Error('комната закрыта')
          },
        },
      })
    const db = await openDb({ dir, compactMinBytes: 0 })
    setup(db)
    const room = await db.c.rooms!.insert({ participants: [] })
    const sizeBefore = db.stats.logSize
    const txBefore = db.lastTx

    await expect(
      db.transaction(async (tx) => {
        await tx.c.invites!.insert({ roomId: room._id, to: 'u2' })
        await tx.c.rooms!.update(room._id, { $set: { participants: ['u2'], locked: true } })
      }),
    ).rejects.toThrow('комната закрыта')

    // даже если действие поймает ошибку хука, транзакция всё равно отменена
    await expect(
      db.transaction(async (tx) => {
        await tx.c.invites!.insert({ roomId: room._id, to: 'u3' })
        try {
          await tx.c.rooms!.update(room._id, { $set: { locked: true } })
        } catch {}
        return 'ok'
      }),
    ).rejects.toThrow('комната закрыта')

    const check = async (d: typeof db) => {
      expect(await d.c.invites!.find()).toEqual([])
      expect(await d.c.audit!.find()).toEqual([])
      expect(d.peek('rooms', room._id)!.participants).toEqual([])
    }
    await check(db)
    expect(db.stats.logSize).toBe(sizeBefore)
    expect(db.lastTx).toBe(txBefore)
    await db.close()

    const reopened = await openDb({ dir, compactMinBytes: 0 })
    setup(reopened)
    await check(reopened)
    expect(reopened.lastTx).toBe(txBefore)
    await reopened.close()
  })

  test('3. after* обновляет тот же документ и не зависает', async () => {
    const db = await openDb({ dir: tmpDir(), compactMinBytes: 0 })
    db.collection('posts', {
      hooks: {
        afterUpdate: async ({ prev, doc, db }) => {
          if (doc.title !== prev.title) await db.c.posts!.update(doc._id, { $inc: { edits: 1 } })
        },
      },
    })
    const p = await db.c.posts!.insert({ title: 'a', edits: 0 })
    const t0 = performance.now()
    await db.c.posts!.update(p._id, { $set: { title: 'b' } })
    await waitFor(() => db.peek('posts', p._id)!.edits === 1, 1000)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(db.peek('posts', p._id)!.title).toBe('b')
    await db.close()
  })

  test('4. таймаут отменяет транзакцию, поздний хук ничего не сохраняет', async () => {
    const dir = tmpDir()
    let lateError: unknown
    const db = await openDb({ dir, txTimeoutMs: 200, compactMinBytes: 0 })
    db.collection('slow', {
      hooks: {
        beforeCreate: async ({ doc, db }) => {
          await sleep(400) // 2x таймаута
          try {
            await db.c.audit!.insert({ late: true })
          } catch (err) {
            lateError = err
          }
          return doc
        },
      },
    })

    const t0 = performance.now()
    const err = await db.c.slow!.insert({ a: 1 }).catch((e) => e)
    expect(err).toBeInstanceOf(TxTimeoutError)
    expect((err as TxTimeoutError).holdMs).toBeGreaterThanOrEqual(190)

    await db.c.other!.insert({ ok: true }) // очередь свободна сразу после таймаута
    expect(performance.now() - t0).toBeLessThan(350)

    await sleep(400) // хук доработал
    expect(lateError).toBeInstanceOf(TxAbortedError)
    expect(await db.c.slow!.find()).toEqual([])
    expect(await db.c.audit!.find()).toEqual([])
    expect(readFileSync(currentLogPath(dir), 'utf8')).not.toContain('"late"')
    await db.close()

    const reopened = await openDb({ dir })
    expect(await reopened.c.slow!.find()).toEqual([])
    expect(await reopened.c.audit!.find()).toEqual([])
    expect(await reopened.c.other!.find()).toHaveLength(1)
    await reopened.close()
  })

  test('5. внутри транзакции видно свои изменения, снаружи - нет до коммита', async () => {
    const db = await openDb({ dir: tmpDir(), compactMinBytes: 0 })
    db.collection('invites', { indexes: ['roomId'] })
    const old = await db.c.invites!.insert({ roomId: 'r1', to: 'a' })

    let inside: any
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const txDone = db.transaction(async (tx) => {
      const created = await tx.c.invites!.insert({ roomId: 'r1', to: 'b' })
      await tx.c.invites!.remove(old._id)
      inside = {
        byId: (await tx.c.invites!.findOne({ _id: created._id }))?.to,
        byIndex: (await tx.c.invites!.find({ roomId: 'r1' })).map((d) => d.to),
        removed: await tx.c.invites!.findOne({ _id: old._id }),
      }
      await gate
    })

    await sleep(20)
    const outsideBefore = (await db.c.invites!.find({ roomId: 'r1' })).map((d) => d.to)
    open()
    await txDone
    const outsideAfter = (await db.c.invites!.find({ roomId: 'r1' })).map((d) => d.to)

    expect(inside).toEqual({ byId: 'b', byIndex: ['b'], removed: null })
    expect(outsideBefore).toEqual(['a'])
    expect(outsideAfter).toEqual(['b'])
    expect(db.verifyIndexes()).toEqual([])
    await db.close()
  })

  test('6. ошибка в after* не отменяет сохранённое', async () => {
    const errors: string[] = []
    const db = await openDb({
      dir: tmpDir(),
      compactMinBytes: 0,
      onError: (err, info) => errors.push(`${info.where}:${(err as Error).message}`),
    })
    db.collection('x', {
      hooks: {
        afterCreate: () => {
          throw new Error('boom')
        },
      },
    })
    const doc = await db.c.x!.insert({ v: 1 })
    await waitFor(() => errors.length === 1)
    expect(errors).toEqual(['after*:boom'])
    expect(db.peek('x', doc._id)!.v).toBe(1)
    await db.close()
  })

  test('7. запись из after* - новая транзакция', async () => {
    const commits: CommitInfo[] = []
    const db = await openDb({ dir: tmpDir(), compactMinBytes: 0 })
    db.onCommit((i) => commits.push(i))
    db.collection('a', {
      hooks: {
        afterCreate: async ({ doc, db }) => {
          await db.c.b!.insert({ from: doc._id })
        },
      },
    })
    await db.c.a!.insert({})
    await waitFor(() => commits.length === 2)
    expect(commits.map((c) => c.ops.map((o) => o.c))).toEqual([['a'], ['b']])
    expect(commits[1]!.tx).toBe(commits[0]!.tx + 1)
    await db.close()
  })

  test('8. глубина: вложенные записи в одной транзакции, превышение отменяет всё', async () => {
    const commits: CommitInfo[] = []
    const db = await openDb({ dir: tmpDir(), compactMinBytes: 0, maxDepth: 5 })
    db.onCommit((i) => commits.push(i))
    db.collection('chain', {
      hooks: {
        beforeCreate: async ({ doc, db }) => {
          if (doc.level < doc.stop) await db.c.chain!.insert({ level: doc.level + 1, stop: doc.stop })
          return doc
        },
      },
    })

    await db.c.chain!.insert({ level: 0, stop: 3 })
    expect(commits).toHaveLength(1)
    expect(commits[0]!.ops).toHaveLength(4) // 4 документа - одна строка лога

    const txBefore = db.lastTx
    await expect(db.c.chain!.insert({ level: 0, stop: 100 })).rejects.toBeInstanceOf(DepthError)
    expect(db.lastTx).toBe(txBefore)
    expect(await db.c.chain!.find()).toHaveLength(4)
    await db.close()
  })

  test('9. onCommit: только сохранённые, по порядку, память уже обновлена, есть holdMs', async () => {
    const db = await openDb({ dir: tmpDir(), compactMinBytes: 0 })
    const seen: Array<{ tx: number; inMemory: boolean; holdMs: number }> = []
    db.onCommit(({ tx, ops, holdMs }) => {
      const op = ops[0]!
      const id = op.op === 'put' ? op.doc._id : op.id
      seen.push({ tx, inMemory: op.op === 'put' ? db.peek(op.c, id) !== null : db.peek(op.c, id) === null, holdMs })
    })

    await db.c.x!.insert({ i: 1 })
    await db.transaction(async (tx) => {
      await tx.c.x!.insert({ i: 2 })
      await sleep(50) // держим очередь
    })
    await db.transaction(async () => {
      throw new Error('отмена')
    }).catch(() => {})
    await db.c.x!.insert({ i: 3 })

    expect(seen.map((s) => s.tx)).toEqual([1, 2, 3])
    expect(seen.every((s) => s.inMemory)).toBe(true)
    // holdMs включает fsync, поэтому верхнюю границу не проверяем: на медленном диске она плавает
    expect(seen.every((s) => Number.isFinite(s.holdMs) && s.holdMs >= 0)).toBe(true)
    expect(seen[1]!.holdMs).toBeGreaterThanOrEqual(45)
    await db.close()
  })

  test('9a. очередь берётся при первом обращении к базе, а не на старте', async () => {
    const db = await openDb({ dir: tmpDir(), compactMinBytes: 0 })
    let aWritesAt = 0
    let bDoneAt = 0
    const a = db.transaction(async (tx) => {
      await sleep(500) // имитация fetch до обращения к базе
      aWritesAt = performance.now()
      await tx.c.x!.insert({ who: 'a' })
    })
    const b = db.c.x!.insert({ who: 'b' }).then(() => (bDoneAt = performance.now()))
    await Promise.all([a, b])
    expect(bDoneAt).toBeGreaterThan(0)
    expect(bDoneAt).toBeLessThan(aWritesAt)
    await db.close()
  })

  test('9b. ULID уникальны, списки в индексе отсортированы - и после переоткрытия, и после компактирования', async () => {
    const dir = tmpDir()
    const rooms = Array.from({ length: 10 }, (_, i) => `r${i}`)
    const open = async () => {
      const db = await openDb({ dir, fsync: false, compactMinBytes: 0 })
      db.collection('m', { indexes: ['room'] })
      return db
    }
    let db = await open()

    // 100 параллельных транзакций по 100 вставок
    const ids: string[] = []
    await Promise.all(
      Array.from({ length: 100 }, (_, t) =>
        db.transaction(async (tx) => {
          for (let i = 0; i < 100; i++) {
            const d = await tx.c.m!.insert({ room: rooms[(t * 7 + i) % 10], i })
            ids.push(d._id)
          }
        }),
      ),
    )
    expect(new Set(ids).size).toBe(10_000)
    expect(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true)
    expect(db.verifyIndexes()).toEqual([])

    const order = async () => {
      const out: string[][] = []
      for (const r of rooms) {
        const list = (await db.c.m!.find({ room: r })).map((d) => d._id)
        expect([...list].sort()).toEqual(list)
        out.push(list)
      }
      return out
    }
    const before = await order()

    await db.close()
    db = await open()
    expect(db.verifyIndexes()).toEqual([])
    expect(await order()).toEqual(before)

    await db.compact()
    await db.close()
    db = await open()
    expect(db.verifyIndexes()).toEqual([])
    expect(await order()).toEqual(before)
    await db.close()
  })
})

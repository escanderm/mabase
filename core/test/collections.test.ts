// Коллекции: схемы, проверка фильтров и обновлений, методы, порог компактирования.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { openDb } from '../src/db'
import { DefinitionError, QueryError, ValidationError } from '../src/errors'
import { currentLogPath, tmpDir } from './helpers'

const open = (dir = tmpDir('c'), more = {}) => openDb({ dir, fsync: false, compactMinBytes: 0, ...more })

describe('схема', () => {
  const message = z.object({ roomId: z.string(), text: z.string().min(1), likes: z.number().default(0) })

  test('26. проверка при записи: неверный документ не пишется, транзакция живёт дальше', async () => {
    const db = await open()
    db.collection('messages', { schema: message })
    const saved = await db.c.messages!.insert({ roomId: 'r', text: 'привет', junk: 1 })
    expect(saved.likes).toBe(0) // умолчание из схемы
    expect(saved.junk).toBeUndefined() // лишнее поле срезано (z.object)
    expect(typeof saved._createdAt).toBe('number')

    await expect(db.c.messages!.insert({ roomId: 'r', text: '' })).rejects.toBeInstanceOf(ValidationError)
    await expect(db.c.messages!.update(saved._id, { $set: { likes: 'много' } })).rejects.toThrow(/likes/)

    // ошибка схемы - не ошибка в before*: действие может её поймать и продолжить
    const tx = db.lastTx
    await db.transaction(async (t) => {
      await t.c.messages!.insert({ roomId: 'r' }).catch(() => {})
      await t.c.messages!.insert({ roomId: 'r', text: 'второе' })
    })
    expect(db.lastTx).toBe(tx + 1)
    expect(await db.c.messages!.count()).toBe(2)
    await db.close()
  })

  test('27. смена схемы: старые документы читаются как есть, запись требует новую схему', async () => {
    const dir = tmpDir('c')
    let db = await open(dir)
    db.collection('messages', { schema: message })
    const old = await db.c.messages!.insert({ roomId: 'r', text: 'старое' })
    await db.close()

    db = await open(dir)
    db.collection('messages', { schema: message.extend({ authorId: z.string() }) })
    expect(await db.c.messages!.findOne({ _id: old._id })).toMatchObject({ text: 'старое' }) // без authorId
    await expect(db.c.messages!.update(old._id, { $set: { text: 'правка' } })).rejects.toThrow(/authorId/)
    expect((await db.c.messages!.update(old._id, { $set: { authorId: 'u1' } })).authorId).toBe('u1')
    await db.close()
  })

  test('28. индекс на поле-объект или дату - ошибка при описании коллекции', async () => {
    const db = await open()
    const schema = z.object({ meta: z.object({ a: z.number() }), at: z.date().optional(), tags: z.array(z.string()) })
    expect(() => db.collection('x', { schema, indexes: ['meta'] })).toThrow(DefinitionError)
    expect(() => db.collection('x', { schema, indexes: ['at'] })).toThrow(/date/)
    expect(() => db.collection('x', { schema, indexes: ['_id'] })).toThrow(/всегда/)
    db.collection('x', { schema, indexes: ['meta.a', 'tags'] }) // вложенное поле и массив строк - можно
    await db.close()
  })

  test('29. в базу попадает только то, что переживёт JSON', async () => {
    const dir = tmpDir('c')
    let db = await open(dir)
    await expect(db.c.x!.insert({ at: new Date() })).rejects.toThrow(/Date.now/)
    await expect(db.c.x!.insert({ n: NaN })).rejects.toThrow(QueryError)
    await expect(db.c.x!.insert({ m: new Map() })).rejects.toThrow(/Map/)
    const d = await db.c.x!.insert({ a: undefined, b: 1, nested: { c: undefined } })
    expect(Object.keys(d)).not.toContain('a') // как после рестарта
    await db.close()
    db = await open(dir)
    expect(await db.c.x!.findOne({ _id: d._id })).toEqual(d)
    await db.close()
  })
})

describe('фильтры и обновления', () => {
  test('30. фильтр проверяется по белому списку', async () => {
    const db = await open()
    await db.c.x!.insert({ meta: { a: 1, b: 2 } })
    // sift выполняет $where как код - запрещено
    await expect(db.c.x!.find({ $where: 'true' })).rejects.toThrow(/\$where/)
    await expect(db.c.x!.find({ a: { $where: 'true' } })).rejects.toThrow(/\$where/)
    await expect(db.c.x!.find({ a: { $expr: 1 } })).rejects.toThrow(QueryError)
    // объект целиком - зависит от порядка ключей
    await expect(db.c.x!.find({ meta: { b: 2, a: 1 } })).rejects.toThrow(/через точку/)
    expect(await db.c.x!.count({ 'meta.a': 1 })).toBe(1)
    await expect(db.c.x!.find({ a: { $in: 'x' } })).rejects.toThrow(/массив/)
    await expect(db.c.x!.find({ a: { $gt: { x: 1 } } })).rejects.toThrow(QueryError)
    await expect(db.c.x!.find({}, { limit: 0 })).rejects.toThrow(/limit/)
    await expect(db.c.x!.find({}, { sort: { a: 'asc' as any } })).rejects.toThrow(/sort/)
    await db.close()
  })

  test('31. обновления: $push, $pull, запрет служебных полей и замены документа', async () => {
    const db = await open()
    db.collection('rooms', { indexes: ['participants'] })
    const room = await db.c.rooms!.insert({ participants: ['a', 'b'], log: [{ u: 'a' }, { u: 'b' }] })
    await db.c.rooms!.update(room._id, { $push: { participants: 'c' } })
    await db.c.rooms!.update(room._id, { $pull: { participants: 'a', log: { u: 'b' } } })
    const r = await db.c.rooms!.findOne({ _id: room._id })
    expect(r!.participants).toEqual(['b', 'c'])
    expect(r!.log).toEqual([{ u: 'a' }])
    expect((await db.c.rooms!.find({ participants: 'a' })).length).toBe(0) // индекс обновился
    expect((await db.c.rooms!.find({ participants: 'c' })).length).toBe(1)

    await expect(db.c.rooms!.update(room._id, { name: 'x' } as any)).rejects.toThrow(/\$set/)
    await expect(db.c.rooms!.update(room._id, { $set: { _id: 'y' } })).rejects.toThrow(/_id/)
    await expect(db.c.rooms!.update(room._id, { $rename: {} } as any)).rejects.toThrow(/\$rename/)
    expect(db.verifyIndexes()).toEqual([])
    await db.close()
  })
})

describe('методы коллекции', () => {
  test('32. insertMany: вне транзакции пачками по 1000, внутри - одной транзакцией', async () => {
    const db = await open()
    const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ i }))
    let tx = db.lastTx
    await db.c.x!.insertMany(docs(2500))
    expect(db.lastTx - tx).toBe(3)
    tx = db.lastTx
    await db.transaction((t) => t.c.x!.insertMany(docs(2500)))
    expect(db.lastTx - tx).toBe(1)
    expect(await db.c.x!.count()).toBe(5000)
    await db.close()
  })

  test('33. upsert: повторный запуск сида не создаёт дублей, своё _id из фильтра', async () => {
    const db = await open()
    const seed = () => db.c.rooms!.upsert({ _id: 'general' }, { name: 'Общая', participants: ['a'] })
    const first = await seed()
    const second = await seed()
    expect(first._id).toBe('general')
    expect(second._createdAt).toBe(first._createdAt)
    expect(await db.c.rooms!.count()).toBe(1)
    await db.c.invites!.upsert({ roomId: 'general', to: 'u1' }, { from: 'a' })
    expect(await db.c.invites!.findOne({ to: 'u1' })).toMatchObject({ roomId: 'general', from: 'a' })
    await db.close()
  })

  test('34. removeMany - одна транзакция; count, findOne с сортировкой, fields', async () => {
    const db = await open()
    db.collection('m', { indexes: ['roomId'] })
    await db.c.m!.insertMany(Array.from({ length: 30 }, (_, i) => ({ roomId: i % 3 ? 'a' : 'b', n: i, deep: { k: i } })))
    expect(await db.c.m!.count({ roomId: 'b' })).toBe(10)
    expect((await db.c.m!.findOne({ roomId: 'a' }, { sort: { n: -1 } }))!.n).toBe(29)
    const [slim] = await db.c.m!.find({ n: 4 }, { fields: ['roomId', 'deep.k'] })
    expect(slim).toEqual({ _id: slim!._id, roomId: 'a', deep: { k: 4 } })

    const tx = db.lastTx
    expect(await db.c.m!.removeMany({ roomId: 'b' })).toBe(10)
    expect(db.lastTx).toBe(tx + 1)
    expect(await db.c.m!.count()).toBe(20)
    expect(db.verifyIndexes()).toEqual([])
    await db.close()
  })

  test('35. большая транзакция - предупреждение', async () => {
    const warnings: string[] = []
    const db = await open(tmpDir('c'), { bigTxOps: 100, onWarning: (m: string) => warnings.push(m) })
    await db.c.x!.insertMany(Array.from({ length: 100 }, () => ({})))
    expect(warnings).toEqual([])
    await db.transaction((t) => t.c.x!.insertMany(Array.from({ length: 101 }, () => ({}))))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/101 операций/)
    await db.close()
  })
})

describe('компактирование', () => {
  test('36. порог относительный: лог больше снапшота (и не меньше минимума)', async () => {
    const dir = tmpDir('c')
    const db = await open(dir, { compactMinBytes: 4096 })
    const doc = { text: 'x'.repeat(200) }
    const settle = () => (db as any).compacting as Promise<void> | null

    // до минимума - не компактирует
    while (db.stats.logSize < 3500) await db.c.x!.insert(doc)
    expect(db.stats.gen).toBe(0)
    // база растёт: каждое компактирование - ровно когда лог перерос снапшот
    const seen: Array<{ snapshot: number; logBefore: number }> = []
    for (let i = 0; i < 400; i++) {
      const before = db.stats
      await db.c.x!.insert(doc)
      await settle()
      if (db.stats.gen === before.gen) continue
      const line = 400 // строка лога с одним документом - около 340 байт
      const threshold = Math.max(4096, before.snapshotSize)
      expect(before.logSize).toBeLessThanOrEqual(threshold) // раньше времени не компактировал
      expect(before.logSize + line).toBeGreaterThan(threshold) // и не опоздал
      seen.push({ snapshot: db.stats.snapshotSize, logBefore: before.logSize })
    }
    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(seen.at(-1)!.snapshot).toBeGreaterThan(4096 * 2) // порог действительно рос вместе с базой
    console.log(`  компактирования при снапшотах: ${seen.map((s) => s.snapshot).join(', ')} байт`)
    await db.close()
  })
})

// Тесты 10-12 из SPEC §7: ошибка записи, битый лог, компактирование.
import { describe, expect, test } from 'bun:test'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { openDb } from '../src/db'
import { CorruptionError } from '../src/errors'
import { currentLogPath, dump, files, tmpDir } from './helpers'

describe('диск и восстановление', () => {
  test('10. ошибка записи: транзакция отклонена, лог обрезан, база работает дальше', async () => {
    const dir = tmpDir()
    const db = await openDb({ dir, compactMinBytes: 0 })
    db.collection('x', { indexes: ['k'] })
    await db.c.x!.insert({ k: 'ok1' })
    const sizeBefore = statSync(currentLogPath(dir)).size

    process.env.MB_FAIL_WRITE = '1'
    try {
      await expect(db.c.x!.insert({ k: 'bad' })).rejects.toThrow('MB_FAIL_WRITE')
    } finally {
      delete process.env.MB_FAIL_WRITE
    }
    expect(statSync(currentLogPath(dir)).size).toBe(sizeBefore)
    expect((await db.c.x!.find()).map((d) => d.k)).toEqual(['ok1'])
    expect(db.verifyIndexes()).toEqual([])

    await db.c.x!.insert({ k: 'ok2' })
    expect(db.lastTx).toBe(2) // номер неудачной транзакции не пропал
    await db.close()

    const reopened = await openDb({ dir })
    expect((await reopened.c.x!.find()).map((d) => d.k)).toEqual(['ok1', 'ok2'])
    await reopened.close()
  })

  test('11a. неполная последняя строка отбрасывается, база стартует', async () => {
    const dir = tmpDir()
    const db = await openDb({ dir, compactMinBytes: 0 })
    for (let i = 0; i < 3; i++) await db.c.x!.insert({ i })
    await db.close()

    const log = currentLogPath(dir)
    const goodSize = statSync(log).size
    appendFileSync(log, '{"tx":4,"ts":1,"ops":[{"op":"put","c":"x","doc":{"_id":"Z","i"')

    const reopened = await openDb({ dir })
    expect(await reopened.c.x!.find()).toHaveLength(3)
    expect(statSync(log).size).toBe(goodSize)
    await reopened.c.x!.insert({ i: 3 })
    expect(reopened.lastTx).toBe(4)
    await reopened.close()
  })

  test('11b. нечитаемая последняя строка с переводом строки тоже отбрасывается', async () => {
    const dir = tmpDir()
    const db = await openDb({ dir, compactMinBytes: 0 })
    await db.c.x!.insert({ i: 0 })
    await db.close()
    appendFileSync(currentLogPath(dir), 'мусор\n')

    const reopened = await openDb({ dir })
    expect(await reopened.c.x!.find()).toHaveLength(1)
    await reopened.close()
  })

  test('11c. битая строка в середине - отказ запуска с номером строки', async () => {
    const dir = tmpDir()
    const db = await openDb({ dir, compactMinBytes: 0 })
    for (let i = 0; i < 3; i++) await db.c.x!.insert({ i })
    await db.close()

    const log = currentLogPath(dir)
    const lines = readFileSync(log, 'utf8').split('\n')
    lines[2] = lines[2]!.slice(0, 20) // строка 3 файла = транзакция 2
    writeFileSync(log, lines.join('\n'))

    const err = await openDb({ dir }).catch((e) => e)
    expect(err).toBeInstanceOf(CorruptionError)
    expect(err.message).toContain('строка 3')
  })

  test('11d. пропуск номера транзакции - отказ запуска', async () => {
    const dir = tmpDir()
    const db = await openDb({ dir, compactMinBytes: 0 })
    for (let i = 0; i < 3; i++) await db.c.x!.insert({ i })
    await db.close()

    const log = currentLogPath(dir)
    const lines = readFileSync(log, 'utf8').split('\n')
    lines.splice(2, 1) // выкинуть транзакцию 2
    writeFileSync(log, lines.join('\n'))

    const err = await openDb({ dir }).catch((e) => e)
    expect(err).toBeInstanceOf(CorruptionError)
    expect(err.message).toContain('ожидалась транзакция 2')
  })

  test('12. компактирование: состояние то же, старые файлы удалены, переоткрытие сходится', async () => {
    const dir = tmpDir()
    const colls = ['a', 'b']
    const open = async (compactMinBytes = 0) => {
      const db = await openDb({ dir, compactMinBytes })
      db.collection('a', { indexes: ['g'] })
      return db
    }
    let db = await open()
    const ids: string[] = []
    for (let i = 0; i < 50; i++) ids.push((await db.c.a!.insert({ g: i % 5, i }))._id)
    for (let i = 0; i < 50; i += 3) await db.c.a!.update(ids[i]!, { $inc: { i: 1000 }, $set: { g: 9 } })
    for (let i = 1; i < 50; i += 7) await db.c.a!.remove(ids[i]!)
    await db.c.b!.insert({ only: 'b' })

    const before = await dump(db, colls)
    await db.compact()
    expect(files(dir)).toEqual(['CURRENT', 'LOCK', `log.${db.lastTx}.jsonl`, `snapshot.${db.lastTx}.jsonl`])
    expect(await dump(db, colls)).toEqual(before)
    expect(db.verifyIndexes()).toEqual([])

    await db.c.b!.insert({ after: 'compact' })
    const afterMore = await dump(db, colls)
    await db.close()

    db = await open(2048) // маленький порог: компактирование будет срабатывать само
    expect(await dump(db, colls)).toEqual(afterMore)
    const genBefore = db.stats.gen
    for (let i = 0; i < 40; i++) await db.c.b!.insert({ i, pad: 'x'.repeat(100) })
    await db.close() // close дожидается фонового компактирования
    expect(db.stats.gen).toBeGreaterThan(genBefore)

    const final = await open()
    expect(await final.c.b!.find()).toHaveLength(42)
    expect(final.verifyIndexes()).toEqual([])
    await final.close()
    expect(files(dir)).toHaveLength(3) // LOCK снят при закрытии
  })
})

// Тесты 15-20: защита от второго писателя, чужие файлы в папке, отсутствие CURRENT,
// устаревший CURRENT, режим "только чтение", предупреждения, заморозка onCommit.
// Добавлены после ревью коллеги: каждая из этих проблем была воспроизведена до исправления.
import { describe, expect, test } from 'bun:test'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../src/db'
import { CorruptionError, LockedError, ReadOnlyError } from '../src/errors'
import { currentLogPath, files, tmpDir, waitFor } from './helpers'

const WORKER = join(import.meta.dir, 'crash', 'worker.ts')

describe('защита данных', () => {
  test('15a. второй процесс на той же папке получает понятную ошибку, данные не теряются', async () => {
    const dir = tmpDir('lock')
    const db = await openDb({ dir, compactMinBytes: 0 })
    const writing = (async () => {
      for (let i = 0; i < 200; i++) await db.c.a!.insert({ batch: 'main', i })
    })()

    const proc = Bun.spawn(['bun', WORKER, dir, 'intruder', '200'], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    await writing

    expect(proc.exitCode).not.toBe(0)
    expect(err).toContain('LockedError')
    expect(err).toContain(`процессом ${process.pid}`)
    expect(out).not.toContain('ACK')
    expect(await db.c.a!.find()).toHaveLength(200)
    await db.close()

    const reopened = await openDb({ dir })
    expect(await reopened.c.a!.find()).toHaveLength(200)
    await reopened.close()
  })

  test('15b. второй openDb в том же процессе тоже отказывает', async () => {
    const dir = tmpDir('lock')
    const db = await openDb({ dir })
    expect(await openDb({ dir }).catch((e) => e)).toBeInstanceOf(LockedError)
    await db.close()
    const again = await openDb({ dir }) // после close замок снят
    await again.close()
  })

  test('15c. замок умершего процесса забирается, свежий пустой - нет', async () => {
    const dir = tmpDir('lock')
    await (await openDb({ dir })).close()

    writeFileSync(join(dir, 'LOCK'), '999999\n') // процесса с таким pid нет
    await (await openDb({ dir })).close()

    writeFileSync(join(dir, 'LOCK'), '') // другой процесс только что создал замок
    expect(await openDb({ dir }).catch((e) => e)).toBeInstanceOf(LockedError)

    const old = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'LOCK'), old, old) // пустой и старый - мусор
    await (await openDb({ dir })).close()
  })

  test('16. чужие файлы в папке не мешают и не удаляются', async () => {
    const dir = tmpDir('foreign')
    mkdirSync(join(dir, 'files'), { recursive: true })
    writeFileSync(join(dir, 'types.d.ts'), 'declare module "mabase" {}')
    writeFileSync(join(dir, 'files', 'avatar.png'), 'png')
    writeFileSync(join(dir, 'upload.tmp'), 'половина загрузки')

    let db = await openDb({ dir, compactMinBytes: 0 })
    await db.c.x!.insert({ v: 1 })
    await db.compact()
    await db.close()
    db = await openDb({ dir })
    expect(await db.c.x!.find()).toHaveLength(1)
    await db.close()

    for (const f of ['types.d.ts', 'files/avatar.png', 'upload.tmp']) expect(existsSync(join(dir, f))).toBe(true)
  })

  test('17a. нет CURRENT, а в логе поколения 0 есть данные - отказ, ничего не удалено', async () => {
    const dir = tmpDir('current')
    const db = await openDb({ dir })
    await db.c.x!.insert({ important: true })
    await db.close()
    const log = join(dir, 'log.0.jsonl')
    const size = statSync(log).size

    unlinkSync(join(dir, 'CURRENT'))
    const err = await openDb({ dir }).catch((e) => e)
    expect(err).toBeInstanceOf(CorruptionError)
    expect(err.message).toContain('Ничего не удаляю')
    expect(statSync(log).size).toBe(size)

    writeFileSync(join(dir, 'CURRENT'), '0\n') // пользователь восстановил CURRENT
    const restored = await openDb({ dir })
    expect(await restored.c.x!.find()).toHaveLength(1)
    await restored.close()
  })

  test('17b. прерванное создание пустой базы - создаётся заново', async () => {
    const dir = tmpDir('current')
    mkdirSync(dir, { recursive: true })
    const header = JSON.stringify({ format: 'mabase-log', version: 1, base: 0 }) + '\n'
    writeFileSync(join(dir, 'snapshot.0.jsonl'), '{"format":"mabase-snapshot","version":1,"tx":0}\n{"end":true,"count":0}\n')
    writeFileSync(join(dir, 'log.0.jsonl.tmp'), header.slice(0, 10))
    const db = await openDb({ dir })
    await db.c.x!.insert({ v: 1 })
    await db.close()
    expect(files(dir)).toEqual(['CURRENT', 'log.0.jsonl', 'snapshot.0.jsonl'])
  })

  test('18. устаревший CURRENT при более новом поколении с данными - отказ, ничего не удалено', async () => {
    const dir = tmpDir('stale')
    const backup = tmpDir('stale-backup')
    let db = await openDb({ dir, compactMinBytes: 0 })
    await db.c.x!.insert({ v: 1 })
    await db.close()
    for (const f of ['CURRENT', 'snapshot.0.jsonl', 'log.0.jsonl']) copyFileSync(join(dir, f), join(backup, f))

    db = await openDb({ dir, compactMinBytes: 0 })
    await db.compact()
    await db.c.x!.insert({ v: 2 }) // в новом поколении есть транзакции
    const gen = db.stats.gen
    await db.close()

    // "восстановили из бэкапа" только старые файлы
    for (const f of ['CURRENT', 'snapshot.0.jsonl', 'log.0.jsonl']) copyFileSync(join(backup, f), join(dir, f))
    const err = await openDb({ dir }).catch((e) => e)
    expect(err).toBeInstanceOf(CorruptionError)
    expect(err.message).toContain(`log.${gen}.jsonl`)
    expect(existsSync(join(dir, `log.${gen}.jsonl`))).toBe(true)
    expect(existsSync(join(dir, `snapshot.${gen}.jsonl`))).toBe(true)
  })

  test('19. не удалось откатить лог - режим "только чтение", после перезапуска всё целое', async () => {
    const dir = tmpDir('ro')
    const db = await openDb({ dir, compactMinBytes: 0 })
    await db.c.x!.insert({ k: 'ok' })

    process.env.MB_FAIL_WRITE = '1'
    process.env.MB_FAIL_TRUNCATE = '1'
    try {
      expect(await db.c.x!.insert({ k: 'bad' }).catch((e) => e)).toBeInstanceOf(ReadOnlyError)
    } finally {
      delete process.env.MB_FAIL_WRITE
      delete process.env.MB_FAIL_TRUNCATE
    }
    // дописывать после мусора нельзя - база отказывает в записи и дальше
    expect(await db.c.x!.insert({ k: 'later' }).catch((e) => e)).toBeInstanceOf(ReadOnlyError)
    expect((await db.c.x!.find()).map((d) => d.k)).toEqual(['ok']) // чтение работает
    await db.close()

    const warnings: string[] = []
    const reopened = await openDb({ dir, onWarning: (m) => warnings.push(m) })
    expect(reopened.recovery.droppedTailBytes).toBeGreaterThan(0)
    expect(warnings[0]).toContain('отброшена недописанная транзакция')
    expect((await reopened.c.x!.find()).map((d) => d.k)).toEqual(['ok'])
    await reopened.c.x!.insert({ k: 'after-restart' })
    expect(reopened.lastTx).toBe(2)
    await reopened.close()
  })

  test('20a. при старте без проблем предупреждений нет, с оборванной строкой - есть', async () => {
    const dir = tmpDir('warn')
    const db = await openDb({ dir })
    await db.c.x!.insert({ v: 1 })
    await db.close()

    const quiet: string[] = []
    await (await openDb({ dir, onWarning: (m) => quiet.push(m) })).close()
    expect(quiet).toEqual([])

    appendFileSync(currentLogPath(dir), '{"tx":2,"ts":1,"ops":[')
    const warnings: string[] = []
    const reopened = await openDb({ dir, onWarning: (m) => warnings.push(m) })
    expect(warnings).toHaveLength(1)
    expect(reopened.recovery.droppedTailBytes).toBe('{"tx":2,"ts":1,"ops":['.length)
    await reopened.close()
  })

  test('20b. onCommit получает замороженные документы и не может испортить память', async () => {
    const errors: string[] = []
    const db = await openDb({ dir: tmpDir('freeze'), compactMinBytes: 0, onError: (e) => errors.push((e as Error).message) })
    db.onCommit(({ ops }) => {
      const op = ops[0]!
      if (op.op === 'put') (op.doc as any).hacked = true
    })
    const d = await db.c.x!.insert({ v: 1 })
    expect(errors).toHaveLength(1)
    expect(db.peek('x', d._id)!.hacked).toBeUndefined()
    await db.c.x!.update(d._id, { $inc: { v: 1 } }) // замороженный документ в памяти не мешает обновлению
    await waitFor(() => db.peek('x', d._id)!.v === 2)
    await db.close()
  })
})

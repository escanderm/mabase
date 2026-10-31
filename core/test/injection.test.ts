// Тесты 135-145: пути через прототип, откат связи, индекс по числовому
// сегменту, $set через не-объект. Каждый из этих багов был воспроизведён до
// исправления (ревью коллеги, 2026-10-30): загрязнение Object.prototype
// клиентским PATCH, связь с битой ссылкой при пойманной ошибке, разные ответы
// с индексом и без него, тихая потеря поля при $set в скаляр.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Access } from '../src/access'
import { Auth } from '../src/auth'
import { openDb, type Doc } from '../src/db'
import { QueryError } from '../src/errors'
import { createHandler } from '../src/http'
import { Mailer } from '../src/mail'
import { applyUpdate } from '../src/query'
import { tmpDir, waitFor } from './helpers'

const SECRET = 'injection-secret-'.padEnd(48, 'x')

// Загрязнение прототипа видно сразу: пустой объект начинает «иметь» поле.
const polluted = (name: string) => ({} as any)[name] !== undefined

describe('пути через прототип', () => {
  test('144. $set, $unset, $inc, $push и вложенный путь с __proto__ - ошибка, процесс чист', () => {
    const doc: Doc = { _id: 'x', a: 1 }
    for (const update of [
      { $set: { '__proto__.leak': 'да' } },
      { $unset: { '__proto__.toString': '' } },
      { $inc: { '__proto__.n': 1 } },
      { $push: { '__proto__.arr': 1 } },
      { $set: { 'a.__proto__.leak': 'да' } },
      { $set: { 'constructor.prototype.leak': 'да' } },
    ] as any[]) {
      expect(() => applyUpdate(doc, update)).toThrow(QueryError)
    }
    expect(polluted('leak')).toBe(false)
    expect(polluted('n')).toBe(false)
    expect(polluted('arr')).toBe(false)
    expect(typeof ({} as any).toString).toBe('function')
    expect(JSON.stringify(doc)).toContain('"a":1')
  })

  test('145. клиентский фильтр, sort и fields с __proto__/constructor - 400, а не 500', async () => {
    const db = await openDb({ dir: tmpDir('cl'), compactMinBytes: 0 })
    db.collection('n', {})
    await db.c.n!.insert({ _id: '1', text: 'раз' })
    const access = new Access(db, { n: { rules: { list: () => true, view: () => true } } })
    const c = access.forUser(null).c.n!

    expect(await c.find({ '__proto__.x': 1 }).catch((e) => e.message)).toContain('недопустимо')
    expect(await c.find({}, { sort: { 'constructor.x': 1 } }).catch((e) => e.message)).toContain('недопустимо')
    expect(await c.get('1', { fields: ['constructor'] }).catch((e) => e.message)).toContain('недопустимо')
    expect(polluted('x')).toBe(false)
    await db.close()
  })

  test('146. PATCH через HTTP: 400, Object.prototype цел, процесс не отравлен', async () => {
    const db = await openDb({ dir: tmpDir('http'), fsync: false, compactMinBytes: 0 })
    db.collection('p', { schema: z.object({ a: z.number().optional() }).passthrough() })
    const access = new Access(db, { p: { rules: { list: () => true, view: () => true, update: () => true, create: () => true } } })
    const auth = new Auth(access, { secret: SECRET, mail: new Mailer({ onDevMail: () => {} }) })
    const h = createHandler({ access, auth })
    const call = (method: string, path: string, body?: unknown) =>
      h(
        new Request(`http://localhost${path}`, {
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )

    const created = await (await call('POST', '/api/c/p', { a: 1 })).json()
    const id = created._id as string

    const patch = await call('PATCH', `/api/c/p/${id}`, { $set: { '__proto__.httpLeak': 'да' } })
    expect(patch.status).toBe(400)
    expect(polluted('httpLeak')).toBe(false)

    const fields = await call('GET', `/api/c/p/${id}?fields=constructor`)
    expect(fields.status).toBe(400)

    const filter = await call('GET', `/api/c/p?filter=${encodeURIComponent('{"__proto__.httpLeak":"да"}')}`)
    expect(filter.status).toBe(400)

    // обычная работа после отказов
    const ok = await (await call('PATCH', `/api/c/p/${id}`, { $set: { a: 2 } })).json()
    expect(ok.a).toBe(2)
    await db.close()
  })
})

describe('связи', () => {
  test('147. пойманная ошибка связи отменяет транзакцию, битая ссылка не сохраняется', async () => {
    const db = await openDb({ dir: tmpDir('rel'), compactMinBytes: 0 })
    db.collection('rooms')
    db.collection('messages', { relations: { roomId: { to: 'rooms' } } })
    const room = await db.c.rooms!.insert({ name: 'r1' })

    let caught: unknown
    const txError = await db
      .transaction(async (tx) => {
        try {
          await tx.c.messages!.insert({ text: 'битая', roomId: 'нет-такой' })
        } catch (err) {
          caught = err
        }
      })
      .catch((err) => err)
    expect((caught as Error).message).toContain('нет документа')
    // Транзакция отменена целиком, хотя код ошибку поймал: иначе битая ссылка
    // сохранилась бы при коммите (design.md §10).
    expect((txError as Error).message).toContain('нет документа')

    // Ни документа с битой ссылкой, ни «половины» транзакции в базе нет.
    expect(await db.c.messages!.find()).toEqual([])
    expect(db.lastTx).toBe(1) // была только вставка комнаты
    await db.close()

    const reopened = await openDb({ dir: tmpDir('rel2'), compactMinBytes: 0 })
    expect(await reopened.c.messages!.find()).toEqual([])
    await reopened.close()
  })

  test('148. restrict, пойманный кодом действия, тоже отменяет транзакцию', async () => {
    const db = await openDb({ dir: tmpDir('restrict'), compactMinBytes: 0 })
    db.collection('rooms')
    db.collection('messages', { relations: { roomId: { to: 'rooms' } } })
    const room = await db.c.rooms!.insert({ name: 'r1' })
    await db.c.messages!.insert({ text: 'привет', roomId: room._id })

    let caught: unknown
    const txError = await db
      .transaction(async (tx) => {
        try {
          await tx.c.rooms!.remove(room._id)
        } catch (err) {
          caught = err
        }
      })
      .catch((err) => err)
    expect((caught as Error).message).toContain('ссылается')
    expect((txError as Error).message).toContain('ссылается')
    expect(await db.c.rooms!.find()).toHaveLength(1)
    expect(await db.c.messages!.find()).toHaveLength(1)
    await db.close()
  })
})

describe('индекс по числовому сегменту пути', () => {
  test('149. tags.0: с индексом и без - один и тот же ответ', async () => {
    const base = { _id: '1', tags: ['a', 'b'], name: 'one' }
    const withIndex = await openDb({ dir: tmpDir('num'), compactMinBytes: 0 })
    withIndex.collection('x', { indexes: ['tags.0'] })
    await withIndex.c.x!.insert({ ...base })

    const plain = await openDb({ dir: tmpDir('num2'), compactMinBytes: 0 })
    plain.collection('x', {})
    await plain.c.x!.insert({ ...base })

    for (const q of [{ 'tags.0': 'a' }, { 'tags.0': 'b' }, { 'tags.1': 'a' }, { 'tags.2': 'c' }]) {
      const a = await withIndex.c.x!.find(q)
      const b = await plain.c.x!.find(q)
      expect(a.length).toBe(b.length)
    }
    expect(await withIndex.c.x!.find({ 'tags.0': 'a' })).toHaveLength(1)
    await withIndex.close()
    await plain.close()
  })
})

describe('after* и глубина', () => {
  test('161. цикл after* -> запись -> after* упирается в maxDepth, а не идёт вечно', async () => {
    const errors: unknown[] = []
    const db = await openDb({ dir: tmpDir('after'), compactMinBytes: 0, maxDepth: 3, onError: (e) => errors.push(e) })
    db.collection('x', {
      hooks: {
        afterUpdate: async ({ doc, db }) => {
          await db.c.x!.update(doc._id, { $inc: { n: 1 } })
        },
      },
    })
    const d = await db.c.x!.insert({ n: 0 })
    await db.c.x!.update(d._id, { $set: { touched: true } })
    await waitFor(() => errors.length > 0, 3000)
    expect((errors[0] as Error).name).toBe('DepthError')
    // Цепочка ограничена: счётчик не уехал в бесконечность
    expect(db.peek('x', d._id)!.n).toBeLessThan(10)
    await db.close()
  }, 15_000)
})

describe('схема и события', () => {
  test('162. схема на update не срезает поля вне схемы: старое остаётся, новое не появляется', async () => {
    const db = await openDb({ dir: tmpDir('schema'), compactMinBytes: 0 })
    db.collection('u') // документ «старого» вида - до схемы
    const d = await db.c.u!.insert({ name: 'a', legacy: 1 })
    db.collection('u', { schema: z.object({ name: z.string() }) })

    await db.c.u!.update(d._id, { $set: { name: 'b' } })
    expect(db.peek('u', d._id)).toMatchObject({ name: 'b', legacy: 1 }) // раньше legacy исчезало

    // а вот новое поле вне схемы по-прежнему не появляется
    await db.c.u!.update(d._id, { $set: { extra: 2 } })
    expect(db.peek('u', d._id)!.extra).toBeUndefined()
    await db.close()
  })

  test('163. созданный и удалённый в одной транзакции документ не даёт событий и не пишет в лог', async () => {
    const db = await openDb({ dir: tmpDir('noop'), compactMinBytes: 0 })
    const changes: string[] = []
    db.onCommit((info) => {
      for (const ch of info.changes) changes.push(`${ch.c}:${ch.doc ? 'put' : 'del'}`)
    })
    const before = db.lastTx
    await db.transaction(async (tx) => {
      const d = await tx.c.tmp!.insert({ a: 1 })
      await tx.c.tmp!.remove(d._id)
    })
    // Раньше в лог уходил no-op del, а подписчики получали '<c>.created' с doc: null
    expect(db.lastTx).toBe(before)
    expect(changes).toEqual([])
    expect(await db.c.tmp!.find()).toEqual([])
    await db.close()
  })
})

describe('$set через не-объект', () => {
  test('150. вложенный путь через скаляр и через массив - ошибка, поле не теряется', async () => {
    const db = await openDb({ dir: tmpDir('set'), compactMinBytes: 0 })
    await db.c.x!.insert({ _id: '1', a: 'строка', list: [1, 2] })

    expect(await db.c.x!.update('1', { $set: { 'a.b': 1 } }).catch((e) => e.message)).toContain('не объект')
    expect(await db.c.x!.update('1', { $set: { 'list.b': 1 } }).catch((e) => e.message)).toContain('массив')

    expect(db.peek('x', '1')!.a).toBe('строка')
    expect(db.peek('x', '1')!.list).toEqual([1, 2])

    await db.c.x!.update('1', { $set: { 'list.0': 9 } }) // номер элемента - можно
    expect(db.peek('x', '1')!.list).toEqual([9, 2])
    await db.c.x!.update('1', { $set: { 'a.b': 1 } }).catch(() => {})
    await db.close()
  })
})

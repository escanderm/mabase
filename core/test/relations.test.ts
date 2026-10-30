// Связи между коллекциями: проверка ссылок, onDelete, expand через правила,
// связи из конфига и из админки.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { openDb, type Db } from '../src/db'
import { createClient } from '../src/client'
import { startServer, type RunningServer } from '../src/server'
import { tmpDir } from './helpers'

async function coreDb(): Promise<Db> {
  const db = await openDb({ dir: tmpDir('rel'), fsync: false })
  db.collection('users')
  db.collection('rooms', { relations: { ownerId: { to: 'users' }, participants: { to: 'users', many: true, onDelete: 'pull' } } })
  db.collection('messages', { relations: { roomId: { to: 'rooms', onDelete: 'cascade' }, authorId: { to: 'users', onDelete: 'unset' }, replyTo: { to: 'messages', onDelete: 'unset' } } })
  return db
}

describe('связи в ядре', () => {
  test('140. ссылки проверяются при записи; restrict, cascade, unset, pull; всё одной транзакцией', async () => {
    const db = await coreDb()
    const [a, b] = [await db.c.users!.insert({ name: 'A' }), await db.c.users!.insert({ name: 'B' })]
    const room = await db.c.rooms!.insert({ ownerId: a._id, participants: [a._id, b._id] })
    const m1 = await db.c.messages!.insert({ roomId: room._id, authorId: b._id })
    const m2 = await db.c.messages!.insert({ roomId: room._id, authorId: a._id, replyTo: m1._id })
    // ссылка на себя - можно
    const self = await db.c.messages!.insert({ _id: 'self', roomId: room._id, replyTo: 'self' })
    expect(self.replyTo).toBe('self')

    // нет такого документа, не тот тип - 400, ничего не записано
    for (const bad of [{ roomId: 'nope' }, { roomId: 1 }, { roomId: room._id, authorId: ['x'] }]) {
      await expect(db.c.messages!.insert(bad)).rejects.toMatchObject({ name: 'RelationError', code: 'bad_request' })
    }
    await expect(db.c.rooms!.update(room._id, { $push: { participants: 'ghost' } })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(db.c.rooms!.insert({ participants: 'x' })).rejects.toThrow('массив _id')
    expect(await db.c.messages!.count()).toBe(3)
    // null и отсутствие - можно
    await db.c.messages!.update(m2._id, { $set: { authorId: null } })

    // restrict: A - владелец комнаты; удалить нельзя, и ничего не изменилось (pull в participants не случился)
    await expect(db.c.users!.remove(a._id)).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('rooms.ownerId') })
    expect((await db.c.rooms!.findOne({ _id: room._id }))!.participants).toEqual([a._id, b._id])

    // pull + unset: B уходит из участников, у его сообщений пропадает автор
    await db.c.users!.remove(b._id)
    expect((await db.c.rooms!.findOne({ _id: room._id }))!.participants).toEqual([a._id])
    expect(await db.c.messages!.findOne({ _id: m1._id })).not.toHaveProperty('authorId')

    // cascade: комната уходит вместе с сообщениями; unset по replyTo не мешает
    await db.c.rooms!.remove(room._id)
    expect(await db.c.messages!.count()).toBe(0)
    await db.c.users!.remove(a._id) // теперь можно
    // поля-связи проиндексированы сами
    expect(db.inspect().find((x) => x.name === 'messages')!.indexes.sort()).toEqual(['authorId', 'replyTo', 'roomId'])
    await db.close()
  })

  test('141. описание связи проверяется; каскад по кругу не зацикливается; глубина ограничена', async () => {
    const db = await openDb({ dir: tmpDir('rel2'), fsync: false, maxDepth: 3 })
    expect(() => db.collection('x', { relations: { 'a.b': { to: 'y' } } })).toThrow('верхнего уровня')
    expect(() => db.collection('x', { relations: { a: { to: '' } } })).toThrow('to')
    expect(() => db.collection('x', { relations: { a: { to: 'y', onDelete: 'pull' } } })).toThrow('many')
    expect(() => db.collection('x', { relations: { a: { to: 'y', many: true, onDelete: 'unset' } } })).toThrow('pull')
    expect(() => db.collection('x', { relations: { a: { to: 'y', onDelete: 'drop' as any } } })).toThrow('onDelete')

    // a <-> b каскадом друг на друга
    db.collection('a', { relations: { b: { to: 'b', onDelete: 'cascade' } } })
    db.collection('b', { relations: { a: { to: 'a', onDelete: 'cascade' } } })
    await db.transaction(async (tx) => {
      await tx.c.a!.insert({ _id: 'a1' })
      await tx.c.b!.insert({ _id: 'b1', a: 'a1' })
      await tx.c.a!.update('a1', { $set: { b: 'b1' } })
    })
    await db.c.a!.remove('a1')
    expect((await db.c.a!.count()) + (await db.c.b!.count())).toBe(0)

    // цепочка длиннее maxDepth - ошибка, ничего не удалено
    db.collection('chain', { relations: { parent: { to: 'chain', onDelete: 'cascade' } } })
    await db.c.chain!.insert({ _id: 'n0' })
    for (let i = 1; i <= 5; i++) await db.c.chain!.insert({ _id: `n${i}`, parent: `n${i - 1}` })
    await expect(db.c.chain!.remove('n0')).rejects.toThrow('Глубина')
    expect(await db.c.chain!.count()).toBe(6)
    await db.close()
  })
})

let s: RunningServer
let su = ''
const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
  const res = await fetch(`${s.url}${path}`, {
    method,
    headers: { ...(opts.token && { Authorization: `Bearer ${opts.token}` }), ...(opts.body !== undefined && { 'Content-Type': 'application/json' }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}

describe('связи через сервер', () => {
  beforeAll(async () => {
    s = await startServer({
      dataDir: tmpDir('rel-srv'),
      port: 0,
      hostname: '127.0.0.1',
      env: {},
      onWarning: () => {},
      db: { fsync: false },
      realtime: true,
      collections: {
        users: { fields: { private: ['email'] } },
        rooms: {
          relations: { ownerId: { to: 'users' } },
          rules: { list: (u) => (u ? { members: u.id } : false), view: (u) => (u ? { members: u.id } : false), create: (u) => !!u },
        },
        messages: {
          relations: { roomId: { to: 'rooms', onDelete: 'cascade' }, authorId: { to: 'users', onDelete: 'unset' }, secretRef: { to: 'vault' } },
          fields: { hidden: ['secretRef'] },
          rules: { list: () => true, view: () => true, create: (u) => !!u },
        },
        vault: {},
      },
    })
    const setup = s.setupUrl!.split('/setup/')[1]
    su = (await call('POST', '/api/_/setup', { body: { token: setup, email: 'root@example.test', password: 'root-pass-123' } })).body.token
  })
  afterAll(() => s.stop())

  test('142. expand: через правило view связанной коллекции и её виды полей; HTTP, get, SDK; live с expand - ошибка', async () => {
    const alice = await call('POST', '/api/auth/register', { body: { email: 'a@example.test', password: 'alice-pass-1', data: { name: 'Алиса' } } })
    const bob = await call('POST', '/api/auth/register', { body: { email: 'b@example.test', password: 'bob-pass-12', data: { name: 'Боб' } } })
    const A = alice.body.user._id
    const B = bob.body.user._id
    await s.db.c.rooms!.insert({ _id: 'r1', name: 'Общая', ownerId: A, members: [A, B] })
    await s.db.c.rooms!.insert({ _id: 'r2', name: 'Тайная', ownerId: A, members: [A] })
    await s.db.c.messages!.insert({ _id: 'm1', roomId: 'r1', authorId: A, text: 'привет' })
    await s.db.c.messages!.insert({ _id: 'm2', roomId: 'r2', authorId: A, text: 'тайна' })

    const asBob = await call('GET', '/api/c/messages?sort={"_id":1}&expand=roomId,authorId', { token: bob.body.accessToken })
    expect(asBob.status).toBe(200)
    const [m1, m2] = asBob.body.items
    expect(m1._expand.roomId).toMatchObject({ _id: 'r1', name: 'Общая' })
    // комнату r2 Боб не видит - и через связь тоже
    expect(m2._expand.roomId).toBeNull()
    // users: каждый видит только себя (встроенное правило) - автор-Алиса Бобу не виден
    expect(m1._expand.authorId).toBeNull()
    const asAlice = await call('GET', '/api/c/messages/m1?expand=authorId', { token: alice.body.accessToken })
    expect(asAlice.body._expand.authorId).toMatchObject({ _id: A, name: 'Алиса' })
    expect(asAlice.body._expand.authorId).not.toHaveProperty('passwordHash')

    expect((await call('GET', '/api/c/messages?expand=text', { token: bob.body.accessToken })).status).toBe(400) // не связь
    expect((await call('GET', '/api/c/messages?expand=secretRef', { token: bob.body.accessToken })).status).toBe(400) // скрытое поле
    expect((await call('GET', `/api/c/messages?expand=${'roomId,'.repeat(11)}`, { token: bob.body.accessToken })).status).toBe(400)

    const mb = createClient(s.url)
    await mb.auth.login({ email: 'a@example.test', password: 'alice-pass-1' })
    const items = await mb.c.messages!.find({}, { expand: ['roomId'], sort: { _id: 1 } })
    expect(items.map((d: any) => d._expand.roomId.name)).toEqual(['Общая', 'Тайная'])
    expect(() => mb.live('messages', {}, { expand: ['roomId'] } as any)).toThrow('expand')
    mb.close()

    // клиент пишет ссылку на чужое - 400, на своё - можно
    expect((await call('POST', '/api/c/messages', { token: bob.body.accessToken, body: { roomId: 'nope', text: 'x' } })).status).toBe(400)
    expect((await call('POST', '/api/c/messages', { token: bob.body.accessToken, body: { roomId: 'r1', text: 'ok' } })).status).toBe(200)
  })

  test('143. админка: связи у своих коллекций, проверка старых документов, кто ссылается, expand мимо правил, restrict - 409', async () => {
    await call('POST', '/api/_/collections', { token: su, body: { name: 'tags' } })
    await call('POST', '/api/_/collections', { token: su, body: { name: 'posts' } })
    await call('POST', '/api/_/c/tags', { token: su, body: { _id: 'js', name: 'JavaScript' } })
    await call('POST', '/api/_/c/posts', { token: su, body: { _id: 'p1', tags: ['js', 'ghost'] } })

    // коллекции нет / связь у коллекции из кода / документ ссылается в никуда
    expect(await call('PUT', '/api/_/collections/posts', { token: su, body: { relations: { tags: { to: 'nowhere', many: true } } } })).toMatchObject({ status: 400 })
    expect(await call('PUT', '/api/_/collections/messages', { token: su, body: { relations: {} } })).toMatchObject({ status: 409 })
    expect(await call('PUT', '/api/_/collections/posts', { token: su, body: { relations: { tags: { to: 'tags', many: true, onDelete: 'pull' } } } })).toMatchObject({
      status: 409,
      body: { message: expect.stringContaining('в 1 документах') },
    })
    await call('PUT', '/api/_/c/posts/p1', { token: su, body: { tags: ['js'] } })
    const ok = await call('PUT', '/api/_/collections/posts', { token: su, body: { relations: { tags: { to: 'tags', many: true, onDelete: 'pull' } } } })
    expect(ok.body.relations).toEqual({ tags: { to: 'tags', many: true, onDelete: 'pull' } })
    expect(ok.body.indexes).toContain('tags')
    expect((await call('POST', '/api/_/c/posts', { token: su, body: { tags: ['ghost'] } })).status).toBe(400)

    const meta = (await call('GET', '/api/_/c/tags/meta', { token: su })).body
    expect(meta.incoming).toEqual([{ c: 'posts', field: 'tags', to: 'tags', many: true, onDelete: 'pull' }])
    expect((await call('GET', '/api/_/c/tags/js/backlinks', { token: su })).body).toEqual([{ c: 'posts', field: 'tags', count: 1, onDelete: 'pull' }])
    // expand в админке - мимо правил: комната r2 видна
    const msgs = (await call('GET', `/api/_/c/messages?expand=roomId&filter=${encodeURIComponent('{"_id":"m2"}')}`, { token: su })).body.items
    expect(msgs[0]._expand.roomId.name).toBe('Тайная')

    // restrict через админку: на пользователя ссылается rooms.ownerId
    const A = (await s.db.c.users!.findOne({ email: 'a@example.test' }))!._id
    expect(await call('DELETE', `/api/_/c/users/${A}`, { token: su })).toMatchObject({ status: 409, body: { message: expect.stringContaining('rooms.ownerId') } })
    // pull через админку
    await call('DELETE', '/api/_/c/tags/js', { token: su })
    expect((await s.db.c.posts!.findOne({ _id: 'p1' }))!.tags).toEqual([])

    // после перезапуска связи коллекций из админки на месте
    const dataDir = s.db.stats.dir.replace(/\/db$/, '')
    await s.stop()
    s = await startServer({ dataDir, port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false }, collections: { vault: {} } })
    expect(s.db.relations('posts')).toEqual({ tags: { to: 'tags', many: true, onDelete: 'pull' } })
    await expect(s.db.c.posts!.insert({ tags: ['nope'] })).rejects.toMatchObject({ code: 'bad_request' })
  })
})

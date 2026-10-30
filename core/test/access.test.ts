// Доступ клиента (design.md §11): правила-фильтры, виды полей, лимиты фильтров.
// Правила - из chat/mabase.config.ts.
import { describe, expect, test } from 'bun:test'
import { Access, checkClientRegex, type AccessDef } from '../src/access'
import { Actions, defineAction, toClientError } from '../src/actions'
import { openDb, type CollectionApi, type Db } from '../src/db'
import { tmpDir } from './helpers'

async function roomIdsOf(db: Record<string, CollectionApi>, userId: string): Promise<string[]> {
  return (await db.rooms!.find({ participants: userId }, { fields: ['_id'] })).map((r) => r._id)
}

let ruleCalls = 0
const chat: Record<string, AccessDef> = {
  rooms: {
    fields: { readonly: ['ownerId', 'participants'] },
    rules: {
      list: (user) => (user ? { participants: user.id } : false),
      view: (user) => (user ? { participants: user.id } : false),
      create: false,
      update: (user, { before }) => user?.id === before.ownerId,
      delete: false,
    },
  },
  messages: {
    owner: 'authorId',
    fields: { immutable: ['roomId'], readonly: ['authorId', 'editedAt'], private: ['draft'], hidden: ['ip'] },
    rules: {
      dependsOn: ['rooms'],
      list: async (user, { db }) => {
        ruleCalls++
        return user ? { roomId: { $in: await roomIdsOf(db, user.id) } } : false
      },
      view: async (user, { db }) => (user ? { roomId: { $in: await roomIdsOf(db, user.id) } } : false),
      create: async (user, { doc, db }) => !!user && (await roomIdsOf(db, user.id)).includes(doc.roomId as string),
      update: (user, { before, after }) => user?.id === before.authorId && after.text !== '',
      delete: (user, { before }) => user?.id === before.authorId,
    },
  },
}

const alice = { id: 'alice' }
const bob = { id: 'bob' }
const carol = { id: 'carol' }

async function setup(limits = {}) {
  const db = await openDb({ dir: tmpDir('acc'), fsync: false, compactMinBytes: 0 })
  db.collection('rooms', { indexes: ['participants', 'ownerId'] })
  db.collection('messages', {
    indexes: ['roomId'],
    // как в chat/: автора ставит хук по тому, кто пишет; сервер (сид) задаёт сам
    hooks: { beforeCreate: ({ doc, user }) => ({ ...doc, authorId: user?.id ?? (doc as any).authorId, ip: '10.0.0.1' }) },
  })
  await db.c.rooms!.insertMany([
    { _id: 'general', name: 'Общая', ownerId: 'alice', participants: ['alice', 'bob'] },
    { _id: 'private', name: 'Кэрол', ownerId: 'carol', participants: ['carol'] },
  ])
  await db.c.messages!.insertMany([
    { roomId: 'general', authorId: 'alice', text: 'привет', draft: 'черновик Алисы' },
    { roomId: 'general', authorId: 'bob', text: 'и тебе' },
    { roomId: 'private', authorId: 'carol', text: 'секрет' },
  ])
  await db.c.users!.insertMany([
    { _id: 'alice', email: 'alice@x.test', passwordHash: 'h1', name: 'Алиса', roles: [] },
    { _id: 'bob', email: 'bob@x.test', passwordHash: 'h2', name: 'Боб', roles: [] },
  ])
  return { db, access: new Access(db, chat, limits) }
}

async function err(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    return toClientError(e)
  }
  throw new Error('ожидалась ошибка')
}

describe('правила', () => {
  test('45. list и view - фильтры: каждый видит только свои комнаты и их сообщения', async () => {
    const { db, access } = await setup()
    const a = access.forUser(alice).c
    expect((await a.rooms!.find()).map((r) => r._id)).toEqual(['general'])
    expect((await a.messages!.find({}, { sort: { _id: -1 } })).map((m) => m.text)).toEqual(['и тебе', 'привет'])
    // фильтр клиента склеивается с правилом: чужая комната - пусто, а не ошибка
    expect(await a.messages!.find({ roomId: 'private' })).toEqual([])
    expect(await a.messages!.count()).toBe(2)
    const carolMsg = (await db.c.messages!.findOne({ roomId: 'private' }))!
    expect(await err(a.messages!.get(carolMsg._id))).toMatchObject({ status: 404 }) // не говорим, что запись есть
    expect((await access.forUser(carol).c.messages!.get(carolMsg._id)).text).toBe('секрет')

    expect(await err(access.forUser(null).c.messages!.find())).toMatchObject({ status: 401 })
    expect(await err(a.invites!.find())).toMatchObject({ status: 403 }) // нет правил - нет доступа
    expect(await err(a._scheduled!.find())).toMatchObject({ status: 403 })
    await db.close()
  })

  test('46. запись: create, update, delete по правилам; проверка и запись в одной транзакции', async () => {
    const { db, access } = await setup()
    const b = access.forUser(bob).c
    const m = await b.messages!.insert({ roomId: 'general', text: 'новое' })
    expect(m.authorId).toBe('bob') // authorId клиент не задаёт - его ставит хук по user транзакции
    expect(m.ip).toBeUndefined() // hidden не уходит даже автору

    expect(await err(b.messages!.insert({ roomId: 'private', text: 'влезть' }))).toMatchObject({ status: 403 })
    expect(await err(b.rooms!.insert({ name: 'своя' }))).toMatchObject({ status: 403 }) // create: false

    const bobs = (await db.c.messages!.findOne({ authorId: 'bob' }))!
    expect((await b.messages!.update(bobs._id, { $set: { text: 'исправил' } })).text).toBe('исправил')
    expect(await err(b.messages!.update(bobs._id, { $set: { text: '' } }))).toMatchObject({ status: 403 }) // after проверяется
    const alices = (await db.c.messages!.findOne({ authorId: 'alice' }))!
    expect(await err(b.messages!.update(alices._id, { $set: { text: 'взлом' } }))).toMatchObject({ status: 403 })
    expect(await err(b.messages!.remove(alices._id))).toMatchObject({ status: 403 })
    const carols = (await db.c.messages!.findOne({ authorId: 'carol' }))!
    expect(await err(b.messages!.remove(carols._id))).toMatchObject({ status: 404 }) // не видна - 404
    expect(await err(b.messages!.update(carols._id, { $set: { text: 'взлом' } }))).toMatchObject({ status: 404 })
    await b.messages!.remove(bobs._id)
    expect(db.peek('messages', bobs._id)).toBeNull()

    // переименовать комнату может владелец; участников - нет (readonly)
    expect((await access.forUser(alice).c.rooms!.update('general', { $set: { name: 'Главная' } })).name).toBe('Главная')
    expect(await err(access.forUser(alice).c.rooms!.update('general', { $push: { participants: 'carol' } }))).toMatchObject({ status: 403 })
    expect(await err(b.rooms!.update('general', { $set: { name: 'Моя' } }))).toMatchObject({ status: 403 })
    await db.close()
  })

  test('47. результат list кэшируется на сессию; запись читает правила заново', async () => {
    const { db, access } = await setup()
    ruleCalls = 0
    const s = access.forUser(alice)
    await s.c.messages!.find()
    await s.c.messages!.find({ text: 'привет' })
    await s.c.messages!.count()
    expect(ruleCalls).toBe(1)
    await access.forUser(alice).c.messages!.find() // новая сессия - новый расчёт
    expect(ruleCalls).toBe(2)
    await db.close()
  })

  test('48. серверный код идёт мимо правил: действие пишет readonly-поля', async () => {
    const { db, access } = await setup()
    const actions = new Actions(db, [
      defineAction('kick', {
        handler: ({ db }) => db.rooms!.update('general', { $pull: { participants: 'bob' } }),
      }),
    ])
    await actions.run('kick', undefined, alice)
    expect(await access.forUser(bob).c.messages!.find()).toEqual([]) // новая сессия видит новое правило
    await db.close()
  })
})

describe('виды полей', () => {
  test('49. hidden, private, readonly, immutable', async () => {
    const { db, access } = await setup()
    const a = access.forUser(alice).c
    const b = access.forUser(bob).c
    const [mine] = await a.messages!.find({ text: 'привет' })
    expect(mine!.draft).toBe('черновик Алисы') // private: владелец видит
    expect(mine!.ip).toBeUndefined()
    const [seen] = await b.messages!.find({ text: 'привет' })
    expect(seen!.draft).toBeUndefined() // не владелец - нет
    expect(Object.keys(seen!)).not.toContain('ip')

    expect(await err(b.messages!.insert({ roomId: 'general', text: 'x', authorId: 'alice' }))).toMatchObject({ status: 403 }) // readonly
    expect(await err(b.messages!.insert({ roomId: 'general', text: 'x', ip: '1' }))).toMatchObject({ status: 403 }) // hidden
    expect(await err(b.messages!.insert({ _id: 'свой', roomId: 'general', text: 'x' }))).toMatchObject({ status: 403 }) // служебное
    const own = await b.messages!.insert({ roomId: 'general', text: 'x', draft: 'моё' }) // immutable и private при создании - можно
    expect(own.draft).toBe('моё')
    expect(await err(b.messages!.update(own._id, { $set: { roomId: 'private' } }))).toMatchObject({ status: 403 }) // immutable
    expect(await err(a.messages!.update(own._id, { $set: { draft: 'чужое' } }))).toMatchObject({ status: 403 })
    await db.close()
  })

  test('50. users: каждый видит себя; email - только себе; passwordHash - никому', async () => {
    const { db, access } = await setup()
    const a = access.forUser(alice).c
    expect((await a.users!.find()).map((u) => u._id)).toEqual(['alice'])
    const me = await a.users!.get('alice')
    expect(me.email).toBe('alice@x.test')
    expect(me.passwordHash).toBeUndefined()
    expect(await err(a.users!.get('bob'))).toMatchObject({ status: 404 })
    expect((await a.users!.update('alice', { $set: { name: 'Алиса М.' } })).name).toBe('Алиса М.')
    for (const f of ['email', 'roles', 'verified', 'passwordHash']) {
      expect(await err(a.users!.update('alice', { $set: { [f]: 'x' } }))).toMatchObject({ status: 403 })
    }
    expect(await err(a.users!.insert({ name: 'новый' }))).toMatchObject({ status: 403 }) // регистрация - через вход
    expect(await err(a.users!.find({ email: { $regex: '^b' } }))).toMatchObject({ status: 400 })
    await db.close()
  })

  test('51. описание проверяется при старте', async () => {
    const db = await openDb({ dir: tmpDir('acc'), fsync: false, compactMinBytes: 0 })
    expect(() => new Access(db, { x: { fields: { private: ['a'] } } })).toThrow(/owner/)
    expect(() => new Access(db, { x: { fields: { hidden: ['a.b'] } } })).toThrow(/верхнего уровня/)
    expect(() => new Access(db, { x: { fields: { readonly: ['_id'] } } })).toThrow(/служебное/)
    expect(() => new Access(db, { x: { rules: { dependsOn: 'rooms' as any } } })).toThrow(/dependsOn/)
    const access = new Access(db, { ...chat, _presence: { rules: { dependsOn: ['rooms'], list: () => true } } })
    expect(access.dependents('rooms').sort()).toEqual(['_presence', 'messages'])
    expect(access.dependents('messages')).toEqual([])
    await db.close()
  })
})

describe('фильтры от клиента', () => {
  test('52. по невидимым полям нельзя фильтровать, сортировать и выбирать', async () => {
    const { db, access } = await setup()
    const b = access.forUser(bob).c
    for (const p of [
      b.messages!.find({ ip: '10.0.0.1' }),
      b.messages!.find({ $or: [{ text: 'x' }, { 'draft.len': 1 }] }),
      b.messages!.find({}, { sort: { ip: 1 } }),
      b.messages!.find({}, { fields: ['draft'] }),
      b.messages!.count({ ip: { $exists: true } }),
      b.messages!.find({ $where: 'true' }),
    ]) {
      expect(await err(p)).toMatchObject({ status: 400, code: 'bad_request' })
    }
    expect((await b.messages!.find({}, { fields: ['text'] }))[0]).toEqual({ _id: expect.any(String), text: 'привет' })
    await db.close()
  })

  test('53. $regex от клиента: без групп, альтернатив, обратных ссылок, не длиннее 64', async () => {
    const ok = ['^прив', 'ет$', '[a-z]+\\d*', 'a.b', 'x{2,3}', '\\(скобка\\)', '[(|)]']
    const badOnes = ['(a+)+$', 'a|b', '(x)\\1', 'a+b+c+', 'x{2,}y*z+', 'a'.repeat(65)]
    for (const p of ok) expect(() => checkClientRegex(p, 64)).not.toThrow()
    for (const p of badOnes) expect(() => checkClientRegex(p, 64)).toThrow()

    const { db, access } = await setup()
    const b = access.forUser(bob).c
    expect((await b.messages!.find({ text: { $regex: '^прив' } })).length).toBe(1)
    expect(await err(b.messages!.find({ text: { $regex: '(a+)+$' } }))).toMatchObject({ status: 400 })
    expect(await err(b.messages!.find({ text: { $not: { $regex: 'a|b' } } }))).toMatchObject({ status: 400 })
    await db.close()
  })

  test('54. limit по умолчанию и максимум; широкий запрос без индекса - ошибка с подсказкой', async () => {
    const { db, access } = await setup({ maxScanned: 500, defaultLimit: 10, maxLimit: 50 })
    await db.c.messages!.insertMany(Array.from({ length: 2000 }, (_, i) => ({ roomId: i < 1000 ? 'general' : 'other', authorId: 'bob', text: `m${i}` })))
    const b = access.forUser(bob).c
    expect(await b.messages!.find({ roomId: 'general' })).toHaveLength(10)
    expect(await err(b.messages!.find({}, { limit: 51 }))).toMatchObject({ status: 400 })
    expect(await b.messages!.find({}, { sort: { _id: -1 }, limit: 50 })).toHaveLength(50) // по индексу - проверено 50

    // текст без индекса: sift проверяет 1000+ сообщений комнаты - больше лимита
    const wide = await err(b.messages!.find({ text: 'нет такого' }))
    expect(wide).toMatchObject({ status: 400 })
    expect(wide.message).toMatch(/индекс/)
    expect(await err(b.messages!.count({ text: { $regex: '^m1' } }))).toMatchObject({ status: 400 })
    // серверный код лимитов не имеет
    expect(await db.c.messages!.count({ text: 'нет такого' })).toBe(0)
    await db.close()
  })
})

describe('--dev', () => {
  test('113. правило читает коллекцию не из dependsOn - предупреждение, один раз', async () => {
    const db = await openDb({ dir: tmpDir('dev'), fsync: false })
    db.collection('rooms', { indexes: ['participants'] })
    db.collection('messages', { indexes: ['roomId'] })
    const warnings: string[] = []
    const defs: Record<string, AccessDef> = {
      // как было в примере-чате до шага 8: dependsOn забыли
      messages: { rules: { list: async (u, { db }) => (u ? { roomId: { $in: await roomIdsOf(db, u.id) } } : false) } },
      rooms: { rules: { dependsOn: [], list: async (u, { db }) => (u ? { participants: u.id, x: (await db.rooms!.count()) >= 0 } : false) } },
      ok: { rules: { dependsOn: ['rooms'], list: async (u, { db }) => (u ? { roomId: { $in: await roomIdsOf(db, u.id) } } : false) } },
    }
    const access = new Access(db, defs, {}, { onRuleWarning: (m) => void warnings.push(m) })
    for (let i = 0; i < 3; i++) {
      await access.forUser(alice).c.messages!.find({})
      await access.forUser(alice).c.rooms!.find({})
      await access.forUser(alice).c.ok!.find({})
    }
    expect(warnings).toHaveLength(1) // одно на правило и коллекцию; своя коллекция и dependsOn - без предупреждения
    expect(warnings[0]).toContain("Правило messages.list читает коллекцию rooms")
    expect(warnings[0]).toContain("dependsOn: ['rooms']")
    // без --dev - ни предупреждений, ни обёртки
    const plain = new Access(db, defs)
    await plain.forUser(alice).c.messages!.find({})
    expect(warnings).toHaveLength(1)
    await db.close()
  })
})

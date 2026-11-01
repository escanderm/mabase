// Чат с закрытыми комнатами - пример приложения MaBase (design.md §19, шаг 3).
// Места, где пришлось что-то придумать сверх design.md, помечены [Q<n>] -
// разбор в examples/chat/API-NOTES.md.
import { ActionError, defineAction, defineCollection, defineConfig, z, type Db } from 'mabase'

// ---------- общие запросы для правил ----------

// Комнаты пользователя. Индекс по participants (массив) делает это быстрым.
async function roomIdsOf(db: Db, userId: string): Promise<string[]> {
  const rooms = await db.rooms.find({ participants: userId }, { fields: ['_id'] }) // [Q1]
  return rooms.map((r) => r._id)
}

// Все, с кем у пользователя есть общая комната, включая его самого.
async function contactsOf(db: Db, userId: string): Promise<string[]> {
  const rooms = await db.rooms.find({ participants: userId }, { fields: ['participants'] })
  return [...new Set(rooms.flatMap((r) => r.participants))]
}

// ---------- коллекции ----------

// users - встроенная коллекция (email, passwordHash, verified, roles).
// Здесь её только расширяем своими полями и правилами.
const users = defineCollection('users', {
  schema: z.object({
    name: z.string().min(1).max(40),
    avatarUrl: z.string().url().optional(),
  }),
  fields: {
    private: ['email'], // видит только сам пользователь [Q2]
  },
  rules: {
    // профиль видят те, с кем есть общая комната
    dependsOn: ['rooms'],
    list: async (user, { db }) => (user ? { _id: { $in: await contactsOf(db, user.id) } } : false),
    view: async (user, { db }) => (user ? { _id: { $in: await contactsOf(db, user.id) } } : false),
    update: (user, { before }) => user?.id === before._id,
  },
})

const rooms = defineCollection('rooms', {
  schema: z.object({
    name: z.string().min(1).max(80),
    ownerId: z.string(),
    participants: z.array(z.string()),
  }),
  indexes: ['participants', 'ownerId'],
  fields: {
    readonly: ['ownerId', 'participants'], // меняются только действиями
  },
  rules: {
    list: (user) => (user ? { participants: user.id } : false),
    view: (user) => (user ? { participants: user.id } : false),
    create: false, // только через действие createRoom
    update: (user, { before }) => user?.id === before.ownerId, // переименовать может владелец
    delete: false, // только через deleteRoom: вместе с комнатой уходят сообщения и приглашения
  },
})

const messages = defineCollection('messages', {
  schema: z.object({
    roomId: z.string(),
    authorId: z.string(),
    text: z.string().min(1).max(4000),
    editedAt: z.number().optional(),
  }),
  indexes: ['roomId'],
  fields: {
    immutable: ['roomId'], // задаётся при создании, потом не меняется [Q3]
    readonly: ['authorId', 'editedAt'],
  },
  rules: {
    // правило зависит от другой коллекции (rooms): выгнали - подписка получит reset [Q4]
    dependsOn: ['rooms'],
    list: async (user, { db }) => (user ? { roomId: { $in: await roomIdsOf(db, user.id) } } : false),
    view: async (user, { db }) => (user ? { roomId: { $in: await roomIdsOf(db, user.id) } } : false),
    create: async (user, { doc, db }) => !!user && (await roomIdsOf(db, user.id)).includes(doc.roomId),
    update: (user, { before }) => user?.id === before.authorId,
    delete: (user, { before }) => user?.id === before.authorId,
  },
  hooks: {
    // хуки - только мелочи: проставить автора и время правки
    // user - кто пишет; null - сервер (сид, импорт): тогда автор уже в doc
    beforeCreate: ({ doc, user }) => ({ ...doc, authorId: user?.id ?? doc.authorId }),
    beforeUpdate: ({ next }) => ({ ...next, editedAt: Date.now() }),
  },
})

const invites = defineCollection('invites', {
  // имя комнаты и пригласившего - копией: приглашённый ещё не видит ни комнату, ни автора
  schema: z.object({
    roomId: z.string(),
    roomName: z.string().optional(),
    from: z.string(),
    fromName: z.string().optional(),
    to: z.string(),
  }),
  indexes: ['to', 'roomId'],
  rules: {
    list: (user) => (user ? { $or: [{ to: user.id }, { from: user.id }] } : false),
    view: (user) => (user ? { $or: [{ to: user.id }, { from: user.id }] } : false),
    create: false, // только через действия
    update: false,
    delete: false,
  },
})

// Кто онлайн - обычная живая выборка по системной коллекции _presence.
// Правило: видны только те, с кем есть общая комната. [Q7]
const presence = defineCollection('_presence', {
  rules: {
    dependsOn: ['rooms'], // контакты меняются вместе с комнатами
    list: async (user, { db }) => (user ? { userId: { $in: await contactsOf(db, user.id) } } : false),
  },
})

// ---------- действия: вся бизнес-логика здесь ----------
// Действие - это транзакция. Требует входа, если не сказано public: true. [Q8]

const createRoom = defineAction('createRoom', {
  input: z.object({ name: z.string().min(1).max(80) }),
  handler: ({ input, user, db }) =>
    db.rooms.insert({ name: input.name, ownerId: user.id, participants: [user.id] }),
})

// Приглашение по email: id незнакомого человека клиент не знает - правило
// users показывает только контакты. Действие идёт мимо правил и находит сам.
const invite = defineAction('invite', {
  input: z.object({ roomId: z.string(), email: z.string().email() }),
  handler: async ({ input, user, db, emit }) => {
    const room = await db.rooms.findOne({ _id: input.roomId, ownerId: user.id })
    if (!room) throw new ActionError('not_found', 'Комната не найдена') // [Q9]
    const to = await db.users.findOne({ email: input.email.trim().toLowerCase() })
    if (!to) throw new ActionError('not_found', 'Пользователь с таким email не найден')
    if (room.participants.includes(to._id)) throw new ActionError('conflict', 'Уже в комнате')

    const existing = await db.invites.findOne({ roomId: room._id, to: to._id })
    if (existing) return existing

    const me = await db.users.findOne({ _id: user.id })
    const inv = await db.invites.insert({ roomId: room._id, roomName: room.name, from: user.id, fromName: me?.name, to: to._id })
    // письмо отправит отдельный обработчик; задача попадёт в ту же транзакцию
    emit('invite.email', { inviteId: inv._id }, { after: '0s', key: `invite:${inv._id}` })
    return inv
  },
})

const acceptInvite = defineAction('acceptInvite', {
  input: z.object({ inviteId: z.string() }),
  handler: async ({ input, user, db }) => {
    const inv = await db.invites.findOne({ _id: input.inviteId, to: user.id })
    if (!inv) throw new ActionError('not_found', 'Приглашение не найдено')
    await db.invites.remove(inv._id)
    await db.rooms.update(inv.roomId, { $push: { participants: user.id } })
    return { roomId: inv.roomId }
  },
})

const leaveRoom = defineAction('leaveRoom', {
  input: z.object({ roomId: z.string() }),
  handler: async ({ input, user, db }) => {
    const room = await db.rooms.findOne({ _id: input.roomId, participants: user.id })
    if (!room) throw new ActionError('not_found', 'Комната не найдена')
    if (room.ownerId === user.id) throw new ActionError('bad_request', 'Владелец не может выйти - удалите комнату')
    await db.rooms.update(room._id, { $pull: { participants: user.id } })
  },
})

// После kick у выгнанного должны пропасть сообщения комнаты из живой выборки,
// хотя сами сообщения не менялись. [Q4]
const kick = defineAction('kick', {
  input: z.object({ roomId: z.string(), userId: z.string() }),
  handler: async ({ input, user, db }) => {
    const room = await db.rooms.findOne({ _id: input.roomId, ownerId: user.id })
    if (!room) throw new ActionError('not_found', 'Комната не найдена')
    if (input.userId === user.id) throw new ActionError('bad_request', 'Нельзя выгнать себя')
    await db.rooms.update(room._id, { $pull: { participants: input.userId } })
  },
})

// Удаление комнаты - действие, а не правило delete: иначе сообщения и
// приглашения остались бы без комнаты. В комнате могут быть десятки тысяч
// сообщений - это одна большая транзакция. [Q12]
const deleteRoom = defineAction('deleteRoom', {
  input: z.object({ roomId: z.string() }),
  handler: async ({ input, user, db }) => {
    const room = await db.rooms.findOne({ _id: input.roomId, ownerId: user.id })
    if (!room) throw new ActionError('not_found', 'Комната не найдена')
    await db.messages.removeMany({ roomId: room._id })
    await db.invites.removeMany({ roomId: room._id })
    await db.rooms.remove(room._id)
  },
})

// ---------- конфиг ----------

export default defineConfig({
  collections: [users, rooms, messages, invites, presence],
  actions: [createRoom, invite, acceptInvite, leaveRoom, kick, deleteRoom],
  auth: {
    // providers здесь не задаём: способы входа включаются в админке (_/ -> Настройки),
    // иначе раздел был бы закреплён за кодом и Google/GitHub не включить.
    accessTtl: '15m',
    refreshTtl: '30d',
  },
  realtime: true,
  events: {
    // клиентское эфемерное событие: явно разрешено, со схемой [Q6]
    typing: {
      from: 'client',
      input: z.object({ roomId: z.string() }),
      // кто может слать: только участник комнаты; кому: участникам - один запрос на событие [Q5]
      allow: async (user, data, { db }) => (await roomIdsOf(db, user.id)).includes(data.roomId),
      to: async (data, { db }) => (await db.rooms.findOne({ _id: data.roomId }))?.participants ?? [],
    },
  },
})

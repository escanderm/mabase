// Клиент чата на тонком SDK. Без фреймворка: render* - ваши функции отрисовки.
// Главная идея: live() = запрос + подписка + перечитывание при реконнекте.
// SDK делает это сам (design.md §12, "Реконнект"), приложение видит только список.
import { createClient, MabaseError } from 'mabase/client'
import type config from '../mabase.config' // типы из zod-схем, без генерации [позже]

const mb = createClient<typeof config>('https://chat.example.test')

// ---------- вход ----------
// Токены SDK хранит и обновляет сам. После перезагрузки страницы - restore().
export async function login(email: string, password: string) {
  try {
    await mb.auth.login({ email, password })
  } catch (err) {
    if (err instanceof MabaseError && err.code === 'invalid_credentials') return showError('Неверный email или пароль')
    throw err
  }
  start()
}

function start() {
  const me = mb.auth.user!

  // ---------- мои комнаты ----------
  // Фильтр пустой: правило list само оставит только мои комнаты.
  const rooms = mb.live('rooms', {}, { sort: { name: 1 } })
  rooms.subscribe((list) => renderRooms(list))

  // ---------- приглашения мне ----------
  const invites = mb.live('invites', { to: me.id })
  invites.subscribe((list) => renderInvites(list))

  // ---------- кто онлайн ----------
  // Обычная живая выборка по _presence; правило покажет только моих контактов.
  const online = mb.live('_presence', {})
  online.subscribe((list) => renderOnline(new Set(list.map((p) => p.userId))))

  // ---------- состояние соединения ----------
  mb.on('connection', (state) => renderConnection(state)) // 'online' | 'reconnecting' | 'offline'
}

// ---------- открытая комната ----------

export function openRoom(roomId: string) {
  // Последние 50 сообщений + новые в реальном времени.
  // sort + limit доходят до индекса по roomId (design.md §8).
  const feed = mb.live('messages', { roomId }, { sort: { _id: -1 }, limit: 50 })
  feed.subscribe((list) => renderMessages([...list].reverse()))

  // Прокрутка вверх: ещё 50 старых. Курсор { _id: { $lt: самый старый } } SDK строит сам.
  onScrollTop(() => feed.loadMore(50))

  // Доступ к комнате пропал (выгнали, вышел сам): выборка очищается. [Q4]
  feed.on('revoked', () => {
    closeRoomView(roomId)
    showError('Вы больше не участник этой комнаты')
  })

  // Кто печатает. Сервер сам добавляет from - клиенту верить нельзя.
  const offTyping = mb.on('typing', ({ from, data }) => {
    if (data.roomId === roomId && from !== mb.auth.user!.id) showTyping(from)
  })

  return () => {
    feed.close()
    offTyping()
  }
}

// ---------- действия пользователя ----------

export async function send(roomId: string, text: string) {
  // Обычная запись в коллекцию: правило create проверит участие в комнате,
  // хук проставит authorId. Сообщение придёт обратно через live().
  await mb.c.messages.insert({ roomId, text })
}

export const notifyTyping = throttle((roomId: string) => mb.emit('typing', { roomId }), 2000)

export async function edit(messageId: string, text: string) {
  await mb.c.messages.update(messageId, { $set: { text } })
}

export async function createRoom(name: string) {
  const room = await mb.action('createRoom', { name })
  openRoom(room._id)
}

export async function inviteUser(roomId: string, userId: string) {
  try {
    await mb.action('invite', { roomId, userId })
  } catch (err) {
    if (err instanceof MabaseError && err.code === 'conflict') return showError('Уже в комнате')
    throw err
  }
}

export async function accept(inviteId: string) {
  const { roomId } = await mb.action('acceptInvite', { inviteId })
  openRoom(roomId)
}

export const leave = (roomId: string) => mb.action('leaveRoom', { roomId })
export const kick = (roomId: string, userId: string) => mb.action('kick', { roomId, userId })
export const deleteRoom = (roomId: string) => mb.action('deleteRoom', { roomId })

// ---------- заглушки отрисовки ----------
declare function renderRooms(list: unknown[]): void
declare function renderInvites(list: unknown[]): void
declare function renderOnline(ids: Set<string>): void
declare function renderConnection(state: string): void
declare function renderMessages(list: unknown[]): void
declare function closeRoomView(roomId: string): void
declare function showTyping(userId: string): void
declare function showError(text: string): void
declare function onScrollTop(fn: () => void): void
declare function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void

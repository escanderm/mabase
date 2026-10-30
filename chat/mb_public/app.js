// Чат на MaBase: весь клиент - этот файл и SDK с сервера (/api/client.js).
// Ни npm, ни сборщика. Логика - в действиях (mabase.config.ts), здесь только
// отрисовка: live() сам держит списки в актуальном виде.
import { createClient, MabaseError } from '/api/client.js'

const mb = createClient(location.origin)
const $ = (id) => document.getElementById(id)

// Элемент из тега, свойств и детей. Текст - только через textContent: без innerHTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c)
  return el
}

let toastTimer
function toast(text) {
  const t = $('toast')
  t.textContent = text
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000)
}

// Ошибки сервера - понятным текстом; неожиданные - в консоль.
const RU = {
  invalid_credentials: 'Неверный email или пароль',
  conflict: 'Уже есть',
  too_many_requests: 'Слишком часто, подождите',
  unavailable: 'Сервер занят, повторите',
}
function report(err) {
  if (err instanceof MabaseError) toast(RU[err.code] && err.code !== 'conflict' ? RU[err.code] : err.message)
  else {
    console.error(err)
    toast('Что-то пошло не так')
  }
}
const safe = (fn) => (...a) => Promise.resolve(fn(...a)).catch(report)

// ---------- вход ----------

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = new FormData(e.target)
  const mode = e.submitter?.value
  const email = f.get('email')
  const password = f.get('password')
  $('login-error').textContent = ''
  try {
    if (mode === 'register') await mb.auth.register({ email, password, data: { name: f.get('name') || email.split('@')[0] } })
    else await mb.auth.login({ email, password })
    start()
  } catch (err) {
    $('login-error').textContent =
      err instanceof MabaseError ? (err.code === 'invalid_credentials' ? RU.invalid_credentials : err.message) : 'Сервер недоступен'
  }
})

let leaving = false // свой выход: перезагрузить после запроса к серверу, а не до
$('logout').addEventListener('click', async () => {
  leaving = true
  await mb.auth.logout()
  location.reload()
})

// ---------- после входа ----------

const names = new Map() // userId -> имя, из живой выборки users (только контакты)
const online = new Set()
let rooms = []
let current = null // открытая комната: { id, live, off }

function start() {
  const me = mb.auth.user
  $('login').hidden = true
  $('app').hidden = false
  $('me').textContent = me.name ?? me.email

  // Вход потерян (сессию отозвали, сервер подняли на другой базе) - SDK уже
  // стёр токены; назад к форме входа, а не молча слать запросы без токена.
  mb.auth.onChange((user) => user || leaving || location.reload())

  mb.on('connection', (state) => {
    const ru = { online: 'в сети', connecting: 'подключение', reconnecting: 'переподключение', offline: 'нет связи' }
    $('conn').textContent = ru[state] ?? state
    $('conn').className = `conn ${state}`
  })

  // Пустой фильтр: правило list само оставит только мои комнаты.
  mb.live('rooms', {}, { sort: { name: 1 } }).subscribe((list) => {
    rooms = list
    renderRooms()
    if (current) renderRoomHeader()
  })

  mb.live('invites', { to: me.id }).subscribe(renderInvites)

  // Профили - только тех, с кем общая комната (правило users).
  mb.live('users', {}).subscribe((list) => {
    names.clear()
    for (const u of list) names.set(u._id, u.name ?? u.email ?? u._id)
    renderOnline()
    if (current) renderMessages()
  })

  // Кто в сети - обычная живая выборка _presence; правило - контакты.
  mb.live('_presence', {}).subscribe((list) => {
    online.clear()
    for (const p of list) online.add(p.userId)
    renderOnline()
    if (current) renderRoomHeader()
  })

  mb.on('typing', ({ from, data }) => {
    if (current && data.roomId === current.id && from !== mb.auth.user.id) showTyping(from)
  })
  mb.on('error', report)

  const last = localStorage.getItem('chat:room')
  if (last) openRoom(last)
}

const nameOf = (id) => names.get(id) ?? 'кто-то'

function renderRooms() {
  $('rooms').replaceChildren(
    ...(rooms.length
      ? rooms.map((r) => h('li', { class: `room ${current?.id === r._id ? 'active' : ''}`, onclick: () => openRoom(r._id) }, r.name))
      : [h('li', { class: 'empty' }, 'пока нет')]),
  )
}

function renderInvites(list) {
  $('invites').replaceChildren(
    ...(list.length
      ? list.map((inv) =>
          h(
            'li',
            {},
            h('span', {}, `${inv.roomName ?? 'комната'} от ${inv.fromName ?? 'кого-то'}`),
            h('button', { class: 'link', onclick: safe(async () => openRoom((await mb.action('acceptInvite', { inviteId: inv._id })).roomId)) }, 'Принять'),
          ),
        )
      : [h('li', { class: 'empty' }, 'нет')]),
  )
}

function renderOnline() {
  const me = mb.auth.user?.id
  const people = [...online].filter((id) => id !== me)
  $('online').replaceChildren(
    ...(people.length ? people.map((id) => h('li', {}, h('span', { class: 'dot' }), nameOf(id))) : [h('li', { class: 'empty' }, 'никого из контактов')]),
  )
}

$('new-room').addEventListener(
  'submit',
  safe(async (e) => {
    e.preventDefault()
    const room = await mb.action('createRoom', { name: e.target.name.value })
    e.target.reset()
    openRoom(room._id)
  }),
)

// ---------- комната ----------

function openRoom(id) {
  if (current) {
    current.live.close()
    current.off()
  }
  localStorage.setItem('chat:room', id)
  // Последние 50 сообщений + новые. sort + limit идут через индекс roomId.
  // parent: комната перестала быть видна (выгнали, удалили) - revoked.
  const live = mb.live('messages', { roomId: id }, { sort: { _id: -1 }, limit: 50, parent: ['rooms', id] })
  current = { id, live, off: () => {}, list: [], typing: new Map() }
  const offRevoked = live.on('revoked', () => {
    closeRoom()
    toast('Вы больше не участник этой комнаты')
  })
  const offList = live.subscribe((list) => {
    current.list = list
    renderMessages()
  })
  current.off = () => {
    offRevoked()
    offList()
  }
  $('no-room').hidden = true
  $('room').hidden = false
  renderRooms()
  renderRoomHeader()
  $('send').text.focus()
}

function closeRoom() {
  if (current) {
    current.live.close()
    current.off()
  }
  current = null
  localStorage.removeItem('chat:room')
  $('room').hidden = true
  $('no-room').hidden = false
  renderRooms()
}

function renderRoomHeader() {
  const room = rooms.find((r) => r._id === current.id)
  if (!room) return
  const mine = room.ownerId === mb.auth.user.id
  $('room-name').textContent = room.name
  $('room-name').title = mine ? 'Нажмите, чтобы переименовать' : ''
  for (const el of document.querySelectorAll('.owner-only')) el.hidden = !mine
  for (const el of document.querySelectorAll('.not-owner')) el.hidden = mine
  $('room-people').replaceChildren(
    ...room.participants.flatMap((id, i) => [
      i ? ', ' : '',
      online.has(id) ? h('span', { class: 'dot', title: 'в сети' }) : '',
      ' ',
      id === mb.auth.user.id ? 'вы' : nameOf(id),
      mine && id !== mb.auth.user.id
        ? h('button', { class: 'kick', title: 'Выгнать', onclick: safe(() => mb.action('kick', { roomId: room._id, userId: id })) }, '×')
        : '',
    ]),
  )
}

$('room-name').addEventListener(
  'click',
  safe(async () => {
    const room = rooms.find((r) => r._id === current?.id)
    if (!room || room.ownerId !== mb.auth.user.id) return
    const name = prompt('Новое имя комнаты', room.name)
    if (name && name !== room.name) await mb.c.rooms.update(room._id, { $set: { name } })
  }),
)

function renderMessages() {
  const box = $('messages')
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60
  const me = mb.auth.user.id
  const items = [...current.list].reverse() // сверху старые
  $('message-list').replaceChildren(
    ...items.map((m) =>
      h(
        'li',
        { class: `msg ${m.authorId === me ? 'mine' : ''}` },
        h(
          'div',
          { class: 'meta' },
          h('b', {}, m.authorId === me ? 'вы' : nameOf(m.authorId)),
          new Date(m._createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }),
          m.editedAt ? '(изм.)' : '',
          m.authorId === me ? h('button', { title: 'Изменить', onclick: safe(() => editMessage(m)) }, '✎') : '',
          m.authorId === me ? h('button', { title: 'Удалить', onclick: safe(() => mb.c.messages.remove(m._id)) }, '✕') : '',
        ),
        h('div', { class: 'text' }, m.text),
      ),
    ),
  )
  if (atBottom) box.scrollTop = box.scrollHeight
}

async function editMessage(m) {
  const text = prompt('Изменить сообщение', m.text)
  if (text && text !== m.text) await mb.c.messages.update(m._id, { $set: { text } })
}

// Прокрутка вверх - ещё 50 старых. Курсор строит SDK.
async function loadMore() {
  if (!current || current.loading) return
  current.loading = true
  const box = $('messages')
  const before = box.scrollHeight
  const n = await current.live.loadMore(50).finally(() => (current && (current.loading = false)))
  box.scrollTop += box.scrollHeight - before // остаться на том же сообщении
  if (!n) $('more').textContent = 'Это всё'
}
$('more').addEventListener('click', safe(loadMore))
$('messages').addEventListener('scroll', () => $('messages').scrollTop < 40 && loadMore().catch(report))

$('send').addEventListener(
  'submit',
  safe(async (e) => {
    e.preventDefault()
    const input = e.target.text
    const text = input.value.trim()
    if (!text || !current) return
    input.value = ''
    // Обычная запись: правило create проверит участие, хук поставит authorId.
    // Сообщение вернётся через live().
    await mb.c.messages.insert({ roomId: current.id, text })
    $('messages').scrollTop = $('messages').scrollHeight
  }),
)

// "печатает..." - не чаще раза в 2 с; сервер сам добавит from
let lastTyping = 0
$('send').text.addEventListener('input', () => {
  if (!current || Date.now() - lastTyping < 2000) return
  lastTyping = Date.now()
  mb.emit('typing', { roomId: current.id })
})

function showTyping(userId) {
  clearTimeout(current.typing.get(userId))
  current.typing.set(
    userId,
    setTimeout(() => {
      current?.typing.delete(userId)
      renderTyping()
    }, 3000),
  )
  renderTyping()
}

function renderTyping() {
  const who = [...(current?.typing.keys() ?? [])].map(nameOf)
  $('typing').textContent = who.length ? `${who.join(', ')} ${who.length > 1 ? 'печатают' : 'печатает'}...` : ''
}

$('invite-form').addEventListener(
  'submit',
  safe(async (e) => {
    e.preventDefault()
    await mb.action('invite', { roomId: current.id, email: e.target.email.value })
    toast('Приглашение отправлено')
    e.target.reset()
  }),
)

$('leave').addEventListener(
  'click',
  safe(async () => {
    if (!confirm('Выйти из комнаты?')) return
    await mb.action('leaveRoom', { roomId: current.id })
    closeRoom()
  }),
)

$('delete-room').addEventListener(
  'click',
  safe(async () => {
    if (!confirm('Удалить комнату со всеми сообщениями?')) return
    await mb.action('deleteRoom', { roomId: current.id })
    closeRoom()
  }),
)

// ---------- запуск ----------

const user = await mb.auth.restore().catch(() => null)
if (user) start()
else $('login').hidden = false

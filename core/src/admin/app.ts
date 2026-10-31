// Админка MaBase в браузере. Без фреймворка: h() строит элементы, текст -
// только через textContent (никакого innerHTML с данными из базы).
// Адреса страниц - в hash: #/c/messages, #/c/messages/schema, #/tail ...
import { parseRelaxed, RelaxedError } from './relaxed'

type Doc = Record<string, any> & { _id: string }
type Source = 'code' | 'admin' | 'data' | 'system'
type Collection = { name: string; count: number; indexes: string[]; schema: boolean; system: boolean; source: Source }
const SOURCE_LABEL: Record<Source, string> = { code: 'из кода', admin: 'создана в админке', data: 'только данные', system: 'служебная' }
type Info = { version: string; uptimeMs: number; memory: { rss: number; heapUsed: number }; db: Record<string, any>; collections: Collection[] }

// ---------- элементы ----------

type Child = Node | string | number | null | undefined | false
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'value') (el as any).value = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'number' ? String(c) : c)
  return el
}
const $ = (id: string) => document.getElementById(id)!
const fmt = new Intl.NumberFormat('ru-RU')
const num = (n: number) => fmt.format(n)
const bytes = (n: number) => (n < 1024 ? `${n} Б` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} КБ` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} МБ` : `${(n / (1 << 30)).toFixed(2)} ГБ`)
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
}
function duration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} мин`
  const hrs = Math.floor(m / 60)
  return hrs < 48 ? `${hrs} ч ${m % 60} мин` : `${Math.floor(hrs / 24)} дн ${hrs % 24} ч`
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
function toast(text: string, error = false): void {
  const t = $('toast')
  t.textContent = text
  t.className = `show${error ? ' error' : ''}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.className = ''), error ? 5000 : 2500)
}

// ---------- API ----------

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

const TOKEN_KEY = 'mabase.admin'
const TOKEN_AT = 'mabase.admin.at'
// Сессия администратора живёт 7 дней на сервере. Токен в localStorage без срока
// переживал закрытие браузера на общей машине - храним и время выдачи.
const TOKEN_TTL_MS = 7 * 24 * 3_600_000
let token: string | null = null
function setToken(t: string | null): void {
  token = t
  try {
    if (t) {
      localStorage.setItem(TOKEN_KEY, t)
      localStorage.setItem(TOKEN_AT, String(Date.now()))
    } else {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(TOKEN_AT)
    }
  } catch {}
}
try {
  token = localStorage.getItem(TOKEN_KEY)
  const at = Number(localStorage.getItem(TOKEN_AT) ?? 0)
  if (token && at && Date.now() - at > TOKEN_TTL_MS) {
    token = null
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(TOKEN_AT)
  }
} catch {}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/_/${path}`, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const data: any = await res.json().catch(() => null)
  if (res.status === 401 && token && path !== 'login') {
    setToken(null)
    location.hash = '#/login'
    throw new ApiError(401, 'unauthorized', 'Сессия закончилась, войдите снова')
  }
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'error', data?.message ?? `Ошибка ${res.status}`, data?.details)
  return data as T
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const d = Array.isArray(err.details) ? err.details.map((x: any) => `${x.path ? x.path + ': ' : ''}${x.message}`).join('\n') : ''
    return d && !err.message.includes(d.split('\n')[0]!) ? `${err.message}\n${d}` : err.message
  }
  if (err instanceof RelaxedError) return err.message
  return err instanceof Error ? err.message : String(err)
}
const fail = (err: unknown) => toast(errorText(err), true)

// ---------- состояние ----------

let me: { id: string; email: string } | null = null
let info: Info | null = null
const root = $('root')

async function refreshInfo(): Promise<void> {
  info = await api<Info>('GET', 'info')
  renderSide()
}

// ---------- маршруты ----------

async function route(): Promise<void> {
  stopLive()
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent)
  const [page, a, b] = parts
  if (page === 'setup') return setupPage(a ?? '')
  if (!token) {
    const { needed } = await api<{ needed: boolean }>('GET', 'setup')
    return needed ? setupMissing() : loginPage()
  }
  if (page === 'login') return loginPage()
  if (!me) {
    try {
      me = await api('GET', 'me')
    } catch {
      return
    }
  }
  if (!document.querySelector('.shell')) shell()
  await refreshInfo().catch(fail)
  const main = document.querySelector('.main') as HTMLElement
  main.replaceChildren()
  main.scrollTop = 0
  document.querySelector('.side')?.classList.remove('open')
  if (page === 'c' && a) return collectionPage(main, a, b ?? 'documents')
  if (page === 'tail') return tailPage(main)
  if (page === 'admins') return adminsPage(main)
  if (page === 'settings') return settingsPage(main, a === 'first')
  return overviewPage(main)
}

window.addEventListener('hashchange', () => void route().catch(fail))

// ---------- первичная настройка и вход ----------

function setupMissing(): void {
  root.replaceChildren(
    h(
      'div',
      { class: 'center' },
      h(
        'div',
        { class: 'card' },
        logo(),
        h('h1', {}, 'Первичная настройка'),
        h('p', {}, 'Администратора ещё нет. Откройте ссылку из консоли сервера - она печатается при запуске:'),
        h('pre', { class: 'code-block' }, 'Админка: создайте первого администратора\n  http://127.0.0.1:8090/_/#/setup/...'),
        h('p', {}, 'Или на машине сервера: mabase superuser upsert <email> <пароль>'),
      ),
    ),
  )
}

function setupPage(setupToken: string): void {
  const err = h('div', { class: 'error-text' })
  const form = h(
    'form',
    { class: 'card' },
    logo(),
    h('h1', {}, 'Первичная настройка'),
    h('p', {}, 'Создайте первого администратора. Он будет входить в админку по email и паролю и сможет добавить других.'),
    h('label', { class: 'field' }, 'Email', h('input', { class: 'input', name: 'email', type: 'email', required: true, autocomplete: 'username' })),
    h('label', { class: 'field' }, 'Пароль (не короче 10 символов)', h('input', { class: 'input', name: 'password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })),
    h('label', { class: 'field' }, 'Пароль ещё раз', h('input', { class: 'input', name: 'repeat', type: 'password', required: true, autocomplete: 'new-password' })),
    err,
    h('button', { class: 'btn primary', type: 'submit' }, 'Создать и войти'),
  )
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = new FormData(form)
    err.textContent = ''
    if (f.get('password') !== f.get('repeat')) return void (err.textContent = 'Пароли не совпадают')
    try {
      const s = await api('POST', 'setup', { token: setupToken, email: f.get('email'), password: f.get('password') })
      setToken(s.token)
      me = s.superuser
      history.replaceState(null, '', '#/settings/first') // токен настройки из адресной строки - убрать
      toast('Администратор создан')
      await route()
    } catch (e2) {
      err.textContent = errorText(e2)
    }
  })
  root.replaceChildren(h('div', { class: 'center' }, form))
}

function loginPage(): void {
  const err = h('div', { class: 'error-text' })
  const form = h(
    'form',
    { class: 'card' },
    logo(),
    h('h1', {}, 'Вход в админку'),
    h('label', { class: 'field' }, 'Email', h('input', { class: 'input', name: 'email', type: 'email', required: true, autocomplete: 'username', autofocus: true })),
    h('label', { class: 'field' }, 'Пароль', h('input', { class: 'input', name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    err,
    h('button', { class: 'btn primary', type: 'submit' }, 'Войти'),
  )
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = new FormData(form)
    err.textContent = ''
    try {
      const s = await api('POST', 'login', { email: f.get('email'), password: f.get('password') })
      setToken(s.token)
      me = s.superuser
      location.hash = '#/'
      await route()
    } catch (e2) {
      err.textContent = errorText(e2)
    }
  })
  root.replaceChildren(h('div', { class: 'center' }, form))
}

const logo = () => h('div', { class: 'logo' }, h('span', { class: 'mark' }, 'M'), 'MaBase')

// ---------- каркас: верхняя полоса и коллекции слева ----------

let sideFilter = ''
let showSystem = false
try {
  showSystem = localStorage.getItem('mabase.admin.system') === '1'
} catch {}

function shell(): void {
  root.replaceChildren(
    h(
      'div',
      { class: 'shell' },
      h(
        'header',
        { class: 'top' },
        h('button', { class: 'btn ghost small menu-btn', onclick: () => document.querySelector('.side')!.classList.toggle('open') }, 'Меню'),
        h('a', { href: '#/', class: 'logo', style: undefined }, h('span', { class: 'mark' }, 'M'), h('span', { class: 'logo-text' }, 'MaBase')),
        h('span', { class: 'host' }, location.host),
        h('span', { class: 'spacer' }),
        h('span', { class: 'host', id: 'me' }, me?.email ?? ''),
        h(
          'button',
          {
            class: 'btn ghost small',
            onclick: async () => {
              await api('POST', 'logout').catch(() => {})
              setToken(null)
              me = null
              location.hash = '#/login'
            },
          },
          'Выйти',
        ),
      ),
      h('div', { class: 'body' }, h('nav', { class: 'side' }), h('main', { class: 'main' })),
    ),
  )
  const logoLink = document.querySelector('.top .logo') as HTMLElement
  logoLink.style.color = 'inherit'
}

function renderSide(): void {
  const side = document.querySelector('.side')
  if (!side || !info) return
  const current = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent)
  const active = current[0] === 'c' ? current[1] : null
  const q = sideFilter.toLowerCase()
  const item = (c: Collection) =>
    h(
      'a',
      { class: `nav-item${c.name === active ? ' active' : ''}`, href: `#/c/${encodeURIComponent(c.name)}`, title: c.name },
      h('span', { class: 'name' }, c.name),
      h('span', { class: 'count' }, num(c.count)),
    )
  const visible = info.collections.filter((c) => c.name.toLowerCase().includes(q))
  const app = visible.filter((c) => !c.system)
  const sys = visible.filter((c) => c.system)
  const search = h('input', { class: 'input search', placeholder: 'Найти коллекцию', value: sideFilter })
  search.addEventListener('input', () => {
    sideFilter = search.value
    renderSide()
    const s = document.querySelector('.side .search') as HTMLInputElement
    s.focus()
    s.setSelectionRange(s.value.length, s.value.length)
  })
  const page = current[0] || ''
  const nodes: (Child | Child[])[] = [
    search,
    h('a', { class: `nav-item${page === '' ? ' active' : ''}`, href: '#/' }, 'Обзор'),
    h('a', { class: `nav-item${page === 'tail' ? ' active' : ''}`, href: '#/tail' }, 'Журнал'),
    h('a', { class: `nav-item${page === 'admins' ? ' active' : ''}`, href: '#/admins' }, 'Администраторы'),
    h('a', { class: `nav-item${page === 'settings' ? ' active' : ''}`, href: '#/settings' }, 'Настройки'),
    h('h3', {}, `Коллекции ${app.length}`, h('button', { title: 'Создать коллекцию', onclick: createCollectionDialog }, '+ создать')),
    app.length ? app.map(item) : h('div', { class: 'faint nav-item' }, q ? 'ничего не найдено' : 'пока нет'),
    h(
      'h3',
      {},
      'Системные',
      h(
        'button',
        {
          onclick: () => {
            showSystem = !showSystem
            try {
              localStorage.setItem('mabase.admin.system', showSystem ? '1' : '0')
            } catch {}
            renderSide()
          },
        },
        showSystem ? 'скрыть' : `показать (${sys.length})`,
      ),
    ),
    (showSystem || !!active?.startsWith('_')) && sys.map(item),
  ]
  side.replaceChildren(...(nodes.flat().filter((n) => n !== null && n !== undefined && n !== false) as (Node | string)[]))
}

// ---------- обзор ----------

async function overviewPage(main: HTMLElement): Promise<void> {
  const i = info!
  const docs = i.collections.reduce((s, c) => s + c.count, 0)
  const backupDir = h('input', { class: 'input mono', placeholder: '/абсолютный/путь/к/папке/бэкапа' })
  main.append(
    h(
      'div',
      { class: 'page' },
      h('div', { class: 'page-head' }, h('h1', {}, 'Обзор'), h('span', { class: 'badge green' }, `MaBase ${i.version}`)),
      h(
        'div',
        { class: 'stats' },
        stat('Документов', num(docs)),
        stat('Коллекций', num(i.collections.filter((c) => !c.system).length)),
        stat('Последняя транзакция', num(i.db.lastTx)),
        stat('Работает', duration(i.uptimeMs)),
        stat('Память процесса', bytes(i.memory.rss)),
        stat('Журнал / снапшот', `${bytes(i.db.logSize)} / ${bytes(i.db.snapshotSize)}`),
        stat('Папка базы', i.db.dir, true),
      ),
      h('div', { class: 'section' }, 'Обслуживание'),
      h(
        'div',
        { class: 'row-actions' },
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              try {
                const r = await api('POST', 'compact')
                toast(`Компактирование готово: снапшот ${bytes(r.snapshotSize)}`)
                route()
              } catch (e) {
                fail(e)
              }
            },
          },
          'Компактировать журнал',
        ),
      ),
      h(
        'div',
        { class: 'qrow' },
        h('div', { class: 'grow' }, backupDir),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              try {
                const r = await api('POST', 'backup', { dir: backupDir.value.trim() })
                toast(`Бэкап на tx ${r.tx}: ${bytes(r.bytes)}`)
              } catch (e) {
                fail(e)
              }
            },
          },
          'Сделать бэкап',
        ),
      ),
      h('div', { class: 'section' }, 'Коллекции'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'grid' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Коллекция'), h('th', {}, 'Документов'), h('th', {}, 'Индексы'), h('th', {}, 'Схема'))),
          h(
            'tbody',
            {},
            i.collections
              .filter((c) => !c.system || showSystem)
              .map((c) =>
                h(
                  'tr',
                  { class: 'click', onclick: () => (location.hash = `#/c/${encodeURIComponent(c.name)}`) },
                  h('td', {}, h('b', {}, c.name), c.system && h('span', { class: 'badge' }, ' системная')),
                  h('td', {}, num(c.count)),
                  h('td', { class: 'cell' }, c.indexes.length ? c.indexes.join(', ') : h('span', { class: 'faint' }, 'только _id')),
                  h('td', {}, c.schema ? h('span', { class: 'badge green' }, 'zod') : h('span', { class: 'faint' }, 'нет')),
                ),
              ),
          ),
        ),
      ),
    ),
  )
}

const stat = (label: string, value: string, small = false) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: `value${small ? ' small' : ''}` }, value))

// ---------- коллекция ----------

const TABS: [string, string][] = [
  ['documents', 'Документы'],
  ['schema', 'Схема'],
  ['indexes', 'Индексы'],
  ['relations', 'Связи'],
  ['rules', 'Правила'],
]

async function collectionPage(main: HTMLElement, name: string, tab: string): Promise<void> {
  const c = info?.collections.find((x) => x.name === name)
  const page = h('div', { class: 'page' })
  const enc = encodeURIComponent(name)
  page.append(
    h(
      'div',
      { class: 'page-head' },
      h('h1', {}, name),
      h('span', { class: 'muted' }, c ? `${num(c.count)} ${plural(c.count, 'документ', 'документа', 'документов')}` : 'пустая'),
      c?.system ? h('span', { class: 'badge warn' }, 'служебная: правьте осторожно') : c && h('span', { class: `badge${c.source === 'admin' ? ' green' : ''}` }, SOURCE_LABEL[c.source]),
      h('span', { class: 'spacer' }),
      c && (c.source === 'admin' || c.source === 'data') && h('button', { class: 'btn small danger', onclick: () => dropCollectionDialog(name, c.count) }, 'Удалить коллекцию'),
    ),
    h('nav', { class: 'tabs' }, TABS.map(([id, label]) => h('a', { href: `#/c/${enc}/${id === 'documents' ? '' : id}`, class: id === tab ? 'active' : '' }, label))),
  )
  main.append(page)
  if (tab === 'schema') return schemaTab(page, name)
  if (tab === 'indexes') return indexesTab(page, name)
  if (tab === 'rules') return rulesTab(page, name)
  if (tab === 'relations') return relationsTab(page, name)
  return documentsTab(page, name)
}

// ---------- документы ----------

type View = 'list' | 'json' | 'table'
type Query = { filter: string; sort: string; fields: string; skip: number; limit: number }
const queries = new Map<string, Query>() // запрос на коллекцию - живёт, пока открыта вкладка
let view: View = 'list'
try {
  view = (localStorage.getItem('mabase.admin.view') as View) || 'list'
} catch {}

function parseObj(text: string, what: string): Record<string, unknown> | undefined {
  const t = text.trim()
  if (!t) return undefined
  let v: unknown
  try {
    v = parseRelaxed(t)
  } catch (e) {
    throw new Error(`${what}: ${errorText(e)}`)
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what}: нужен объект { ... }`)
  return v as Record<string, unknown>
}

async function documentsTab(page: HTMLElement, name: string): Promise<void> {
  const q: Query = queries.get(name) ?? { filter: '', sort: '', fields: '', skip: 0, limit: 20 }
  queries.set(name, q)
  const filterIn = h('input', { class: 'input mono', placeholder: "{ поле: 'значение' }   пример: { n: { $gt: 5 }, text: /привет/i }", value: q.filter, spellcheck: 'false' })
  const sortIn = h('input', { class: 'input mono', placeholder: '{ _id: -1 } - сначала новые', value: q.sort, spellcheck: 'false' })
  const fieldsIn = h('input', { class: 'input mono', placeholder: '{ text: 1 }', value: q.fields, spellcheck: 'false' })
  const skipIn = h('input', { class: 'input mono', type: 'number', min: 0, value: String(q.skip) })
  const limitIn = h('input', { class: 'input mono', type: 'number', min: 1, max: 1000, value: String(q.limit) })
  const opts = h('div', { class: 'qopts' }, h('label', {}, 'Сортировка', sortIn), h('label', {}, 'Поля', fieldsIn), h('label', {}, 'Пропустить', skipIn), h('label', {}, 'Лимит', limitIn))
  opts.hidden = !(q.sort || q.fields || q.skip)
  const optsBtn = h('button', { class: `btn ghost${opts.hidden ? '' : ' on'}`, type: 'button' }, 'Опции')
  optsBtn.addEventListener('click', () => {
    opts.hidden = !opts.hidden
    optsBtn.classList.toggle('on', !opts.hidden)
  })
  const form = h(
    'form',
    { class: 'querybar' },
    h(
      'div',
      { class: 'qrow' },
      h('span', { class: 'lbl' }, 'Фильтр'),
      h('div', { class: 'grow' }, filterIn),
      optsBtn,
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            Object.assign(q, { filter: '', sort: '', fields: '', skip: 0, limit: 20 })
            filterIn.value = sortIn.value = fieldsIn.value = ''
            skipIn.value = '0'
            limitIn.value = '20'
            load()
          },
        },
        'Сброс',
      ),
      h('button', { class: 'btn primary', type: 'submit' }, 'Найти'),
    ),
    opts,
  )
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    q.skip = 0
    skipIn.value = '0'
    load()
  })

  const pager = h('span', { class: 'pager' })
  const prev = h('button', { class: 'btn small', title: 'Назад' }, '<')
  const next = h('button', { class: 'btn small', title: 'Дальше' }, '>')
  prev.addEventListener('click', () => {
    q.skip = Math.max(0, q.skip - q.limit)
    skipIn.value = String(q.skip)
    load()
  })
  next.addEventListener('click', () => {
    q.skip += q.limit
    skipIn.value = String(q.skip)
    load()
  })
  const viewSeg = h(
    'span',
    { class: 'seg' },
    (
      [
        ['list', 'Список'],
        ['json', 'JSON'],
        ['table', 'Таблица'],
      ] as [View, string][]
    ).map(([v, label]) =>
      h(
        'button',
        {
          class: v === view ? 'on' : '',
          onclick: (e: Event) => {
            view = v
            try {
              localStorage.setItem('mabase.admin.view', v)
            } catch {}
            for (const b of viewSeg.children) b.classList.toggle('on', b === e.currentTarget)
            render()
          },
        },
        label,
      ),
    ),
  )
  const liveBtn = h('button', { class: 'btn', title: 'Перечитывать, когда в коллекции что-то меняется' }, 'Живой режим')
  liveBtn.addEventListener('click', () => {
    if (live) stopLive()
    else startLive((ops) => ops[name] && load(true))
    liveBtn.classList.toggle('on', !!live)
  })
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('button', { class: 'btn primary', onclick: () => insertDialog(name, null, load) }, '+ Добавить'),
    h('button', { class: 'btn danger', onclick: () => deleteManyDialog(name, q, load) }, 'Удалить по фильтру'),
    h('span', { class: 'spacer' }),
    liveBtn,
    h('button', { class: 'btn', title: 'Обновить', onclick: () => load() }, 'Обновить'),
    viewSeg,
    pager,
    prev,
    next,
  )
  const explain = h('div', { class: 'explain' })
  const list = h('div', {})
  page.append(form, toolbar, explain, list)

  let items: Doc[] = []
  let seq = 0
  // Связи коллекции: поля показываются ссылками с подписью связанного документа
  const meta = await api('GET', `c/${encodeURIComponent(name)}/meta`).catch(() => null)
  const rels: Record<string, Rel> = meta?.relations ?? {}

  async function load(quiet = false): Promise<void> {
    const my = ++seq
    try {
      q.filter = filterIn.value
      q.sort = sortIn.value
      q.fields = fieldsIn.value
      q.skip = Math.max(0, Number(skipIn.value) || 0)
      q.limit = Math.min(1000, Math.max(1, Number(limitIn.value) || 20))
      const filter = parseObj(q.filter, 'Фильтр')
      const sort = parseObj(q.sort, 'Сортировка') ?? { _id: -1 } // по умолчанию - сначала новые
      const fields = parseObj(q.fields, 'Поля')
      filterIn.classList.remove('error')
      const p = new URLSearchParams({ skip: String(q.skip), limit: String(q.limit) })
      if (filter) p.set('filter', JSON.stringify(filter))
      if (sort) p.set('sort', JSON.stringify(sort))
      if (fields) p.set('fields', JSON.stringify(fields))
      if (Object.keys(rels).length) p.set('expand', Object.keys(rels).join(','))
      const r = await api('GET', `c/${encodeURIComponent(name)}?${p}`)
      if (my !== seq) return
      expanded.clear()
      items = r.items.map((d: any) => {
        const { _expand, ...doc } = d
        if (_expand) expanded.set(doc._id, _expand)
        return doc
      })
      relCtx = rels
      const from = r.total ? q.skip + 1 : 0
      const to = q.skip + r.items.length
      pager.textContent = `${num(from)}-${num(to)} из ${num(r.total)}`
      prev.disabled = q.skip === 0
      next.disabled = to >= r.total
      const e = r.explain
      explain.replaceChildren(
        'план: ',
        h('b', {}, e.plan),
        ` · просмотрено ${num(e.scanned)}`,
        e.sortedInMemory ? h('span', { class: e.scanned > 10000 ? 'slow' : '' }, ' · сортировка в памяти') : '',
        ` · ${r.ms} мс`,
      )
      render()
    } catch (e) {
      if (my !== seq) return
      if (!quiet) fail(e)
      if (e instanceof Error && /^Фильтр/.test(e.message)) filterIn.classList.add('error')
    }
  }

  function render(): void {
    if (!items.length) {
      list.replaceChildren(h('div', { class: 'empty' }, q.filter.trim() ? 'По фильтру ничего не найдено' : 'В коллекции нет документов'))
      return
    }
    if (view === 'table') return void list.replaceChildren(table(name, items, load))
    list.replaceChildren(h('div', { class: 'docs' }, items.map((d) => docCard(name, d, load))))
  }

  await load()
}

// _id первым, служебные времена последними - как читают глазами.
function ordered(d: Doc): Doc {
  const { _id, _createdAt, _updatedAt, ...rest } = d
  const out: any = _id === undefined ? {} : { _id }
  Object.assign(out, rest)
  if (_createdAt !== undefined) out._createdAt = _createdAt
  if (_updatedAt !== undefined) out._updatedAt = _updatedAt
  return out
}

// Документ карточкой: верхний уровень раскрыт, вложенное - по клику.
function docCard(c: string, d: Doc, reload: () => void): HTMLElement {
  d = ordered(d)
  const card = h('div', { class: 'doc', tabindex: 0 })
  const show = () => {
    card.className = 'doc'
    card.replaceChildren(
      view === 'json' ? h('pre', {}, JSON.stringify(d, null, 2)) : tree(d, 0, d._id),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn ghost small', onclick: edit, title: 'Изменить документ' }, 'Изменить'),
        h(
          'button',
          {
            class: 'btn ghost small',
            title: 'Скопировать JSON',
            onclick: () => navigator.clipboard.writeText(JSON.stringify(d, null, 2)).then(() => toast('JSON скопирован'), fail),
          },
          'Копировать',
        ),
        h('button', { class: 'btn ghost small', title: 'Новый документ с теми же полями', onclick: () => insertDialog(c, d, reload) }, 'Клон'),
        h('button', { class: 'btn ghost small', title: 'Кто ссылается на этот документ', onclick: () => backlinksDialog(c, d._id) }, 'Ссылки'),
        h('button', { class: 'btn ghost small danger', onclick: confirmDelete, title: 'Удалить документ' }, 'Удалить'),
      ),
    )
  }
  const edit = () => {
    const ta = h('textarea', { class: 'code', spellcheck: 'false' }, JSON.stringify(d, null, 2))
    ta.style.minHeight = `${Math.min(520, 60 + JSON.stringify(d, null, 2).split('\n').length * 20)}px`
    const err = h('div', { class: 'error-text' })
    card.replaceChildren(
      ta,
      h(
        'div',
        { class: 'edit-bar' },
        err,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: show }, 'Отмена'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              try {
                const next = parseRelaxed(ta.value)
                d = ordered(await api('PUT', `c/${encodeURIComponent(c)}/${encodeURIComponent(d._id)}`, next))
                toast('Сохранено')
                show()
              } catch (e) {
                err.textContent = errorText(e)
              }
            },
          },
          'Сохранить',
        ),
      ),
    )
    ta.focus()
  }
  const confirmDelete = () => {
    show()
    card.classList.add('confirm')
    card.append(
      h(
        'div',
        { class: 'confirm-bar' },
        h('span', {}, 'Удалить этот документ? Хуки коллекции сработают.'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: show }, 'Отмена'),
        h(
          'button',
          {
            class: 'btn small danger solid',
            onclick: async () => {
              try {
                await api('DELETE', `c/${encodeURIComponent(c)}/${encodeURIComponent(d._id)}`)
                toast('Удалено')
                reload()
                refreshInfo().catch(() => {})
              } catch (e) {
                fail(e)
              }
            },
          },
          'Удалить',
        ),
      ),
    )
  }
  show()
  return card
}

type Rel = { to: string; many: boolean; onDelete: string }
let relCtx: Record<string, Rel> = {} // связи открытой коллекции
const expanded = new Map<string, Record<string, any>>() // _id -> _expand
const labelOf = (d: any) => (d ? String(d.name ?? d.title ?? d.email ?? d.phone ?? d._id) : 'нет такого документа')

// Открыть коллекцию с готовым фильтром.
function openFiltered(c: string, filter: string): void {
  queries.set(c, { filter, sort: '', fields: '', skip: 0, limit: 20 })
  location.hash = `#/c/${encodeURIComponent(c)}`
}

function refLink(to: string, id: string, target: any): HTMLElement {
  return h(
    'span',
    {},
    h('a', { href: `#/c/${encodeURIComponent(to)}`, class: 'v-string', title: `Открыть ${to}/${id}`, onclick: (e: Event) => (e.preventDefault(), openFiltered(to, `{ _id: '${id}' }`)) }, JSON.stringify(id)),
    h('span', { class: `hint${target ? '' : ' v-null'}` }, `-> ${labelOf(target)}`),
  )
}

function tree(v: Record<string, any> | any[], depth: number, ownerId?: string): HTMLElement {
  const box = h('div', { class: depth ? 'nested' : '' })
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v)
  const ex = depth === 0 && ownerId ? expanded.get(ownerId) : undefined
  for (const [k, x] of entries) {
    const row = h('div', { class: 'kv' }, h('span', { class: 'k' }, k))
    const rel = depth === 0 ? relCtx[k] : undefined
    if (rel && !rel.many && typeof x === 'string') {
      row.append(refLink(rel.to, x, ex?.[k]))
      box.append(row)
      continue
    }
    if (rel && rel.many && Array.isArray(x)) {
      const byId = new Map(((ex?.[k] ?? []) as any[]).map((d) => [d._id, d]))
      row.append(h('span', { class: 'kind' }, `-> ${rel.to} (${x.length})`))
      box.append(row, h('div', { class: 'nested' }, x.map((id) => h('div', { class: 'kv' }, typeof id === 'string' ? refLink(rel.to, id, byId.get(id)) : scalar(id)))))
      continue
    }
    if (x && typeof x === 'object') {
      const n = Array.isArray(x) ? x.length : Object.keys(x).length
      const label = h('span', { class: 'kind' }, Array.isArray(x) ? `Array (${n})` : `Object (${n})`)
      const toggle = h('button', { class: 'toggle', 'aria-expanded': 'false' }, '+')
      row.prepend(toggle)
      row.append(label)
      let child: HTMLElement | null = null
      toggle.addEventListener('click', () => {
        if (child) {
          child.remove()
          child = null
          toggle.textContent = '+'
        } else {
          child = tree(x, depth + 1)
          row.after(child)
          toggle.textContent = '-'
        }
        toggle.setAttribute('aria-expanded', String(!!child))
      })
      box.append(row)
    } else {
      row.append(scalar(x))
      const hint = dateHint(k, x)
      if (hint) row.append(h('span', { class: 'hint' }, hint))
      row.title = typeof x === 'string' ? x : ''
      box.append(row)
    }
  }
  if (!entries.length) box.append(h('div', { class: 'kv kind' }, Array.isArray(v) ? '[]' : '{}'))
  return box
}

function scalar(x: unknown): HTMLElement {
  if (x === null) return h('span', { class: 'v-null' }, 'null')
  if (typeof x === 'string') return h('span', { class: 'v-string' }, JSON.stringify(x))
  return h('span', { class: `v-${typeof x}` }, String(x))
}

// Время храним числом (мс): подсказать дату, если похоже на неё.
function dateHint(key: string, v: unknown): string | null {
  if (typeof v !== 'number' || !/(At|_at|Date|time|ts)$/i.test(key)) return null
  if (v < 946684800000 || v > 4102444800000) return null // 2000-2100
  return new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' })
}

function table(c: string, docs: Doc[], reload: () => void): HTMLElement {
  const cols: string[] = []
  for (const d of docs) for (const k of Object.keys(ordered(d))) if (!cols.includes(k)) cols.push(k)
  const shown = cols.slice(0, 14)
  const cell = (v: unknown) => {
    const text = v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)
    return h('td', { class: `cell${v === null ? ' v-null' : typeof v === 'number' ? ' v-number' : ''}`, title: text.slice(0, 2000) }, text)
  }
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'grid' },
      h('thead', {}, h('tr', {}, shown.map((k) => h('th', {}, k)))),
      h(
        'tbody',
        {},
        docs.map((d) =>
          h(
            'tr',
            { class: 'click', title: 'Открыть для правки', onclick: () => editDialog(c, d, reload) },
            shown.map((k) => {
              const rel = relCtx[k]
              const ex = expanded.get(d._id)?.[k]
              if (rel && ex !== undefined) return cell(rel.many ? (ex as any[]).map(labelOf).join(', ') : labelOf(ex))
              return cell(d[k])
            }),
          ),
        ),
      ),
    ),
    cols.length > shown.length ? h('div', { class: 'faint' }, `Ещё полей: ${cols.length - shown.length} - смотрите в списке или JSON`) : null,
  )
}

// ---------- диалоги ----------

function dialog(title: string, body: HTMLElement[], buttons: HTMLElement[]): { close: () => void } {
  const overlay = h('div', { class: 'overlay' }, h('div', { class: 'dialog', role: 'dialog', 'aria-label': title }, h('h2', {}, title), ...body, h('div', { class: 'buttons' }, ...buttons)))
  const close = () => {
    overlay.remove()
    document.removeEventListener('keydown', esc)
  }
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && close()
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close())
  document.addEventListener('keydown', esc)
  document.body.append(overlay)
  return { close }
}

function insertDialog(c: string, from: Doc | null, reload: () => void): void {
  let start = '{\n  \n}'
  if (from) {
    const { _id, _createdAt, _updatedAt, ...rest } = from
    start = JSON.stringify(rest, null, 2)
  }
  const ta = h('textarea', { class: 'code', spellcheck: 'false' }, start)
  const err = h('div', { class: 'error-text' })
  const d = dialog(
    `Добавить в ${c}`,
    [h('p', { class: 'muted' }, 'Один документ { ... } или массив [ {...}, {...} ]. _id можно не указывать - сервер выдаст ULID.'), ta, err],
    [
      h('button', { class: 'btn', onclick: () => d.close() }, 'Отмена'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            try {
              const v = parseRelaxed(ta.value)
              const docs = Array.isArray(v) ? v : [v]
              for (const doc of docs) await api('POST', `c/${encodeURIComponent(c)}`, doc)
              d.close()
              toast(docs.length > 1 ? `Добавлено документов: ${docs.length}` : 'Документ добавлен')
              reload()
              refreshInfo().catch(() => {})
            } catch (e) {
              err.textContent = errorText(e)
            }
          },
        },
        'Добавить',
      ),
    ],
  )
  ta.focus()
}

function editDialog(c: string, doc: Doc, reload: () => void): void {
  const ta = h('textarea', { class: 'code', spellcheck: 'false' }, JSON.stringify(doc, null, 2))
  ta.style.minHeight = '360px'
  const err = h('div', { class: 'error-text' })
  const d = dialog(
    `${c} / ${doc._id}`,
    [ta, err],
    [
      h('button', { class: 'btn', onclick: () => d.close() }, 'Отмена'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            try {
              await api('PUT', `c/${encodeURIComponent(c)}/${encodeURIComponent(doc._id)}`, parseRelaxed(ta.value))
              d.close()
              toast('Сохранено')
              reload()
            } catch (e) {
              err.textContent = errorText(e)
            }
          },
        },
        'Сохранить',
      ),
    ],
  )
}

function deleteManyDialog(c: string, q: Query, reload: () => void): void {
  let filter: Record<string, unknown>
  try {
    filter = parseObj(q.filter, 'Фильтр') ?? {}
  } catch (e) {
    return fail(e)
  }
  const all = !Object.keys(filter).length
  const err = h('div', { class: 'error-text' })
  const confirmIn = h('input', { class: 'input mono', placeholder: c })
  const d = dialog(
    all ? `Удалить ВСЕ документы из ${c}?` : `Удалить документы из ${c} по фильтру?`,
    [
      h('pre', { class: 'code-block' }, JSON.stringify(filter, null, 2)),
      h('p', { class: 'muted' }, 'Одна транзакция, хуки коллекции сработают. Отменить нельзя - сначала сделайте бэкап, если сомневаетесь.'),
      h('label', { class: 'field' }, `Для подтверждения введите имя коллекции: ${c}`, confirmIn),
      err,
    ],
    [
      h('button', { class: 'btn', onclick: () => d.close() }, 'Отмена'),
      h(
        'button',
        {
          class: 'btn danger solid',
          onclick: async () => {
            if (confirmIn.value.trim() !== c) return void (err.textContent = 'Имя коллекции не совпало')
            try {
              const r = await api('POST', `c/${encodeURIComponent(c)}/delete-many`, { filter })
              d.close()
              toast(`Удалено: ${num(r.deleted)}`)
              reload()
              refreshInfo().catch(() => {})
            } catch (e) {
              err.textContent = errorText(e)
            }
          },
        },
        'Удалить',
      ),
    ],
  )
  confirmIn.focus()
}

// ---------- схема по данным ----------

const TYPE_NAMES: Record<string, string> = { string: 'строка', int: 'целое', double: 'дробное', boolean: 'да/нет', null: 'null', object: 'объект', array: 'массив' }

async function schemaTab(page: HTMLElement, name: string): Promise<void> {
  const box = h('div', {}, h('div', { class: 'muted' }, 'Смотрю документы...'))
  page.append(box)
  const r = await api('GET', `c/${encodeURIComponent(name)}/schema?sample=1000`).catch((e) => (fail(e), null))
  if (!r) return
  if (!r.sampled) return void box.replaceChildren(h('div', { class: 'empty' }, 'В коллекции нет документов - смотреть не на что'))
  box.replaceChildren(
    h(
      'p',
      { class: 'muted' },
      r.sampled < r.total ? `По последним ${num(r.sampled)} из ${num(r.total)} документов.` : `По всем ${num(r.total)} документам.`,
      ' Это то, что реально лежит в базе. Объявленная схема zod - на вкладке "Правила".',
    ),
    h(
      'div',
      { class: 'fields' },
      r.fields.map((f: any) => {
        const total = Object.values(f.types as Record<string, number>).reduce((s, n) => s + n, 0)
        const parent = f.path.includes('[]') || f.path.includes('.') ? null : r.sampled
        const pct = parent ? Math.round((f.count / parent) * 100) : null
        const bar = h('div', { class: 'typebar' })
        const legend = h('div', { class: 'legend' })
        for (const [t, n] of Object.entries(f.types as Record<string, number>).sort((a, b) => b[1] - a[1])) {
          const seg = h('span', { class: `t-${t}`, title: `${TYPE_NAMES[t] ?? t}: ${n}` })
          seg.style.width = `${(n / total) * 100}%`
          bar.append(seg)
          legend.append(h('span', {}, h('i', { class: `t-${t}` }), `${TYPE_NAMES[t] ?? t} ${Math.round((n / total) * 100)}%`))
        }
        return h(
          'div',
          { class: 'field-row' },
          h(
            'div',
            {},
            h('div', { class: 'path' }, f.path),
            h('div', { class: 'presence' }, pct === null ? `встречается ${num(f.count)} раз` : pct === 100 ? 'есть везде' : `есть в ${pct}% документов`),
          ),
          h(
            'div',
            {},
            bar,
            legend,
            f.min !== undefined && h('div', { class: 'faint' }, `от ${f.min} до ${f.max}`),
            f.examples.length > 0 && h('div', { class: 'chips' }, f.examples.map((x: unknown) => h('span', { class: 'chip', title: JSON.stringify(x) }, JSON.stringify(x)))),
          ),
        )
      }),
    ),
  )
}

// ---------- индексы ----------

async function indexesTab(page: HTMLElement, name: string): Promise<void> {
  const m = await api('GET', `c/${encodeURIComponent(name)}/meta`).catch((e) => (fail(e), null))
  if (!m) return
  page.append(
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Поле'), h('th', {}, 'Что умеет'))),
        h(
          'tbody',
          {},
          h('tr', {}, h('td', { class: 'cell' }, '_id'), h('td', {}, 'встроенный: порядок создания (ULID), курсор { _id: { $lt: ... } }')),
          m.indexes.map((f: string) => h('tr', {}, h('td', { class: 'cell' }, f), h('td', {}, 'равенство и $in, диапазон, сортировка по полю и по _id внутри значения'))),
        ),
      ),
    ),
    m.source === 'admin' ? indexEditor(name, m.indexes) : h(
      'p',
      { class: 'muted' },
      m.source === 'code'
        ? ['Коллекция объявлена в коде - индексы задаются там же, в mabase.config.ts: ', h('code', {}, `indexes: ['поле']`), '.']
        : m.source === 'data'
          ? 'Описания у коллекции нет - документы пишет код. Чтобы задать индексы здесь, создайте коллекцию с этим же именем ("+ создать" слева): документы останутся.'
          : 'Служебная коллекция: индексы задаёт MaBase.',
      ' Как идёт запрос - строка "план" над документами.',
    ),
  )
}

function indexEditor(name: string, current: string[]): HTMLElement {
  const input = h('input', { class: 'input mono', placeholder: 'поле, например userId или profile.city' })
  const save = async (indexes: string[]) => {
    try {
      await api('PUT', `collections/${encodeURIComponent(name)}`, { indexes })
      toast('Индексы обновлены')
      route()
    } catch (e) {
      fail(e)
    }
  }
  return h(
    'div',
    {},
    h('div', { class: 'section' }, 'Изменить'),
    current.length > 0 && h('div', { class: 'chips' }, current.map((f) => h('span', { class: 'chip' }, f, ' ', h('button', { class: 'btn ghost small danger', title: 'Убрать индекс', onclick: () => save(current.filter((x) => x !== f)) }, 'x')))),
    h(
      'form',
      {
        class: 'qrow',
        onsubmit: (e: Event) => {
          e.preventDefault()
          const f = input.value.trim()
          if (f) save([...current, f])
        },
      },
      h('div', { class: 'grow' }, input),
      h('button', { class: 'btn primary', type: 'submit' }, 'Добавить индекс'),
    ),
    h('p', { class: 'muted' }, 'Индекс строится сразу в памяти; на больших коллекциях это может занять секунды.'),
  )
}

// ---------- правила и схема из конфига ----------

const RULE_HELP: Record<string, string> = {
  list: 'какие записи видны в списках и подписках - возвращает фильтр',
  view: 'какая запись видна по id - возвращает фильтр',
  create: 'можно ли создать',
  update: 'можно ли изменить',
  delete: 'можно ли удалить',
}

async function rulesTab(page: HTMLElement, name: string): Promise<void> {
  const m = await api('GET', `c/${encodeURIComponent(name)}/meta`).catch((e) => (fail(e), null))
  if (!m) return
  page.append(h('p', { class: 'muted' }, 'Правила для клиентов (SDK и HTTP API). Админка, хуки и действия идут мимо них. Меняются в mabase.config.ts.'))
  if (m.source !== 'code' && m.source !== 'system') {
    const idx = m.indexes.length ? `\n  indexes: [${m.indexes.map((x: string) => `'${x}'`).join(', ')}],` : ''
    page.append(
      h('div', { class: 'empty' }, 'Клиентам коллекция закрыта: правил нет. Открыть - добавьте в mabase.config.ts и перезапустите сервер:'),
      h(
        'pre',
        { class: 'code-block' },
        `const ${name.replace(/\W/g, '_')} = defineCollection('${name}', {${idx}\n  rules: {\n    list: (user) => (user ? true : false), // что видно: фильтр или true\n    create: (user) => !!user,\n  },\n})\n\nexport default defineConfig({ collections: [/* ... */, ${name.replace(/\W/g, '_')}] })`,
      ),
    )
    return
  }
  page.append(h('div', { class: 'section' }, 'Правила доступа'))
  for (const [k, help] of Object.entries(RULE_HELP)) {
    const src: string | null = m.rules[k]
    page.append(
      h(
        'div',
        { class: 'rule' },
        h(
          'div',
          { class: 'rule-head' },
          h('b', {}, k),
          h('span', { class: 'muted' }, help),
          h('span', { class: 'spacer' }),
          src === null || src === 'false' ? h('span', { class: 'badge' }, 'запрещено') : h('span', { class: 'badge green' }, 'есть правило'),
        ),
        src && src !== 'false' ? h('pre', {}, src) : null,
      ),
    )
  }
  if (m.dependsOn.length) page.append(h('div', { class: 'section' }, 'dependsOn'), h('div', { class: 'chips' }, m.dependsOn.map((d: string) => h('span', { class: 'chip' }, d))))
  const kinds: [string, string][] = [
    ['readonly', 'клиент не пишет'],
    ['immutable', 'задаётся при создании'],
    ['private', 'видит только владелец'],
    ['hidden', 'не уходит наружу никогда (и в админку тоже)'],
  ]
  page.append(
    h('div', { class: 'section' }, 'Виды полей'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'grid' },
        h(
          'tbody',
          {},
          m.owner && h('tr', {}, h('td', {}, h('b', {}, 'owner')), h('td', { class: 'cell' }, m.owner)),
          kinds.map(([k, help]) =>
            h('tr', {}, h('td', {}, h('b', {}, k), h('div', { class: 'faint' }, help)), h('td', { class: 'cell' }, m.fields[k].length ? m.fields[k].join(', ') : h('span', { class: 'faint' }, '-'))),
          ),
        ),
      ),
    ),
    h('div', { class: 'section' }, 'Схема zod'),
    m.schema ? h('pre', { class: 'code-block' }, JSON.stringify(m.schema, null, 2)) : h('p', { class: 'muted' }, 'Схемы нет: документы не проверяются при записи.'),
  )
}

// ---------- журнал ----------

type Entry = { ts: number; kind: string; [k: string]: unknown }
let live: { stop: () => void } | null = null
function stopLive(): void {
  live?.stop()
  live = null
}

// Один поток журнала: страница журнала и живой режим документов.
function startLive(onCommit: ((ops: Record<string, number>) => void) | null, onEntry?: (e: Entry) => void): void {
  stopLive()
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  live = { stop: () => ctrl.abort() }
  ;(async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetch('/api/_/tail', { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
        if (!res.ok || !res.body) throw new Error(`журнал: ${res.status}`)
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            if (!line) continue
            const e = JSON.parse(line) as Entry
            onEntry?.(e)
            if (onCommit && e.kind === 'commit' && e.ops) {
              clearTimeout(timer)
              const ops = e.ops as Record<string, number>
              timer = setTimeout(() => onCommit(ops), 150)
            }
          }
        }
      } catch {
        if (ctrl.signal.aborted) return
      }
      await new Promise((r) => setTimeout(r, 1500)) // сервер перезапустился - переподключиться
    }
  })()
}

function tailPage(main: HTMLElement): void {
  const log = h('div', { class: 'log' })
  let paused = false
  const hiddenKinds = new Set<string>()
  const kinds = ['commit', 'action', 'event', 'task', 'mail', 'ws', 'admin', 'warning', 'error']
  const pauseBtn = h('button', { class: 'btn' }, 'Пауза')
  pauseBtn.addEventListener('click', () => {
    paused = !paused
    pauseBtn.textContent = paused ? 'Продолжить' : 'Пауза'
    pauseBtn.classList.toggle('on', paused)
  })
  main.append(
    h(
      'div',
      { class: 'page' },
      h('div', { class: 'page-head' }, h('h1', {}, 'Журнал'), h('span', { class: 'muted' }, 'то же, что mabase tail: транзакции, действия, события, письма, ошибки')),
      h(
        'div',
        { class: 'toolbar' },
        h(
          'span',
          { class: 'seg' },
          kinds.map((k) =>
            h(
              'button',
              {
                class: 'on',
                onclick: (e: Event) => {
                  const b = e.currentTarget as HTMLElement
                  if (hiddenKinds.has(k)) hiddenKinds.delete(k)
                  else hiddenKinds.add(k)
                  b.classList.toggle('on', !hiddenKinds.has(k))
                },
              },
              k,
            ),
          ),
        ),
        h('span', { class: 'spacer' }),
        pauseBtn,
        h('button', { class: 'btn', onclick: () => log.replaceChildren() }, 'Очистить'),
      ),
      log,
    ),
  )
  startLive(null, (e) => {
    if (paused || hiddenKinds.has(e.kind)) return
    const { ts, kind, ...rest } = e
    const parts = Object.entries(rest)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    const line = h(
      'div',
      { class: 'line' },
      h('span', { class: 'time' }, new Date(ts).toLocaleTimeString('ru-RU', { hour12: false }) + '.' + String(ts % 1000).padStart(3, '0')),
      h('span', { class: `kind k-${kind}` }, kind),
      h('span', { class: 'rest' }, parts.join('  ')),
    )
    log.prepend(line)
    while (log.childElementCount > 500) log.lastElementChild!.remove()
  })
}

// ---------- администраторы ----------

async function adminsPage(main: HTMLElement): Promise<void> {
  const list = await api('GET', 'superusers').catch((e) => (fail(e), []))
  const err = h('div', { class: 'error-text' })
  const form = h(
    'form',
    { class: 'querybar' },
    h(
      'div',
      { class: 'qrow' },
      h('input', { class: 'input', name: 'email', type: 'email', placeholder: 'email', required: true, autocomplete: 'off' }),
      h('input', { class: 'input', name: 'password', type: 'password', placeholder: 'пароль, не короче 10 символов', required: true, autocomplete: 'new-password' }),
      h('button', { class: 'btn primary', type: 'submit' }, 'Добавить или сменить пароль'),
    ),
    err,
  )
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = new FormData(form)
    err.textContent = ''
    try {
      const r = await api('POST', 'superusers', { email: f.get('email'), password: f.get('password') })
      toast(r.created ? 'Администратор добавлен' : 'Пароль изменён, его сессии закрыты')
      route()
    } catch (e2) {
      err.textContent = errorText(e2)
    }
  })
  main.append(
    h(
      'div',
      { class: 'page' },
      h('div', { class: 'page-head' }, h('h1', {}, 'Администраторы'), h('span', { class: 'muted' }, 'входят в эту админку; к пользователям приложения (users) отношения не имеют')),
      h('div', { class: 'section' }, 'Добавить'),
      form,
      h('div', { class: 'section' }, 'Все'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'grid' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Email'), h('th', {}, 'Создан'), h('th', {}, ''))),
          h(
            'tbody',
            {},
            list.map((s: any) =>
              h(
                'tr',
                {},
                h('td', {}, s.email, s.id === me?.id && h('span', { class: 'badge green' }, ' это вы')),
                h('td', {}, new Date(s.createdAt).toLocaleString('ru-RU')),
                h(
                  'td',
                  {},
                  h(
                    'button',
                    {
                      class: 'btn small danger',
                      disabled: list.length < 2,
                      title: list.length < 2 ? 'Последнего администратора удалить нельзя' : '',
                      onclick: async () => {
                        if (!confirm(`Удалить администратора ${s.email}? Его сессии закроются сразу.`)) return
                        try {
                          await api('DELETE', `superusers/${encodeURIComponent(s.id)}`)
                          if (s.id === me?.id) {
                            setToken(null)
                            me = null
                            location.hash = '#/login'
                            return
                          }
                          toast('Удалён')
                          route()
                        } catch (e) {
                          fail(e)
                        }
                      },
                    },
                    'Удалить',
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}

// ---------- связи ----------

async function backlinksDialog(c: string, id: string): Promise<void> {
  const list = await api('GET', `c/${encodeURIComponent(c)}/${encodeURIComponent(id)}/backlinks`).catch((e) => (fail(e), null))
  if (!list) return
  const ON: Record<string, string> = { restrict: 'удалить документ нельзя, пока они есть', cascade: 'удалятся вместе с ним', unset: 'ссылка уберётся', pull: 'id уберётся из массива' }
  const d = dialog(
    `Кто ссылается на ${c}/${id}`,
    [
      list.length
        ? h(
            'table',
            { class: 'grid' },
            h('tbody', {}, list.map((b: any) => h('tr', { class: 'click', onclick: () => (d.close(), openFiltered(b.c, `{ ${b.field}: '${id}' }`)) }, h('td', { class: 'cell' }, `${b.c}.${b.field}`), h('td', {}, num(b.count)), h('td', { class: 'faint' }, `при удалении: ${ON[b.onDelete] ?? b.onDelete}`)))),
          )
        : h('p', { class: 'muted' }, 'Никто не ссылается.'),
    ],
    [h('button', { class: 'btn', onclick: () => d.close() }, 'Закрыть')],
  )
}

const ON_DELETE: [string, string][] = [
  ['restrict', 'запретить удаление, пока есть ссылки'],
  ['cascade', 'удалить ссылающиеся документы'],
  ['unset', 'убрать поле у ссылающихся'],
  ['pull', 'убрать id из массива (для нескольких)'],
]

async function relationsTab(page: HTMLElement, name: string): Promise<void> {
  const m = await api('GET', `c/${encodeURIComponent(name)}/meta`).catch((e) => (fail(e), null))
  if (!m) return
  const rels: Record<string, Rel> = m.relations
  const editable = m.source === 'admin'
  const save = async (next: Record<string, Rel>) => {
    try {
      await api('PUT', `collections/${encodeURIComponent(name)}`, { relations: next })
      toast('Связи обновлены')
      route()
    } catch (e) {
      fail(e)
    }
  }
  page.append(
    h('p', { class: 'muted' }, 'Связь - поле с _id документа другой коллекции. MaBase проверяет, что такой документ есть, решает, что делать при его удалении, и подтягивает связанные документы в ответ (expand).'),
    h('div', { class: 'section' }, 'Эта коллекция ссылается'),
    Object.keys(rels).length
      ? h(
          'table',
          { class: 'grid' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Поле'), h('th', {}, 'На коллекцию'), h('th', {}, 'Сколько'), h('th', {}, 'При удалении связанного'), editable && h('th', {}, ''))),
          h(
            'tbody',
            {},
            Object.entries(rels).map(([f, r]) =>
              h(
                'tr',
                {},
                h('td', { class: 'cell' }, f),
                h('td', {}, h('a', { href: `#/c/${encodeURIComponent(r.to)}` }, r.to)),
                h('td', {}, r.many ? 'несколько (массив)' : 'один'),
                h('td', {}, Object.fromEntries(ON_DELETE)[r.onDelete] ?? r.onDelete),
                editable &&
                  h(
                    'td',
                    {},
                    h(
                      'button',
                      {
                        class: 'btn small danger',
                        onclick: () => {
                          const next = { ...rels }
                          delete next[f]
                          save(next)
                        },
                      },
                      'Убрать',
                    ),
                  ),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'Связей нет.'),
  )
  if (editable) {
    const fieldInput = h('input', { class: 'input mono', placeholder: 'поле, например userId' }) as HTMLInputElement
    const to = h('select', { class: 'input' }, (info?.collections ?? []).filter((c) => !c.system || c.name === 'users').map((c) => h('option', { value: c.name }, c.name))) as HTMLSelectElement
    const [manyRow, many] = check('Несколько', false, 'поле - массив _id')
    const onDel = h('select', { class: 'input' }, ON_DELETE.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement
    many.addEventListener('change', () => (onDel.value = many.checked ? 'pull' : 'restrict'))
    page.append(
      h('div', { class: 'section' }, 'Добавить связь'),
      h(
        'div',
        { class: 'panel' },
        h('div', { class: 'grid2' }, field('Поле', fieldInput), field('На коллекцию', to)),
        manyRow,
        field('Когда связанный документ удаляют', onDel),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              const f = fieldInput.value.trim()
              if (!f) return toast('Укажите поле', true)
              save({ ...rels, [f]: { to: to.value, many: many.checked, onDelete: onDel.value } })
            },
          },
          'Добавить связь',
        ),
      ),
    )
  } else if (m.source === 'code') {
    page.append(h('p', { class: 'muted' }, 'Коллекция объявлена в коде - связи задаются там:'), h('pre', { class: 'code-block' }, `defineCollection('${name}', {\n  relations: {\n    userId: { to: 'users', onDelete: 'restrict' },\n    tags: { to: 'tags', many: true, onDelete: 'pull' },\n  },\n})`))
  } else page.append(h('p', { class: 'muted' }, 'Связи можно задать у коллекций из кода и из админки. Здесь их нет - создайте коллекцию с этим именем ("+ создать" слева).'))
  page.append(
    h('div', { class: 'section' }, 'На эту коллекцию ссылаются'),
    m.incoming.length
      ? h('table', { class: 'grid' }, h('tbody', {}, m.incoming.map((i: any) => h('tr', {}, h('td', { class: 'cell' }, `${i.c}.${i.field}`), h('td', {}, Object.fromEntries(ON_DELETE)[i.onDelete] ?? i.onDelete)))))
      : h('p', { class: 'muted' }, 'Никто.'),
  )
}

// ---------- коллекции из админки ----------

function createCollectionDialog(): void {
  const name = h('input', { class: 'input mono', placeholder: 'orders', autocomplete: 'off', spellcheck: 'false' })
  const indexes = h('input', { class: 'input mono', placeholder: 'userId, status', spellcheck: 'false' })
  const err = h('div', { class: 'error-text' })
  const d = dialog(
    'Новая коллекция',
    [
      h('label', { class: 'field' }, 'Имя: латиница, цифры, _ и -, с буквы', name),
      h('label', { class: 'field' }, 'Индексы - поля через запятую (можно потом)', indexes),
      h('p', { class: 'muted' }, 'Клиентам (SDK, HTTP) новая коллекция закрыта, пока в mabase.config.ts нет её правил. Админка, хуки и действия работают с ней сразу.'),
      err,
    ],
    [
      h('button', { class: 'btn', onclick: () => d.close() }, 'Отмена'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            try {
              const n = name.value.trim()
              const idx = indexes.value.split(',').map((x) => x.trim()).filter(Boolean)
              await api('POST', 'collections', { name: n, indexes: idx })
              d.close()
              toast(`Коллекция ${n} создана`)
              location.hash = `#/c/${encodeURIComponent(n)}`
            } catch (e) {
              err.textContent = errorText(e)
            }
          },
        },
        'Создать',
      ),
    ],
  )
  name.focus()
}

function dropCollectionDialog(name: string, count: number): void {
  const confirmIn = h('input', { class: 'input mono', placeholder: name })
  const err = h('div', { class: 'error-text' })
  const d = dialog(
    `Удалить коллекцию ${name}?`,
    [
      h('p', {}, `Удалятся все документы (${num(count)}) и описание с индексами. Хуки удаления сработают на каждом документе. Отменить нельзя.`),
      h('label', { class: 'field' }, `Для подтверждения введите имя: ${name}`, confirmIn),
      err,
    ],
    [
      h('button', { class: 'btn', onclick: () => d.close() }, 'Отмена'),
      h(
        'button',
        {
          class: 'btn danger solid',
          onclick: async () => {
            if (confirmIn.value.trim() !== name) return void (err.textContent = 'Имя не совпало')
            try {
              const r = await api('DELETE', `collections/${encodeURIComponent(name)}`)
              d.close()
              toast(`Коллекция удалена, документов: ${num(r.deleted)}`)
              location.hash = '#/'
            } catch (e) {
              err.textContent = errorText(e)
            }
          },
        },
        'Удалить',
      ),
    ],
  )
  confirmIn.focus()
}

// ---------- настройки ----------

type Settings = {
  fixed: { auth: boolean; mail: boolean }
  auth: any
  mail: any
  callbacks: { google: string; github: string }
  db: { systemFields: { name: string; type: string; about: string }[]; limits: Record<string, number>; dir: string }
}

// Поле формы: подпись, ввод, подсказка.
function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, label, input, hint && h('span', { class: 'faint' }, hint))
}
function check(label: string, on: boolean, hint?: string): [HTMLElement, HTMLInputElement] {
  const box = h('input', { type: 'checkbox' }) as HTMLInputElement
  box.checked = on
  return [h('label', { class: 'check' }, box, h('span', {}, h('b', {}, label), hint && h('span', { class: 'faint' }, ` - ${hint}`))), box]
}

async function settingsPage(main: HTMLElement, first: boolean): Promise<void> {
  const s = await api<Settings>('GET', 'settings').catch((e) => (fail(e), null))
  if (!s) return
  const page = h('div', { class: 'page' })
  main.append(page)
  page.append(
    h('div', { class: 'page-head' }, h('h1', {}, first ? 'Первичная настройка' : 'Настройки')),
    first
      ? h('p', { class: 'muted' }, 'Администратор создан. Осталось выбрать, как будут входить пользователи вашего приложения, и куда слать письма. Всё можно поменять потом здесь же, в "Настройках".')
      : h('p', { class: 'muted' }, 'Хранятся в базе и применяются сразу, без перезапуска. Секреты хранятся зашифрованными и наружу не показываются.'),
  )

  // ----- вход пользователей -----
  const A = s.auth ?? {}
  const ro = s.fixed.auth
  const [pwRow, pw] = check('Email и пароль', A.password ?? true, 'регистрация и вход по паролю')
  const [suRow, signup] = check('Регистрация открыта', A.signup ?? true, 'новые пользователи заводятся сами; иначе - только через админку и действия')
  const minLen = h('input', { class: 'input', type: 'number', min: 6, max: 128, value: String(A.minPasswordLength ?? 8) }) as HTMLInputElement
  const [phRow, phone] = check('Телефон', A.phone ?? false, 'вход по коду через сервис authphone.su, без SMS')
  const appUrl = h('input', { class: 'input mono', placeholder: 'https://my.app', value: A.appUrl ?? '' }) as HTMLInputElement
  const oauthBlock = (p: 'google' | 'github', title: string) => {
    const c = A[p] ?? {}
    const [row, on] = check(title, !!c.enabled, 'вход через аккаунт ' + title)
    const id = h('input', { class: 'input mono', value: c.clientId ?? '', placeholder: 'Client ID' }) as HTMLInputElement
    const secret = h('input', { class: 'input mono', type: 'password', placeholder: c.clientSecret ? 'задан - оставьте пустым, чтобы не менять' : 'Client Secret', autocomplete: 'off' }) as HTMLInputElement
    const box = h(
      'div',
      { class: 'sub' },
      field('Client ID', id),
      field('Client Secret', secret),
      field('Адрес возврата (callback) - впишите его в настройках приложения у ' + title, h('input', { class: 'input mono', readonly: true, value: s.callbacks[p] })),
    )
    box.hidden = !on.checked
    on.addEventListener('change', () => (box.hidden = !on.checked))
    return { el: h('div', {}, row, ro ? null : box), get: () => ({ enabled: on.checked, clientId: id.value, clientSecret: secret.value }) }
  }
  const google = oauthBlock('google', 'Google')
  const github = oauthBlock('github', 'GitHub')
  const authErr = h('div', { class: 'error-text' })
  const authForm = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Вход пользователей приложения', ro && h('span', { class: 'badge warn' }, ' задано в mabase.config.ts')),
    pwRow,
    h('div', { class: 'sub' }, suRow, field('Минимальная длина пароля', minLen)),
    phRow,
    google.el,
    github.el,
    field('Адрес приложения', appUrl, 'сайт вашего приложения: сюда ведут ссылки из писем и возврат после входа через Google и GitHub. Обязателен для них и для SMTP'),
    authErr,
  )
  if (ro) for (const el of authForm.querySelectorAll('input')) (el as HTMLInputElement).disabled = true

  // ----- почта -----
  const M = s.mail ?? {}
  const mro = s.fixed.mail
  const mode = h('select', { class: 'input' }, h('option', { value: 'dev' }, 'В консоль сервера (для разработки)'), h('option', { value: 'smtp' }, 'SMTP-сервер')) as HTMLSelectElement
  mode.value = M.mode ?? 'dev'
  const S = M.smtp ?? {}
  const host = h('input', { class: 'input mono', placeholder: 'smtp.example.com', value: S.host ?? '' }) as HTMLInputElement
  const port = h('input', { class: 'input mono', type: 'number', placeholder: '587', value: S.port ? String(S.port) : '' }) as HTMLInputElement
  const [tlsRow, tls] = check('Сразу TLS', !!S.secure, 'обычно порт 465; для 587 не нужно - TLS включится командой STARTTLS')
  const user = h('input', { class: 'input mono', value: S.user ?? '', autocomplete: 'off' }) as HTMLInputElement
  const pass = h('input', { class: 'input mono', type: 'password', placeholder: S.pass ? 'задан - оставьте пустым, чтобы не менять' : '', autocomplete: 'off' }) as HTMLInputElement
  const from = h('input', { class: 'input mono', placeholder: 'Моё приложение <no-reply@my.app>', value: M.from ?? '' }) as HTMLInputElement
  const appName = h('input', { class: 'input', placeholder: 'MaBase', value: M.appName ?? '' }) as HTMLInputElement
  const smtpBox = h('div', { class: 'sub' }, h('div', { class: 'grid2' }, field('Сервер', host), field('Порт', port)), tlsRow, h('div', { class: 'grid2' }, field('Логин', user), field('Пароль', pass)))
  const showSmtp = () => (smtpBox.hidden = mode.value !== 'smtp')
  mode.addEventListener('change', showSmtp)
  showSmtp()
  const mailErr = h('div', { class: 'error-text' })
  const testBtn = h('button', { class: 'btn', type: 'button' }, 'Отправить проверочное письмо себе')
  testBtn.addEventListener('click', async () => {
    try {
      const r = await api('POST', 'settings/test-mail', { to: me?.email })
      toast(r.mode === 'dev' ? 'Письмо напечатано в консоли сервера' : `Письмо ушло на ${me?.email}`)
    } catch (e) {
      mailErr.textContent = errorText(e)
    }
  })
  const mailForm = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Почта', mro && h('span', { class: 'badge warn' }, ' задано в mabase.config.ts')),
    h('p', { class: 'muted' }, 'Письма подтверждения email, сброса пароля и ваши mail.send() из хуков.'),
    field('Как отправлять', mode),
    smtpBox,
    h('div', { class: 'grid2' }, field('Отправитель', from), field('Название в письмах', appName)),
    mailErr,
    testBtn,
  )
  if (mro) for (const el of mailForm.querySelectorAll('input, select')) (el as HTMLInputElement).disabled = true

  const save = async (): Promise<boolean> => {
    authErr.textContent = mailErr.textContent = ''
    const body: any = {}
    if (!ro)
      body.auth = {
        password: pw.checked,
        signup: signup.checked,
        minPasswordLength: Number(minLen.value) || 8,
        phone: phone.checked,
        google: google.get(),
        github: github.get(),
        appUrl: appUrl.value.trim(),
      }
    if (!mro) body.mail = { mode: mode.value, from: from.value, appName: appName.value, smtp: { host: host.value, port: port.value ? Number(port.value) : undefined, secure: tls.checked, user: user.value, pass: pass.value } }
    if (!body.auth && !body.mail) return true
    try {
      await api('PUT', 'settings', body)
      toast('Настройки сохранены и уже работают')
      return true
    } catch (e) {
      const t = errorText(e)
      if (/почт|smtp|mail/i.test(t)) mailErr.textContent = t
      else authErr.textContent = t
      return false
    }
  }

  // ----- база: что есть в каждой коллекции -----
  const base = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'База'),
    h('p', { class: 'muted' }, 'Что есть в каждом документе любой коллекции - эти поля ставит сервер:'),
    h(
      'table',
      { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Поле'), h('th', {}, 'Тип'), h('th', {}, 'Что это'))),
      h('tbody', {}, s.db.systemFields.map((f) => h('tr', {}, h('td', { class: 'cell' }, f.name), h('td', {}, f.type), h('td', {}, f.about)))),
    ),
    h('p', { class: 'muted' }, 'Остальные поля - любые значения JSON. Время храните числом (Date.now()). Схема полей - по желанию, через zod в mabase.config.ts; без схемы документ принимается любой.'),
    h('p', { class: 'muted' }, 'Ограничения запросов от клиентов (меняются в mabase.config.ts, раздел limits):'),
    h(
      'table',
      { class: 'grid' },
      h(
        'tbody',
        {},
        [
          ['defaultLimit', 'документов в ответе, если limit не указан'],
          ['maxLimit', 'больше limit нельзя'],
          ['maxScanned', 'сколько документов можно перебрать за запрос без индекса'],
          ['maxRegexLength', 'длина $regex от клиента'],
        ].map(([k, about]) => h('tr', {}, h('td', { class: 'cell' }, k!), h('td', {}, num(s.db.limits[k!] ?? 0)), h('td', {}, about!))),
      ),
    ),
    h('p', { class: 'faint' }, `Папка базы: ${s.db.dir}`),
  )

  const buttons = h('div', { class: 'row-actions' })
  if (first) {
    buttons.append(
      h('button', { class: 'btn primary', onclick: async () => (await save()) && (location.hash = '#/') }, 'Сохранить и перейти в админку'),
      h('button', { class: 'btn', onclick: () => (location.hash = '#/') }, 'Пропустить - оставить по умолчанию'),
    )
  } else if (!ro || !mro) buttons.append(h('button', { class: 'btn primary', onclick: () => save() }, 'Сохранить'))
  page.append(authForm, mailForm, buttons, first ? null : base)
}

void route().catch(fail)

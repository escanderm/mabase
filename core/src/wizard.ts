// Первичная настройка в терминале: при первом `mabase serve` из терминала,
// пока нет ни одного администратора. Администратор, способы входа, почта -
// то же, что мастер в браузере по ссылке. Enter на первом вопросе - пропустить:
// останется ссылка для браузера.
import type { Settings, StoredSettings } from './settings'
import type { Superusers } from './superusers'

export type WizardIO = {
  ask: (q: string) => Promise<string>
  secret: (q: string) => Promise<string> // ввод без эха
  print: (line: string) => void
}

export async function runWizard(io: WizardIO, deps: { superusers: Superusers; settings: Settings; url: string }): Promise<boolean> {
  const { superusers, settings, url } = deps
  const yes = async (q: string, def: boolean) => {
    const a = (await io.ask(`${q} [${def ? 'Д/н' : 'д/Н'}]: `)).trim().toLowerCase()
    return a ? /^(д|да|y|yes)$/.test(a) : def
  }
  io.print('')
  io.print('Первый запуск MaBase - настроим за минуту. Всё можно поменять потом в админке.')
  io.print('Enter без ответа - пропустить и настроить в браузере по ссылке ниже.')
  io.print('')

  // ----- администратор -----
  const email = (await io.ask('Email администратора: ')).trim()
  if (!email) return false
  let password = ''
  for (;;) {
    password = await io.secret('Пароль (не короче 10 символов): ')
    if (password.length < 10) {
      io.print('  Короче 10 символов, ещё раз.')
      continue
    }
    if ((await io.secret('Пароль ещё раз: ')) === password) break
    io.print('  Пароли не совпали, ещё раз.')
  }
  if ((await superusers.count()) > 0) {
    io.print('Администратора уже создали в браузере - этот шаг пропускаю.')
  } else {
    try {
      await superusers.upsert(email, password)
      io.print(`  Администратор ${email.toLowerCase()} создан.`)
    } catch (err) {
      io.print(`  Не получилось: ${(err as Error).message}`)
      return false
    }
  }

  const patch: StoredSettings = {}
  const view = settings.view()

  // ----- вход пользователей -----
  io.print('')
  if (view.fixed.auth) io.print('Вход пользователей задан в mabase.config.ts - пропускаю.')
  else {
    io.print('Как входят пользователи вашего приложения?')
    io.print('  1. Email и пароль')
    io.print('  2. Телефон (код через authphone.su, без SMS)')
    io.print('  3. Google')
    io.print('  4. GitHub')
    const picked = new Set(((await io.ask('Номера через запятую [1]: ')).match(/[1-4]/g) ?? ['1']).map(Number))
    const auth: NonNullable<StoredSettings['auth']> = { password: picked.has(1), phone: picked.has(2) }
    for (const [n, p, title] of [
      [3, 'google', 'Google'],
      [4, 'github', 'GitHub'],
    ] as const) {
      if (!picked.has(n)) continue
      io.print(`  ${title}: адрес возврата для настроек приложения у ${title}:`)
      io.print(`    ${url}/api/auth/oauth/${p}/callback   (за доменом - замените адрес на свой)`)
      auth[p] = { enabled: true, clientId: (await io.ask(`  ${title} Client ID: `)).trim(), clientSecret: await io.secret(`  ${title} Client Secret: `) }
    }
    if (picked.has(1) || picked.has(2)) auth.signup = await yes('Регистрация открыта для всех?', true)
    if (picked.has(3) || picked.has(4)) auth.appUrl = (await io.ask('Адрес вашего приложения (https://...): ')).trim()
    patch.auth = auth
  }

  // ----- почта -----
  io.print('')
  if (view.fixed.mail) io.print('Почта задана в mabase.config.ts - пропускаю.')
  else {
    io.print('Почта (подтверждение email, сброс пароля, письма из хуков):')
    io.print('  1. В консоль сервера - для разработки')
    io.print('  2. SMTP-сервер')
    if ((await io.ask('Номер [1]: ')).trim() === '2') {
      const host = (await io.ask('  SMTP сервер (smtp.example.com): ')).trim()
      const port = Number((await io.ask('  Порт [587]: ')).trim() || 587)
      const user = (await io.ask('  Логин: ')).trim()
      const pass = await io.secret('  Пароль: ')
      const from = (await io.ask('  Отправитель (Имя <no-reply@my.app>): ')).trim()
      patch.mail = { mode: 'smtp', from, smtp: { host, port, secure: port === 465, user, pass } }
      if (!patch.auth?.appUrl && !view.fixed.auth) patch.auth = { ...patch.auth, appUrl: (await io.ask('  Адрес приложения для ссылок в письмах (https://...): ')).trim() }
    } else patch.mail = { mode: 'dev' }
  }

  if (patch.auth || patch.mail) {
    try {
      await settings.save(patch)
      io.print('  Настройки сохранены.')
    } catch (err) {
      io.print(`  Настройки не сохранились: ${(err as Error).message}`)
      io.print('  Поправьте в админке: Настройки.')
    }
  }
  io.print('')
  io.print(`Готово. Админка: ${url}/_/ - войдите как ${email.toLowerCase()}`)
  io.print('')
  return true
}

// Ввод с клавиатуры в raw-режиме: свой, без readline - чтобы пароль точно
// не печатался. Один слушатель на весь мастер: вставленные разом строки не
// теряются. Backspace стирает, Ctrl-C - как обычно, остановить сервер.
export function terminalIO(): WizardIO & { close: () => void } {
  const stdin = process.stdin
  let queue = ''
  let waiting: { mask: boolean; buf: string; resolve: (v: string) => void } | null = null
  const pump = () => {
    while (waiting && queue) {
      const ch = [...queue][0]!
      queue = queue.slice(ch.length)
      const w = waiting
      if (ch === '\r' || ch === '\n' || ch === '\x04') {
        if (ch === '\r' && queue[0] === '\n') queue = queue.slice(1)
        process.stdout.write('\n')
        waiting = null
        w.resolve(w.buf)
      } else if (ch === '\x03') {
        process.stdout.write('\n')
        close()
        process.kill(process.pid, 'SIGINT')
        return
      } else if (ch === '\x7f' || ch === '\b') {
        if (w.buf) {
          w.buf = [...w.buf].slice(0, -1).join('')
          process.stdout.write('\b \b')
        }
      } else if (ch === '\x1b') queue = queue.replace(/^\[[\d;]*[A-Za-z~]/, '') // стрелки и прочие клавиши - не текст
      else if (ch >= ' ') {
        w.buf += ch
        process.stdout.write(w.mask ? '*' : ch)
      }
    }
  }
  const onData = (chunk: string) => {
    queue += chunk
    pump()
  }
  stdin.setRawMode(true)
  stdin.setEncoding('utf8')
  stdin.on('data', onData)
  stdin.resume()
  const close = () => {
    stdin.off('data', onData)
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
  }
  const read = (prompt: string, mask: boolean) =>
    new Promise<string>((resolve) => {
      process.stdout.write(prompt)
      waiting = { mask, buf: '', resolve }
      pump()
    })
  return { ask: (q) => read(q, false), secret: (q) => read(q, true), print: (line) => console.log(line), close }
}

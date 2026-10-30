// Почта (design.md §11): SMTP через nodemailer или своя функция отправки
// (Resend, Unisender, Postmark - через их HTTP API). Нет ни того, ни другого -
// режим разработки: письмо со ссылкой печатается в консоль.
import nodemailer from 'nodemailer'
import type { Doc } from './query'

export type MailMessage = { to: string; subject: string; text: string; html?: string }
export type Letter = Omit<MailMessage, 'to'>

// link - готовая ссылка на appUrl; token - если шаблону нужна своя ссылка.
export type LetterCtx = { appName: string; link: string; token: string; email: string; user: Doc }
export type Templates = {
  verifyEmail: (ctx: LetterCtx) => Letter
  resetPassword: (ctx: LetterCtx) => Letter
  changeEmail: (ctx: LetterCtx) => Letter
}
export type LetterKind = keyof Templates

export type SmtpOptions = {
  host: string
  port?: number // 587 по умолчанию; 465 - сразу TLS
  secure?: boolean
  user?: string
  pass?: string
}

export type MailOptions = {
  from?: string // 'Чат <no-reply@chat.example.test>'
  appName?: string
  smtp?: SmtpOptions
  send?: (msg: MailMessage & { from: string }) => Promise<void>
  templates?: Partial<Templates>
  timeoutMs?: number // соединение и ответ SMTP-сервера
  onDevMail?: (msg: MailMessage) => void // режим разработки; по умолчанию - в консоль
}

export const DEFAULT_TEMPLATES: Templates = {
  verifyEmail: ({ appName, link, email }) => ({
    subject: `Подтвердите email - ${appName}`,
    text:
      `Здравствуйте!\n\nЧтобы подтвердить адрес ${email}, откройте ссылку:\n${link}\n\n` +
      `Ссылка работает 24 часа. Если вы не регистрировались в ${appName}, просто удалите это письмо.\n`,
  }),
  resetPassword: ({ appName, link }) => ({
    subject: `Сброс пароля - ${appName}`,
    text:
      `Здравствуйте!\n\nЧтобы задать новый пароль, откройте ссылку:\n${link}\n\n` +
      'Ссылка работает 1 час и только один раз. Если вы не просили сброс, ничего не делайте: пароль останется прежним.\n',
  }),
  changeEmail: ({ appName, link, email }) => ({
    subject: `Подтвердите новый email - ${appName}`,
    text:
      `Здравствуйте!\n\nЧтобы сменить email в ${appName} на ${email}, откройте ссылку:\n${link}\n\n` +
      'Ссылка работает 24 часа. Если вы не меняли email, просто удалите это письмо.\n',
  }),
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ')

export class Mailer {
  readonly mode: 'smtp' | 'send' | 'dev'
  readonly appName: string
  private from: string
  private templates: Templates
  private deliver: (msg: MailMessage) => Promise<void>

  constructor(opts: MailOptions = {}) {
    if (opts.smtp && opts.send) throw new TypeError('mail: либо smtp, либо send')
    this.appName = opts.appName ?? 'MaBase'
    this.from = opts.from ?? `${this.appName} <no-reply@localhost>`
    this.templates = { ...DEFAULT_TEMPLATES, ...opts.templates }
    const timeout = opts.timeoutMs ?? 10_000
    if (opts.smtp) {
      const { host, port = 587, secure = port === 465, user, pass } = opts.smtp
      if (!host) throw new TypeError('mail.smtp.host не задан')
      const transport = nodemailer.createTransport({
        host,
        port,
        secure,
        // С паролем без TLS не соединяемся: пароль ушёл бы открытым текстом.
        requireTLS: !!user && !secure,
        auth: user ? { user, pass } : undefined,
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
      })
      this.mode = 'smtp'
      this.deliver = async (msg) => {
        await transport.sendMail({ from: this.from, ...msg })
      }
    } else if (opts.send) {
      const send = opts.send
      this.mode = 'send'
      this.deliver = (msg) => send({ from: this.from, ...msg })
    } else {
      const print =
        opts.onDevMail ??
        ((msg: MailMessage) =>
          console.log(`[mabase] письмо (почта не настроена - режим разработки)\n  кому: ${msg.to}\n  тема: ${msg.subject}\n\n${msg.text}`))
      this.mode = 'dev'
      this.deliver = async (msg) => print(msg)
    }
  }

  // Отправить письмо. Ошибка отправки - исключение: что с ним делать, решает вызывающий.
  async send(msg: MailMessage): Promise<void> {
    if (typeof msg.to !== 'string' || /[\r\n,;<>]/.test(msg.to) || !msg.to.includes('@')) throw new TypeError(`mail: неверный адрес ${msg.to}`)
    await this.deliver({ ...msg, subject: oneLine(msg.subject) })
  }

  letter(kind: LetterKind, ctx: Omit<LetterCtx, 'appName'>): MailMessage {
    return { to: ctx.email, ...this.templates[kind]({ ...ctx, appName: this.appName }) }
  }
}

import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../src/db'

const ROOT = join(import.meta.dir, '..', '.tmp')

export function tmpDir(prefix = 't'): string {
  mkdirSync(ROOT, { recursive: true })
  return mkdtempSync(join(ROOT, `${prefix}-`))
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    if (await check()) return
    await sleep(5)
  }
  throw new Error(`Условие не выполнилось за ${timeoutMs} мс`)
}

export function currentLogPath(dir: string): string {
  const gen = readFileSync(join(dir, 'CURRENT'), 'utf8').trim()
  return join(dir, `log.${gen}.jsonl`)
}

export function files(dir: string): string[] {
  return readdirSync(dir).sort()
}

// Всё содержимое базы в сравнимом виде.
export async function dump(db: Db, collections: string[]): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const c of collections) out[c] = await db.c[c]!.find()
  return out
}

// Поддельный SMTP-сервер: принимает письма без TLS и пароля, хранит как есть.
// reject = true - отвечает ошибкой на конец письма.
export type SmtpMail = { from: string; to: string[]; raw: string }
export function fakeSmtp() {
  const mails: SmtpMail[] = []
  const state = { reject: false }
  type S = { buf: string; inData: boolean; cur: SmtpMail }
  const server = Bun.listen<S>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(s) {
        s.data = { buf: '', inData: false, cur: { from: '', to: [], raw: '' } }
        s.write('220 fake ESMTP\r\n')
      },
      data(s, chunk) {
        const st = s.data
        st.buf += chunk.toString()
        let i: number
        while ((i = st.buf.indexOf('\r\n')) >= 0) {
          const line = st.buf.slice(0, i)
          st.buf = st.buf.slice(i + 2)
          if (st.inData) {
            if (line === '.') {
              st.inData = false
              if (state.reject) s.write('554 rejected\r\n')
              else {
                mails.push(st.cur)
                s.write('250 OK\r\n')
              }
              st.cur = { from: '', to: [], raw: '' }
            } else st.cur.raw += (line.startsWith('..') ? line.slice(1) : line) + '\n'
            continue
          }
          const cmd = line.slice(0, 4).toUpperCase()
          if (cmd === 'EHLO') s.write('250-fake\r\n250 8BITMIME\r\n')
          else if (cmd === 'HELO' || cmd === 'RSET' || cmd === 'NOOP') s.write('250 OK\r\n')
          else if (cmd === 'MAIL') {
            st.cur.from = /<(.*)>/.exec(line)?.[1] ?? ''
            s.write('250 OK\r\n')
          } else if (cmd === 'RCPT') {
            st.cur.to.push(/<(.*)>/.exec(line)?.[1] ?? '')
            s.write('250 OK\r\n')
          } else if (cmd === 'DATA') {
            st.inData = true
            s.write('354 go\r\n')
          } else if (cmd === 'QUIT') {
            s.write('221 bye\r\n')
            s.end()
          } else s.write('502 unknown\r\n')
        }
      },
    },
  })
  return { port: server.port, mails, state, stop: () => server.stop(true) }
}

// Тело письма из сырого MIME: снять quoted-printable или base64.
export function mailBody(raw: string): string {
  const [head, ...rest] = raw.split('\n\n')
  const body = rest.join('\n\n')
  const enc = /content-transfer-encoding:\s*(\S+)/i.exec(head!)?.[1]?.toLowerCase()
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (enc === 'quoted-printable') {
    const bytes = body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    return Buffer.from(bytes, 'latin1').toString('utf8')
  }
  return body
}

// Файлы (design.md §16): поле-файл в коллекции, метаданные - в служебной
// _files, байты - в хранилище: локальная папка <dataDir>/files/... или S3.
//
// Файл пишется ДО транзакции, которая сохраняет запись и метаданные: откат
// транзакции удаляет файл, а падение между записью и коммитом оставляет
// сироту - это безопасно, на неё никто не ссылается.
import { createHash, createHmac } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Change, Db } from './db'
import { ActionError, NotFoundError } from './errors'
import { ulid } from './ulid'

export const FILES = '_files'
export const DEFAULT_MAX_FILE = 100 << 20 // 100 МБ на файл

export type FileField = {
  maxBytes?: number // предел на файл; больше - 413
  accept?: string[] // префиксы mime: ['image/', 'application/pdf']
  many?: boolean // значение поля - массив id
}
export type FileFields = Record<string, FileField>

export type Upload = { name: string; type: string; bytes: Uint8Array }

export type FileMeta = {
  _id: string
  collection: string
  recordId: string
  field: string
  name: string
  size: number
  mime: string
  createdAt: number
}

// Имя в пути: буквы, цифры, точка, дефис, подчёркивание. Остальное - '_'.
// Кириллица остаётся: файл «фото.png» читаем глазами.
function safeSegment(name: string): string {
  const s = name.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '_').slice(0, 120)
  return s || '_'
}

const idsOf = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// Куда кладутся байты. Метаданные всегда в базе, поэтому хранилище можно
// менять: старые файлы при этом не переезжают (см. README).
export type ByteRange = { start: number; end: number } // включительно, как в HTTP

export interface FileStorage {
  put(meta: FileMeta, bytes: Uint8Array): Promise<void>
  get(meta: FileMeta, range?: ByteRange): Promise<Uint8Array>
  delete(meta: FileMeta): Promise<void>
  // Есть ли файл в хранилище. Нужен переносу: не копировать то, что уже там.
  head(meta: FileMeta): Promise<boolean>
  removeRecord?(collection: string, recordId: string): Promise<void>
}

// ---------- локальный диск ----------

export class LocalStorage implements FileStorage {
  constructor(readonly root: string) {}

  recordDir(collection: string, recordId: string): string {
    return join(this.root, safeSegment(collection), safeSegment(recordId))
  }

  pathFor(meta: Pick<FileMeta, 'collection' | 'recordId' | '_id' | 'name'>): string {
    return join(this.recordDir(meta.collection, meta.recordId), `${safeSegment(meta._id)}-${safeSegment(meta.name)}`)
  }

  async put(meta: FileMeta, bytes: Uint8Array): Promise<void> {
    mkdirSync(this.recordDir(meta.collection, meta.recordId), { recursive: true })
    const fd = openSync(this.pathFor(meta), 'wx')
    try {
      writeSync(fd, bytes)
      fsyncSync(fd) // файл на диске раньше, чем запись о нём в логе
    } finally {
      closeSync(fd)
    }
  }

  // Срез читается только нужными байтами: докачка большого файла не поднимает
  // его целиком в память.
  async get(meta: FileMeta, range?: ByteRange): Promise<Uint8Array> {
    if (!range) return readFileSync(this.pathFor(meta))
    const len = range.end - range.start + 1
    const buf = Buffer.allocUnsafe(len)
    const fd = openSync(this.pathFor(meta), 'r')
    try {
      let got = 0
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, range.start + got)
        if (!n) break
        got += n
      }
      return buf.subarray(0, got)
    } finally {
      closeSync(fd)
    }
  }

  async delete(meta: FileMeta): Promise<void> {
    try {
      unlinkSync(this.pathFor(meta))
    } catch {}
  }

  async head(meta: FileMeta): Promise<boolean> {
    return existsSync(this.pathFor(meta))
  }

  async removeRecord(collection: string, recordId: string): Promise<void> {
    rmSync(this.recordDir(collection, recordId), { recursive: true, force: true })
  }
}

// ---------- S3 ----------

export type S3Options = {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string // AWS, MinIO, Cloudflare R2, Yandex; по умолчанию AWS
  prefix?: string // общий префикс ключей, например 'myapp'
  forcePathStyle?: boolean // bucket в пути, а не в поддомене; по умолчанию - для не-AWS
  sessionToken?: string // временные ключи
}

const sha256hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()
const encodeRfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

// S3-совместимое хранилище без зависимостей: PUT/GET/DELETE объекта с подписью
// AWS Signature V4. Работает с AWS, MinIO, Cloudflare R2 и Яндексом.
export class S3Storage implements FileStorage {
  private endpoint: URL
  private pathStyle: boolean

  constructor(readonly opts: S3Options) {
    const missing = ['bucket', 'region', 'accessKeyId', 'secretAccessKey'].filter((k) => !(opts as any)[k])
    if (missing.length) throw new TypeError(`storage.s3: нужны ${missing.join(', ')}`)
    this.endpoint = new URL(opts.endpoint ?? `https://s3.${opts.region}.amazonaws.com`)
    this.pathStyle = opts.forcePathStyle ?? !/(^|\.)amazonaws\.com$/.test(this.endpoint.hostname)
  }

  key(meta: FileMeta): string {
    const parts = [this.opts.prefix?.replace(/^\/+|\/+$/g, ''), meta.collection, meta.recordId, `${meta._id}-${safeSegment(meta.name)}`]
    return parts.filter(Boolean).join('/')
  }

  private location(key: string): { url: URL; host: string; path: string } {
    const host = this.pathStyle ? this.endpoint.host : `${this.opts.bucket}.${this.endpoint.host}`
    const path = this.pathStyle ? `/${this.opts.bucket}/${key}` : `/${key}`
    const url = new URL(this.endpoint.href)
    url.host = host
    url.pathname = path
    return { url, host, path }
  }

  // Заголовки с подписью AWS Signature V4 (query-параметров у объектов нет).
  private sign(method: string, host: string, path: string, payloadHash: string): Record<string, string> {
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const date = amzDate.slice(0, 8)
    const scope = `${date}/${this.opts.region}/s3/aws4_request`
    // host участвует в подписи, но в запрос его не кладём: fetch выставит сам,
    // а второй заголовок Host некоторые S3-серверы (Beget) рвут соединением.
    const signedHeaders: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
    if (this.opts.sessionToken) signedHeaders['x-amz-security-token'] = this.opts.sessionToken
    const names = Object.keys(signedHeaders).sort()
    const signed = names.join(';')
    const canonicalHeaders = names.map((k) => `${k}:${signedHeaders[k]}\n`).join('')
    const canonicalUri = path.split('/').map(encodeRfc3986).join('/')
    const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signed}\n${payloadHash}`
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.opts.secretAccessKey}`, date), this.opts.region), 's3'), 'aws4_request')
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
    const sent: Record<string, string> = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
    if (this.opts.sessionToken) sent['x-amz-security-token'] = this.opts.sessionToken
    return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${this.opts.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` }
  }

  private async request(method: string, key: string, body?: Uint8Array, extra?: Record<string, string>): Promise<Response> {
    const { url, host, path } = this.location(key)
    const payloadHash = sha256hex(body ?? new Uint8Array())
    const headers = { ...this.sign(method, host, path, payloadHash), ...extra }
    const res = await fetch(url, { method, headers, body: body as BodyInit | undefined })
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '')
      throw new Error(`S3 ${method} ${key}: HTTP ${res.status} ${text.slice(0, 200)}`)
    }
    return res
  }

  async put(meta: FileMeta, bytes: Uint8Array): Promise<void> {
    await this.request('PUT', this.key(meta), bytes)
  }

  async get(meta: FileMeta, range?: ByteRange): Promise<Uint8Array> {
    // Range в S3 - обычный заголовок со подписью; сервер отвечает 206 и срезом
    const res = await this.request('GET', this.key(meta), undefined, range ? { range: `bytes=${range.start}-${range.end}` } : undefined)
    if (res.status === 404) throw new NotFoundError('файл', meta._id)
    const bytes = new Uint8Array(await res.arrayBuffer())
    // сервер вправе проигнорировать Range и отдать всё - вырезаем сами
    if (range && res.status === 200) return bytes.subarray(range.start, range.end + 1)
    return bytes
  }

  async delete(meta: FileMeta): Promise<void> {
    await this.request('DELETE', this.key(meta))
  }

  async head(meta: FileMeta): Promise<boolean> {
    const res = await this.request('HEAD', this.key(meta))
    return res.status !== 404
  }
}

// ---------- файлы поверх хранилища ----------

export class FileStore {
  storage: FileStorage

  constructor(
    // хранилище можно заменить на ходу: админка переключает локальную папку и S3
    storage: FileStorage,
    readonly maxUpload = DEFAULT_MAX_FILE,
  ) {
    this.storage = storage
  }

  // Проверить и записать загруженные файлы. Возвращает значения полей документа
  // и метаданные для _files. Ошибка на любом файле - записанные удаляются.
  async save(
    collection: string,
    recordId: string,
    fields: FileFields,
    uploads: Record<string, Upload[]>,
    now = Date.now(),
  ): Promise<{ values: Record<string, string | string[]>; metas: FileMeta[] }> {
    const values: Record<string, string | string[]> = {}
    const metas: FileMeta[] = []
    try {
      for (const [field, list] of Object.entries(uploads)) {
        const def = fields[field]
        if (!def) throw new ActionError('bad_request', `${collection}: поле ${field} не объявлено как файл (files)`)
        if (!list.length) continue
        if (!def.many && list.length > 1) throw new ActionError('bad_request', `${collection}.${field}: одно значение, а файлов ${list.length}`)
        const ids: string[] = []
        for (const up of list) {
          const max = Math.min(def.maxBytes ?? this.maxUpload, this.maxUpload)
          if (up.bytes.byteLength > max) throw new ActionError('too_large', `${collection}.${field}: файл ${up.name || 'без имени'} больше ${max} байт`)
          const mime = up.type || 'application/octet-stream'
          if (def.accept?.length && !def.accept.some((a) => mime.startsWith(a))) {
            throw new ActionError('bad_request', `${collection}.${field}: тип ${mime} не подходит, разрешены ${def.accept.join(', ')}`)
          }
          const meta: FileMeta = { _id: ulid(), collection, recordId, field, name: up.name || 'file', size: up.bytes.byteLength, mime, createdAt: now }
          await this.storage.put(meta, up.bytes)
          metas.push(meta)
          ids.push(meta._id)
        }
        values[field] = def.many ? ids : ids[0]!
      }
    } catch (err) {
      await this.removeMany(metas)
      throw err
    }
    return { values, metas }
  }

  async read(meta: FileMeta, range?: ByteRange): Promise<Uint8Array> {
    return this.storage.get(meta, range)
  }

  async removeOne(meta: FileMeta): Promise<void> {
    await this.storage.delete(meta)
  }

  async removeMany(metas: FileMeta[]): Promise<void> {
    for (const m of metas) await this.removeOne(m)
  }

  async removeRecord(collection: string, recordId: string): Promise<void> {
    await this.storage.removeRecord?.(collection, recordId)
  }
}

// Уборка после коммита: удалили запись - убрать её файлы; заменили файл -
// убрать старый. Метаданные в _files удаляются своей транзакцией, байты -
// следом. Ошибка уборки не отменяет уже сохранённое.
export function attachFileCleanup(opts: {
  db: Db
  files: FileStore
  defs: (c: string) => FileFields | undefined
  onError: (err: unknown, where: string) => void
}): void {
  const { db, files, defs, onError } = opts
  db.onCommit((info) => {
    const metas: FileMeta[] = []
    const records: Array<{ c: string; id: string }> = []
    const collect = (doc: Record<string, unknown> | null, fields: FileFields) => {
      if (!doc) return
      for (const field of Object.keys(fields)) {
        for (const id of idsOf(doc[field])) {
          const meta = db.peek(FILES, id) as FileMeta | null
          if (meta) metas.push(meta)
        }
      }
    }
    for (const ch of info.changes as readonly Change[]) {
      const fields = defs(ch.c)
      if (!fields) continue
      if (!ch.doc) {
        if (!ch.prev) continue
        records.push({ c: ch.c, id: ch.id })
        collect(ch.prev, fields) // id файлов - из документа до удаления
        continue
      }
      if (!ch.prev) continue
      for (const field of Object.keys(fields)) {
        const now = idsOf(ch.doc[field])
        for (const id of idsOf(ch.prev[field])) {
          if (now.includes(id)) continue
          const meta = db.peek(FILES, id) as FileMeta | null
          if (meta) metas.push(meta)
        }
      }
    }
    if (!metas.length && !records.length) return
    void (async () => {
      // Сначала метаданные (в транзакции), потом байты: если упадём между
      // шагами, останется файл без ссылки, а не ссылка без файла.
      await db.transaction(async (tx) => {
        for (const m of metas) {
          await tx.c[FILES]!.remove(m._id).catch((err) => {
            if (!(err instanceof NotFoundError)) throw err
          })
        }
        for (const r of records) await tx.c[FILES]!.removeMany({ recordId: r.id })
      }, { origin: 'system' })
      for (const r of records) await files.removeRecord(r.c, r.id)
      for (const m of metas) await files.removeOne(m)
    })().catch((err) => onError(err, 'файлы: уборка'))
  })
}

// Перенос файлов между хранилищами (design.md §16): локальная папка <-> S3.
// Идемпотентно: что уже лежит в целевом хранилище - пропускается. Источник не
// удаляется: сначала проверьте, что всё на месте, потом уберите руками.
export type MigrateReport = {
  total: number
  copied: number
  skipped: number
  bytes: number
  failed: Array<{ id: string; error: string }>
}

export async function migrateFiles(
  db: Db,
  from: FileStorage,
  to: FileStorage,
  opts: { dryRun?: boolean; batch?: number; onProgress?: (r: MigrateReport) => void } = {},
): Promise<MigrateReport> {
  const report: MigrateReport = { total: 0, copied: 0, skipped: 0, bytes: 0, failed: [] }
  const batch = opts.batch ?? 500
  let last = ''
  for (;;) {
    // Курсор по _id: _files может быть большим, листаем страницами
    const page = await db.c[FILES]!.find(last ? { _id: { $gt: last } } : {}, { sort: { _id: 1 }, limit: batch })
    if (!page.length) break
    for (const doc of page) {
      const meta = doc as unknown as FileMeta
      report.total++
      try {
        if (await to.head(meta)) {
          report.skipped++
          continue
        }
        if (opts.dryRun) {
          report.copied++
          report.bytes += meta.size
          continue
        }
        const bytes = await from.get(meta)
        await to.put(meta, bytes)
        report.copied++
        report.bytes += bytes.byteLength
      } catch (err) {
        report.failed.push({ id: meta._id, error: (err as Error).message })
      }
    }
    last = page[page.length - 1]!._id
    opts.onProgress?.(report)
  }
  return report
}

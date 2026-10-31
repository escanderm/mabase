// Файлы (design.md §16): поле-файл в коллекции, метаданные - в служебной
// _files, байты - в хранилище: локальная папка <dataDir>/files/... или S3.
//
// Файл пишется ДО транзакции, которая сохраняет запись и метаданные: откат
// транзакции удаляет файл, а падение между записью и коммитом оставляет
// сироту - это безопасно, на неё никто не ссылается.
import { createHash, createHmac } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from 'node:fs'
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
export interface FileStorage {
  put(meta: FileMeta, bytes: Uint8Array): Promise<void>
  get(meta: FileMeta): Promise<Uint8Array>
  delete(meta: FileMeta): Promise<void>
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

  async get(meta: FileMeta): Promise<Uint8Array> {
    return readFileSync(this.pathFor(meta))
  }

  async delete(meta: FileMeta): Promise<void> {
    try {
      unlinkSync(this.pathFor(meta))
    } catch {}
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
    const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
    if (this.opts.sessionToken) headers['x-amz-security-token'] = this.opts.sessionToken
    const names = Object.keys(headers).sort()
    const signed = names.join(';')
    const canonicalHeaders = names.map((k) => `${k}:${headers[k]}\n`).join('')
    const canonicalUri = path.split('/').map(encodeRfc3986).join('/')
    const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signed}\n${payloadHash}`
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.opts.secretAccessKey}`, date), this.opts.region), 's3'), 'aws4_request')
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
    return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${this.opts.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` }
  }

  private async request(method: string, key: string, body?: Uint8Array): Promise<Response> {
    const { url, host, path } = this.location(key)
    const payloadHash = sha256hex(body ?? new Uint8Array())
    const headers = this.sign(method, host, path, payloadHash)
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

  async get(meta: FileMeta): Promise<Uint8Array> {
    const res = await this.request('GET', this.key(meta))
    if (res.status === 404) throw new NotFoundError('файл', meta._id)
    return new Uint8Array(await res.arrayBuffer())
  }

  async delete(meta: FileMeta): Promise<void> {
    await this.request('DELETE', this.key(meta))
  }
}

// ---------- файлы поверх хранилища ----------

export class FileStore {
  constructor(
    readonly storage: FileStorage,
    readonly maxUpload = DEFAULT_MAX_FILE,
  ) {}

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

  async read(meta: FileMeta): Promise<Uint8Array> {
    return this.storage.get(meta)
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

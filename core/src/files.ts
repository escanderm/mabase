// Файлы (design.md §16): поле-файл в коллекции, метаданные - в служебной
// _files, байты - в <dataDir>/files/<collection>/<recordId>/<fileId>-<имя>.
//
// Файл пишется ДО транзакции, которая сохраняет запись и метаданные: откат
// транзакции удаляет файл, а падение между записью и коммитом оставляет
// сироту - это безопасно, на неё никто не ссылается.
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

export class FileStore {
  constructor(
    readonly root: string,
    readonly maxUpload = DEFAULT_MAX_FILE,
  ) {}

  recordDir(collection: string, recordId: string): string {
    return join(this.root, safeSegment(collection), safeSegment(recordId))
  }

  pathFor(meta: Pick<FileMeta, 'collection' | 'recordId' | '_id' | 'name'>): string {
    return join(this.recordDir(meta.collection, meta.recordId), `${safeSegment(meta._id)}-${safeSegment(meta.name)}`)
  }

  // Проверить и записать загруженные файлы. Возвращает значения полей документа
  // и метаданные для _files. Ошибка на любом файле - записанные удаляются.
  save(
    collection: string,
    recordId: string,
    fields: FileFields,
    uploads: Record<string, Upload[]>,
    now = Date.now(),
  ): { values: Record<string, string | string[]>; metas: FileMeta[] } {
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
          mkdirSync(this.recordDir(collection, recordId), { recursive: true })
          const fd = openSync(this.pathFor(meta), 'wx')
          try {
            writeSync(fd, up.bytes)
            fsyncSync(fd) // файл на диске раньше, чем запись о нём в логе
          } finally {
            closeSync(fd)
          }
          metas.push(meta)
          ids.push(meta._id)
        }
        values[field] = def.many ? ids : ids[0]!
      }
    } catch (err) {
      this.removeMany(metas)
      throw err
    }
    return { values, metas }
  }

  read(meta: FileMeta): Uint8Array {
    return readFileSync(this.pathFor(meta))
  }

  removeOne(meta: FileMeta): void {
    try {
      unlinkSync(this.pathFor(meta))
    } catch {}
  }

  removeMany(metas: FileMeta[]): void {
    for (const m of metas) this.removeOne(m)
  }

  removeRecord(collection: string, recordId: string): void {
    rmSync(this.recordDir(collection, recordId), { recursive: true, force: true })
  }
}

// Уборка после коммита: удалили запись - убрать её файлы; заменили файл -
// убрать старый. Метаданные в _files удаляются своей транзакцией, байты -
// следом. Ошибка уборки не отменяет уже сохранённое (как in after*).
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
    for (const ch of info.changes as readonly Change[]) {
      const fields = defs(ch.c)
      if (!fields) continue
      if (!ch.doc) {
        if (ch.prev) records.push({ c: ch.c, id: ch.id })
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
        for (const m of metas) await tx.c[FILES]!.remove(m._id).catch((err) => {
          if (!(err instanceof NotFoundError)) throw err
        })
        for (const r of records) await tx.c[FILES]!.removeMany({ recordId: r.id })
      }, { origin: 'system' })
      for (const r of records) files.removeRecord(r.c, r.id)
      for (const m of metas) files.removeOne(m)
    })().catch((err) => onError(err, 'файлы: уборка'))
  })
}

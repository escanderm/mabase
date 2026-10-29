// Формат на диске (SPEC §6):
//   CURRENT              - номер текущего поколения N
//   snapshot.<N>.jsonl   - снапшот на момент транзакции N
//   log.<N>.jsonl        - транзакции после N, одна строка = одна транзакция
import {
  closeSync,
  existsSync,
  statSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { crashPoint } from './crash'
import { CorruptionError, LockedError, ReadOnlyError } from './errors'
import type { Doc } from './query'

export type LogOp = { op: 'put'; c: string; doc: Doc } | { op: 'del'; c: string; id: string }
export type LogEntry = { tx: number; ts: number; ops: LogOp[] }
export type Data = Map<string, Map<string, Doc>>

const FORMAT_VERSION = 1
// Хранилище трогает только свои файлы. Всё остальное в папке ему безразлично.
const GEN_FILE = /^(snapshot|log)\.(\d+)\.jsonl(\.tmp)?$/
const STALE_EMPTY_LOCK_MS = 2000
const SNAPSHOT_CHUNK = 5000

const logHeader = (base: number) =>
  JSON.stringify({ format: 'mabase-log', version: FORMAT_VERSION, base }) + '\n'
const snapshotHeader = (tx: number) =>
  JSON.stringify({ format: 'mabase-snapshot', version: FORMAT_VERSION, tx }) + '\n'
const EMPTY_SNAPSHOT_0 = snapshotHeader(0) + JSON.stringify({ end: true, count: 0 }) + '\n'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err.code === 'EPERM' // процесс есть, но чужой
  }
}

export function applyToData(data: Data, ops: LogOp[]): void {
  for (const op of ops) {
    let coll = data.get(op.c)
    if (!coll) data.set(op.c, (coll = new Map()))
    if (op.op === 'put') coll.set(op.doc._id, op.doc)
    else coll.delete(op.id)
  }
}

async function writeAll(fh: FileHandle, buf: Uint8Array, position: number): Promise<void> {
  let off = 0
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, position + off)
    off += bytesWritten
  }
}

export class Disk {
  gen = 0
  logSize = 0
  snapshotSize = 0 // для порога компактирования: лог больше снапшота
  private fh: FileHandle | null = null
  private lockFd: number | null = null

  constructor(
    readonly dir: string,
    private fsync: boolean,
  ) {}

  private p(name: string): string {
    return join(this.dir, name)
  }

  private syncDir(): void {
    if (!this.fsync) return
    const fd = openSync(this.dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  // Записать файл целиком через .tmp + rename: после падения он либо старый, либо новый.
  private writeDurable(name: string, content: string): void {
    const tmp = this.p(name + '.tmp')
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, content)
      if (this.fsync) fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.p(name))
    this.syncDir()
  }

  async open(): Promise<{ data: Data; lastTx: number; droppedTailBytes: number }> {
    mkdirSync(this.dir, { recursive: true })
    this.acquireLock()
    try {
      if (!existsSync(this.p('CURRENT'))) this.initEmpty()

      const raw = readFileSync(this.p('CURRENT'), 'utf8')
      if (!/^\d+\n?$/.test(raw)) throw new CorruptionError(`CURRENT повреждён: ${JSON.stringify(raw)}`)
      const n = Number(raw.trim())
      this.checkNewerGenerations(n)
      this.gen = n

      const data = this.loadSnapshot(n)
      this.snapshotSize = statSync(this.p(`snapshot.${n}.jsonl`)).size
      const { lastTx, size, droppedTailBytes } = this.replayLog(n, data)
      this.cleanup(n)

      this.fh = await open(this.p(`log.${n}.jsonl`), 'r+')
      this.logSize = size
      return { data, lastTx, droppedTailBytes }
    } catch (err) {
      this.releaseLock()
      throw err
    }
  }

  // Один писатель на папку. Замок от умершего процесса (kill -9) забираем.
  private acquireLock(): void {
    const path = this.p('LOCK')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx')
        writeSync(fd, `${process.pid}\n`)
        this.lockFd = fd
        return
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err
      }
      const content = readFileSync(path, 'utf8').trim()
      const pid = Number(content)
      if (content === '') {
        // другой процесс только что создал замок и ещё не записал pid
        if (Date.now() - statSync(path).mtimeMs < STALE_EMPTY_LOCK_MS) throw new LockedError(path, null)
      } else if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
        throw new LockedError(path, pid)
      }
      unlinkSync(path)
    }
    throw new LockedError(path, null)
  }

  private releaseLock(): void {
    if (this.lockFd === null) return
    closeSync(this.lockFd)
    this.lockFd = null
    try {
      unlinkSync(this.p('LOCK'))
    } catch {}
  }

  private isPrefixOf(name: string, expected: string): boolean {
    const content = readFileSync(this.p(name), 'utf8')
    return expected.startsWith(content)
  }

  // Нет CURRENT: новая база или падение посреди её создания. Во втором случае в папке
  // лежат только недописанные пустые файлы поколения 0 - их можно перезаписать.
  // Если есть что-то с данными - ничего не удаляем и отказываемся стартовать.
  private initEmpty(): void {
    const own = readdirSync(this.dir).filter((f) => GEN_FILE.test(f) || f === 'CURRENT.tmp')
    const harmless = own.every((f) => {
      if (f === 'CURRENT.tmp') return this.isPrefixOf(f, '0\n')
      if (f.startsWith('snapshot.0.jsonl')) return this.isPrefixOf(f, EMPTY_SNAPSHOT_0)
      if (f.startsWith('log.0.jsonl')) return this.isPrefixOf(f, logHeader(0))
      return false
    })
    if (!harmless) {
      throw new CorruptionError(
        `Нет файла CURRENT, но есть файлы базы: ${own.join(', ')}. Ничего не удаляю. ` +
          'Если это ваша база - восстановите CURRENT (номер поколения), если нет - удалите файлы сами',
      )
    }
    this.writeDurable('snapshot.0.jsonl', EMPTY_SNAPSHOT_0)
    this.writeDurable('log.0.jsonl', logHeader(0))
    this.writeDurable('CURRENT', '0\n')
  }

  // Поколение новее CURRENT бывает только от прерванного компактирования - и тогда
  // в его логе нет транзакций. Если транзакции есть, CURRENT устарел (например, восстановлен
  // из бэкапа). Удалять такое поколение нельзя.
  private checkNewerGenerations(n: number): void {
    for (const f of readdirSync(this.dir)) {
      const m = GEN_FILE.exec(f)
      if (!m || m[1] !== 'log' || m[3] || Number(m[2]) <= n) continue
      if (!this.isPrefixOf(f, logHeader(Number(m[2])))) {
        throw new CorruptionError(
          `CURRENT указывает на поколение ${n}, но есть более новое ${f} с транзакциями. Ничего не удаляю`,
        )
      }
    }
  }

  private loadSnapshot(n: number): Data {
    const name = `snapshot.${n}.jsonl`
    const path = this.p(name)
    if (!existsSync(path)) throw new CorruptionError(`Нет снапшота ${name}`)
    const lines = readFileSync(path, 'utf8').split('\n')
    const bad = (why: string) => new CorruptionError(`Снапшот ${name} повреждён: ${why}`)

    let header: any
    try {
      header = JSON.parse(lines[0]!)
    } catch {
      throw bad('нет заголовка')
    }
    if (header.format !== 'mabase-snapshot' || header.version !== FORMAT_VERSION || header.tx !== n) {
      throw bad(`неверный заголовок ${lines[0]}`)
    }

    const data: Data = new Map()
    let count = 0
    let ended = false
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!
      if (line === '') {
        if (i !== lines.length - 1) throw bad(`пустая строка ${i + 1}`)
        continue
      }
      if (ended) throw bad(`данные после строки конца, строка ${i + 1}`)
      let rec: any
      try {
        rec = JSON.parse(line)
      } catch {
        throw bad(`строка ${i + 1} не читается`)
      }
      if (rec.end === true) {
        if (rec.count !== count) throw bad(`ожидалось ${rec.count} документов, прочитано ${count}`)
        ended = true
        continue
      }
      let coll = data.get(rec.c)
      if (!coll) data.set(rec.c, (coll = new Map()))
      coll.set(rec.doc._id, rec.doc)
      count++
    }
    if (!ended) throw bad('нет строки конца')
    return data
  }

  private replayLog(n: number, data: Data): { lastTx: number; size: number; droppedTailBytes: number } {
    const name = `log.${n}.jsonl`
    const path = this.p(name)
    if (!existsSync(path)) throw new CorruptionError(`Нет лога ${name}`)
    const buf = readFileSync(path)

    const firstNl = buf.indexOf(10)
    if (firstNl === -1) throw new CorruptionError(`Лог ${name}: нет заголовка`)
    let header: any
    try {
      header = JSON.parse(buf.toString('utf8', 0, firstNl))
    } catch {
      throw new CorruptionError(`Лог ${name}: заголовок не читается`)
    }
    if (header.format !== 'mabase-log' || header.version !== FORMAT_VERSION || header.base !== n) {
      throw new CorruptionError(`Лог ${name}: неверный заголовок`)
    }

    let pos = firstNl + 1
    let lineNo = 1
    let expected = n + 1
    let droppedTail = false
    while (pos < buf.length) {
      lineNo++
      const nl = buf.indexOf(10, pos)
      if (nl === -1) {
        // последняя строка без \n - запись оборвалась
        droppedTail = true
        break
      }
      let entry: LogEntry
      try {
        entry = JSON.parse(buf.toString('utf8', pos, nl))
      } catch {
        if (nl + 1 >= buf.length) {
          droppedTail = true
          break
        }
        throw new CorruptionError(`Лог ${name}: строка ${lineNo} повреждена, а после неё есть данные`)
      }
      if (entry.tx !== expected) {
        throw new CorruptionError(`Лог ${name}: строка ${lineNo} - ожидалась транзакция ${expected}, а там ${entry.tx}`)
      }
      applyToData(data, entry.ops)
      expected++
      pos = nl + 1
    }

    const droppedTailBytes = droppedTail ? buf.length - pos : 0
    if (droppedTail) {
      const fd = openSync(path, 'r+')
      try {
        ftruncateSync(fd, pos)
        if (this.fsync) fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    return { lastTx: expected - 1, size: pos, droppedTailBytes }
  }

  // Удалить старые поколения и свои *.tmp - мусор от компактирования.
  // Новые поколения здесь уже проверены: в них нет транзакций.
  private cleanup(n: number): void {
    let removed = false
    for (const f of readdirSync(this.dir)) {
      const m = GEN_FILE.exec(f)
      if ((m && (Number(m[2]) !== n || m[3])) || f === 'CURRENT.tmp') {
        unlinkSync(this.p(f))
        removed = true
      }
    }
    if (removed) this.syncDir()
  }

  // Дописать строку транзакции. При ошибке лог обрезается до прежней длины.
  async append(line: string): Promise<void> {
    const fh = this.fh!
    const buf = Buffer.from(line)
    const before = this.logSize
    try {
      crashPoint('log.beforeWrite')
      if (process.env.MB_FAIL_WRITE === '1') {
        // пишем половину строки и падаем - как будто кончилось место на диске
        await fh.write(buf, 0, buf.length >> 1, before)
        throw new Error('MB_FAIL_WRITE: имитация ошибки записи')
      }
      await writeAll(fh, buf, before)
      crashPoint('log.afterWriteBeforeFsync')
      if (this.fsync) await fh.datasync()
    } catch (err) {
      try {
        if (process.env.MB_FAIL_TRUNCATE === '1') throw new Error('MB_FAIL_TRUNCATE: имитация ошибки отката')
        await fh.truncate(before)
        if (this.fsync) await fh.datasync()
      } catch (truncErr) {
        throw new ReadOnlyError(truncErr)
      }
      throw err
    }
    this.logSize = before + buf.length
  }

  // Компактирование (SPEC §6.4). Вызывается, пока держится очередь записи.
  async compact(n: number, data: Data): Promise<boolean> {
    if (n === this.gen) return false
    const snapName = `snapshot.${n}.jsonl`
    const logName = `log.${n}.jsonl`

    const tmp = this.p(snapName + '.tmp')
    const sfh = await open(tmp, 'w')
    let snapshotBytes = 0
    try {
      let pos = 0
      const write = async (s: string) => {
        const b = Buffer.from(s)
        await writeAll(sfh, b, pos)
        pos += b.length
      }
      await write(snapshotHeader(n))
      let count = 0
      let chunk: string[] = []
      for (const [c, coll] of data) {
        for (const doc of coll.values()) {
          chunk.push(JSON.stringify({ c, doc }))
          count++
          if (chunk.length >= SNAPSHOT_CHUNK) {
            await write(chunk.join('\n') + '\n')
            chunk = []
          }
        }
      }
      if (chunk.length) await write(chunk.join('\n') + '\n')
      await write(JSON.stringify({ end: true, count }) + '\n')
      snapshotBytes = pos
      if (this.fsync) await sfh.sync()
    } finally {
      await sfh.close()
    }
    crashPoint('compact.afterSnapshotTmp')

    renameSync(tmp, this.p(snapName))
    this.syncDir()
    crashPoint('compact.afterSnapshotRename')

    const header = Buffer.from(logHeader(n))
    const newLog = await open(this.p(logName), 'w+')
    await writeAll(newLog, header, 0)
    if (this.fsync) await newLog.sync()
    this.syncDir()
    crashPoint('compact.afterNewLog')

    // точка переключения
    this.writeDurable('CURRENT', `${n}\n`)
    crashPoint('compact.afterCurrent')

    const oldGen = this.gen
    await this.fh!.close()
    this.fh = newLog
    this.gen = n
    this.logSize = header.length
    this.snapshotSize = snapshotBytes
    crashPoint('compact.beforeDeleteOld')

    for (const f of [`snapshot.${oldGen}.jsonl`, `log.${oldGen}.jsonl`]) {
      if (existsSync(this.p(f))) unlinkSync(this.p(f))
    }
    this.syncDir()
    return true
  }

  async close(): Promise<void> {
    await this.fh?.close()
    this.fh = null
    this.releaseLock()
  }
}

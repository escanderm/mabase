// mabase update - новая версия с GitHub Releases.
//
// - Берёт последний релиз: <api>/releases/latest.
// - Архив под эту ОС и процессор: mabase-<os>-<arch>.tar.gz.
// - Сверяет sha256 с checksums.txt того же релиза. Не совпало - ничего не меняем.
// - Новый бинарник пишется рядом и запускается с `version`. Не запустился
//   (чужая архитектура, битая подпись на macOS) - старый остаётся на месте.
// - Подмена через rename: запущенный сервер продолжает работать со старым
//   файлом, пока его не перезапустят. Данные (mb_data) не трогаем.
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const REPO = 'escanderm/mabase'
export const DEFAULT_API = `https://api.github.com/repos/${REPO}`

export type UpdateOptions = {
  current: string // версия этого бинарника
  exe: string // какой файл заменить
  api?: string // MABASE_UPDATE_URL или DEFAULT_API
  platform?: string // darwin-arm64, linux-x64 ...
  check?: boolean // только узнать, есть ли новая
  out?: (line: string) => void
}

export type UpdateResult = { current: string; latest: string; updated: boolean }

export const assetName = (platform: string) => `mabase-${platform}.tar.gz`

export async function update(o: UpdateOptions): Promise<UpdateResult> {
  const api = (o.api ?? DEFAULT_API).replace(/\/$/, '')
  const platform = o.platform ?? `${process.platform}-${process.arch}`
  const out = o.out ?? console.log
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `mabase/${o.current}` }

  const res = await fetch(`${api}/releases/latest`, { headers })
  if (res.status === 404) throw new Error(`в ${api} нет ни одного релиза`)
  if (!res.ok) throw new Error(`GitHub ответил ${res.status} на ${api}/releases/latest`)
  const rel = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] }
  const latest = rel.tag_name.replace(/^v/, '')
  const result = { current: o.current, latest, updated: false }

  if (compareVersions(latest, o.current) <= 0) {
    out(`У вас последняя версия: ${o.current}`)
    return result
  }
  if (o.check) {
    out(`Есть новая версия: ${o.current} -> ${latest}. Обновить: mabase update`)
    return result
  }

  const name = assetName(platform)
  const asset = rel.assets.find((a) => a.name === name)
  const sums = rel.assets.find((a) => a.name === 'checksums.txt')
  if (!asset) throw new Error(`в релизе ${rel.tag_name} нет сборки ${name}`)
  if (!sums) throw new Error(`в релизе ${rel.tag_name} нет checksums.txt`)

  out(`Скачиваю ${name} (${rel.tag_name})...`)
  const [archive, sumsText] = await Promise.all([download(asset.browser_download_url, headers), download(sums.browser_download_url, headers).then((b) => new TextDecoder().decode(b))])
  const want = sumsText.split('\n').map((l) => l.trim().split(/\s+\*?/)).find(([, file]) => file === name)?.[0]
  if (!want) throw new Error(`в checksums.txt нет строки для ${name}`)
  const got = new Bun.CryptoHasher('sha256').update(archive).digest('hex')
  if (got !== want.toLowerCase()) throw new Error(`контрольная сумма ${name} не совпала: архив повреждён или подменён. Ничего не изменено`)

  const bin = untarFile(Bun.gunzipSync(archive), 'mabase')
  if (!bin) throw new Error(`в ${name} нет файла mabase`)

  // Рядом с exe: rename работает только в пределах одного диска
  const tmp = join(dirname(o.exe), `.${basename(o.exe)}.new-${process.pid}`)
  try {
    try {
      writeFileSync(tmp, bin, { mode: 0o755 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') throw new Error(`нет прав на запись в ${dirname(o.exe)}: запустите от владельца файла или через sudo`)
      throw err
    }
    chmodSync(tmp, 0o755)
    // Чужой формат файла - не код возврата, а исключение (ENOEXEC)
    let said = ''
    let code: number | string
    try {
      const check = Bun.spawnSync([tmp, 'version'], { stdout: 'pipe', stderr: 'pipe' })
      said = check.stdout.toString().trim()
      code = check.exitCode
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code ?? String(err)
    }
    if (code !== 0 || said !== latest) throw new Error(`новый бинарник не запустился (${code}${said ? `, ответил "${said}"` : ''}). Ничего не изменено`)
    renameSync(tmp, o.exe)
  } finally {
    rmSync(tmp, { force: true })
  }
  out(`Готово: ${o.current} -> ${latest} (${o.exe})`)
  return { ...result, updated: true }
}

async function download(url: string, headers: Record<string, string>): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { ...headers, Accept: 'application/octet-stream' } })
  if (!res.ok) throw new Error(`не скачался ${url}: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

// 0.10.0 > 0.9.1; суффиксы вроде -rc1 не сравниваем: latest их не отдаёт.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number)
  const pb = b.split(/[.-]/).map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return Math.sign(d)
  }
  return 0
}

// tar: заголовки по 512 байт, имя - первые 100, размер - восьмеричное число
// в 124..136, тип - байт 156. Длинные имена (pax, prefix) не нужны: в нашем
// архиве три файла с короткими именами.
const dec = new TextDecoder()
const field = (b: Uint8Array, from: number, len: number) => dec.decode(b.subarray(from, from + len)).replace(/\0[\s\S]*$/, '')

export function untarFile(tar: Uint8Array, name: string): Uint8Array | null {
  for (let off = 0; off + 512 <= tar.length; ) {
    const entry = field(tar, off, 100)
    if (!entry) return null // нулевой блок - конец архива
    const size = parseInt(field(tar, off + 124, 12).trim() || '0', 8)
    const type = field(tar, off + 156, 1)
    off += 512
    if ((type === '0' || type === '') && entry.replace(/^\.\//, '') === name) return tar.slice(off, off + size)
    off += Math.ceil(size / 512) * 512
  }
  return null
}

export type TarEntry = { name: string; data: Uint8Array; mode: number }

// Пишем архив сами, а не системным tar: на macOS он добавляет ._-файлы и
// xattr, и GNU tar на Linux потом ругается на них при распаковке.
export function tar(entries: TarEntry[], mtime = Math.floor(Date.now() / 1000)): Uint8Array {
  const enc = new TextEncoder()
  const blocks: Uint8Array[] = []
  for (const e of entries) {
    const h = new Uint8Array(512)
    const put = (s: string, at: number) => h.set(enc.encode(s), at)
    const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0')
    put(e.name, 0)
    put(octal(e.mode, 8), 100)
    put(octal(0, 8), 108) // uid
    put(octal(0, 8), 116) // gid
    put(octal(e.data.length, 12), 124)
    put(octal(mtime, 12), 136)
    put('        ', 148) // место под сумму считается пробелами
    put('0', 156)
    put('ustar\x0000', 257)
    put(`${octal(h.reduce((s, b) => s + b, 0), 7)}\0 `, 148)
    blocks.push(h, e.data, new Uint8Array((512 - (e.data.length % 512)) % 512))
  }
  blocks.push(new Uint8Array(1024))
  const all = new Uint8Array(blocks.reduce((s, b) => s + b.length, 0))
  let at = 0
  for (const b of blocks) {
    all.set(b, at)
    at += b.length
  }
  return all
}

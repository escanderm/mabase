// mabase update: релиз с GitHub, проверка суммы, пробный запуск, подмена.
// GitHub подменён локальным сервером с тем же форматом ответа.
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assetName, compareVersions, tar, untarFile, update } from '../src/update'
import { tmpDir } from './helpers'

const PLATFORM = 'test-arch'
const script = (version: string) => new TextEncoder().encode(`#!/bin/sh\necho ${version}\n`)
const sha = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b as unknown as Uint8Array<ArrayBuffer>).digest('hex')

type Release = { tag: string; bin?: Uint8Array; sum?: string; noAsset?: boolean }

function fakeGitHub(rel: Release | null) {
  const archive = rel?.bin && Bun.gzipSync(tar([{ name: 'mabase', data: rel.bin, mode: 0o755 }, { name: 'LICENSE', data: new Uint8Array([77]), mode: 0o644 }]) as unknown as Uint8Array<ArrayBuffer>)
  const name = assetName(PLATFORM)
  // server.url нужен внутри fetch - объявляем заранее, иначе tsc видит
  // самоссылку и требует any
  let server: { url: URL; stop: (closeActiveConnections?: boolean) => void }
  server = Bun.serve({
    port: 0,
    fetch(req: Request): Response | Promise<Response> {
      const { pathname } = new URL(req.url)
      if (pathname === '/repos/x/releases/latest') {
        if (!rel) return Response.json({ message: 'Not Found' }, { status: 404 })
        const assets: Array<{ name: string; browser_download_url: string }> = rel.noAsset ? [] : [{ name, browser_download_url: `${server.url}dl/${name}` }]
        assets.push({ name: 'checksums.txt', browser_download_url: `${server.url}dl/checksums.txt` })
        return Response.json({ tag_name: rel.tag, assets })
      }
      if (pathname === `/dl/${name}`) return new Response(archive)
      if (pathname === '/dl/checksums.txt') return new Response(`${'0'.repeat(64)}  other.tar.gz\n${rel?.sum ?? sha(archive!)}  ${name}\n`)
      return new Response('нет', { status: 404 })
    },
  })
  return { api: `${server.url}repos/x`, stop: () => server.stop(true) }
}

function exe(version = '0.1.0'): string {
  const dir = tmpDir('update')
  const file = join(dir, 'mabase')
  writeFileSync(file, script(version))
  chmodSync(file, 0o755)
  return file
}

const run = (file: string) => Bun.spawnSync([file, 'version']).stdout.toString().trim()

describe('mabase update', () => {
  test('122. tar: свой архив читает системный tar (режим 755 сохраняется), архив системного tar читает untarFile', async () => {
    const dir = tmpDir('tar')
    const data = new Uint8Array(1500).map((_, i) => i % 251)
    writeFileSync(join(dir, 'a.tar'), tar([{ name: 'mabase', data, mode: 0o755 }, { name: 'README.md', data: new TextEncoder().encode('привет'), mode: 0o644 }]))
    const list = Bun.spawnSync(['tar', '-tf', join(dir, 'a.tar')], { stderr: 'pipe' })
    expect(list.stderr.toString()).toBe('')
    expect(list.stdout.toString().trim().split('\n')).toEqual(['mabase', 'README.md'])
    mkdirSync(join(dir, 'x'))
    expect(Bun.spawnSync(['tar', '-xf', join(dir, 'a.tar'), '-C', join(dir, 'x')]).exitCode).toBe(0)
    expect(readFileSync(join(dir, 'x', 'mabase'))).toEqual(Buffer.from(data))
    expect(statSync(join(dir, 'x', 'mabase')).mode & 0o777).toBe(0o755)
    expect(readFileSync(join(dir, 'x', 'README.md'), 'utf8')).toBe('привет')

    // обратно: архив системного tar, файл не первый
    expect(Bun.spawnSync(['tar', '-cf', join(dir, 'b.tar'), '-C', join(dir, 'x'), 'README.md', 'mabase'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).exitCode).toBe(0)
    expect(untarFile(readFileSync(join(dir, 'b.tar')), 'mabase')).toEqual(data)
    expect(untarFile(readFileSync(join(dir, 'b.tar')), 'nope')).toBeNull()
  })

  test('123. новая версия: скачать, сверить сумму, запустить, подменить; та же версия и --check ничего не меняют', async () => {
    const gh = fakeGitHub({ tag: 'v0.2.0', bin: script('0.2.0') })
    const lines: string[] = []
    const out = (l: string) => lines.push(l)
    try {
      const file = exe('0.1.0')
      const checked = await update({ current: '0.1.0', exe: file, api: gh.api, platform: PLATFORM, check: true, out })
      expect(checked).toEqual({ current: '0.1.0', latest: '0.2.0', updated: false })
      expect(run(file)).toBe('0.1.0')
      expect(lines.at(-1)).toContain('0.1.0 -> 0.2.0')

      const r = await update({ current: '0.1.0', exe: file, api: gh.api, platform: PLATFORM, out })
      expect(r.updated).toBe(true)
      expect(run(file)).toBe('0.2.0')
      expect(statSync(file).mode & 0o777).toBe(0o755)
      expect(readdirSync(join(file, '..'))).toEqual(['mabase']) // временный файл убран

      // уже свежая или даже новее релиза - ничего не делаем
      for (const current of ['0.2.0', '0.10.0']) {
        const same = await update({ current, exe: file, api: gh.api, platform: PLATFORM, out })
        expect(same.updated).toBe(false)
        expect(lines.at(-1)).toBe(`У вас последняя версия: ${current}`)
      }
    } finally {
      gh.stop()
    }
  })

  test('124. отказ без последствий: сумма не та, нет сборки под платформу, бинарник не запускается, релизов нет', async () => {
    const cases: [Release | null, RegExp][] = [
      [{ tag: 'v0.2.0', bin: script('0.2.0'), sum: 'ab'.repeat(32) }, /контрольная сумма/],
      [{ tag: 'v0.2.0', bin: script('0.2.0'), noAsset: true }, /нет сборки mabase-test-arch\.tar\.gz/],
      [{ tag: 'v0.2.0', bin: script('0.1.9') }, /не запустился.*0\.1\.9/],
      [{ tag: 'v0.2.0', bin: new TextEncoder().encode('\x7fELF мусор') }, /не запустился/],
      [null, /нет ни одного релиза/],
    ]
    for (const [rel, error] of cases) {
      const gh = fakeGitHub(rel)
      try {
        const file = exe('0.1.0')
        await expect(update({ current: '0.1.0', exe: file, api: gh.api, platform: PLATFORM, out: () => {} })).rejects.toThrow(error)
        expect(run(file)).toBe('0.1.0')
        expect(readdirSync(join(file, '..'))).toEqual(['mabase'])
      } finally {
        gh.stop()
      }
    }
  })

  test('125. сравнение версий - по числам, а не строкам', () => {
    expect(compareVersions('0.10.0', '0.9.1')).toBe(1)
    expect(compareVersions('1.0.0', '1.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1)
  })
})

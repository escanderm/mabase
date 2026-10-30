// Сборка бинарника.
//
//   bun run build    -> dist/mabase под эту машину
//   bun run release  -> dist/release/: mabase-<os>-<arch>.tar.gz под все
//                       платформы и checksums.txt (их берёт mabase update)
//
// На macOS Bun 1.3.12 оставляет битую подпись - бинарник убивается системой
// (exit 137). Подпись снимается и ставится заново (прототип 01). Поэтому
// релиз собирается только на macOS: на Linux подписать нечем.
//
// Среду Bun под чужую платформу сборка скачивает сама. Если сеть рвётся -
// положите готовые бинарники bun в папку BUN_TARGETS_DIR под именами целей
// (bun-linux-arm64 и т.д.).
import { $ } from 'bun'

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION } from './src/cli'
import { buildSdk } from './src/sdk'
import { assetName, tar } from './src/update'

// x64 - baseline: дешёвые VPS часто отдают процессор без AVX2, Rosetta - тоже
const TARGETS: Record<string, string> = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64-baseline',
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
}

const release = process.argv.includes('--release')
const tag = process.env.GITHUB_REF_NAME
if (release && tag?.startsWith('v') && tag !== `v${VERSION}`) throw new Error(`тег ${tag}, а в cli.ts VERSION = ${VERSION}`)
if (release && process.platform !== 'darwin') throw new Error('релиз собирается на macOS: сборки под macOS нужно переподписать')

// SDK для /api/client.js - внутрь бинарника
const sdk = await buildSdk()
mkdirSync('src/generated', { recursive: true })
writeFileSync('src/generated/client.ts', `// Сгенерировано build.ts - не править\nexport default ${JSON.stringify(sdk)}\n`)
await Bun.write('dist/client.js', sdk)

async function compile(out: string, target?: string): Promise<void> {
  const local = target && process.env.BUN_TARGETS_DIR && join(process.env.BUN_TARGETS_DIR, target)
  const flags = !target ? [] : local && existsSync(local) ? [`--target=${target}`, `--compile-executable-path=${local}`] : [`--target=${target}`]
  await $`bun build --compile --minify ${flags} src/cli.ts --outfile ${out}`.quiet()
  if (target ? target.startsWith('bun-darwin') : process.platform === 'darwin') {
    await $`codesign --remove-signature ${out}`
    await $`codesign -s - ${out}`
  }
}

if (!release) {
  await compile('dist/mabase')
  console.log('Готово: dist/mabase')
  process.exit(0)
}

const dir = 'dist/release'
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const docs = ['LICENSE', 'README.md'].map((f) => ({ name: f, data: readFileSync(`../${f}`), mode: 0o644 }))
const sums: string[] = []
for (const [platform, target] of Object.entries(TARGETS)) {
  const bin = `${dir}/${platform}/mabase`
  await compile(bin, target)
  const archive = Bun.gzipSync(tar([{ name: 'mabase', data: readFileSync(bin), mode: 0o755 }, ...docs]))
  const name = assetName(platform)
  writeFileSync(`${dir}/${name}`, archive)
  sums.push(`${new Bun.CryptoHasher('sha256').update(archive).digest('hex')}  ${name}`)
  console.log(`${name}: ${(archive.length / 1e6).toFixed(1)} МБ`)
}
writeFileSync(`${dir}/checksums.txt`, sums.join('\n') + '\n')
console.log(`Готово: ${dir}, версия ${VERSION}`)

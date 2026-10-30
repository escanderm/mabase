// Сборка бинарника: bun run build -> dist/mabase.
// На macOS Bun 1.3.12 оставляет битую подпись - бинарник убивается системой
// (exit 137). Подпись снимается и ставится заново (прототип 01).
import { $ } from 'bun'

import { mkdirSync, writeFileSync } from 'node:fs'
import { buildSdk } from './src/sdk'

// SDK для /api/client.js - внутрь бинарника
const sdk = await buildSdk()
mkdirSync('src/generated', { recursive: true })
writeFileSync('src/generated/client.ts', `// Сгенерировано build.ts - не править\nexport default ${JSON.stringify(sdk)}\n`)
await Bun.write('dist/client.js', sdk)

const out = 'dist/mabase'
await $`bun build --compile --minify src/cli.ts --outfile ${out}`
if (process.platform === 'darwin') {
  await $`codesign --remove-signature ${out}`
  await $`codesign -s - ${out}`
}
console.log(`Готово: ${out}`)

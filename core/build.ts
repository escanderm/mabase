// Сборка бинарника: bun run build -> dist/mabase.
// На macOS Bun 1.3.12 оставляет битую подпись - бинарник убивается системой
// (exit 137). Подпись снимается и ставится заново (прототип 01).
import { $ } from 'bun'

const out = 'dist/mabase'
await $`bun build --compile --minify src/cli.ts --outfile ${out}`
if (process.platform === 'darwin') {
  await $`codesign --remove-signature ${out}`
  await $`codesign -s - ${out}`
}
console.log(`Готово: ${out}`)

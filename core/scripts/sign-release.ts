// Подпись релиза: checksums.txt.sig рядом с checksums.txt (design.md §20).
//
//   MABASE_RELEASE_PRIVATE_KEY=... bun scripts/sign-release.ts [dist/release/checksums.txt]
//
// Нет ключа - предупреждение и код 0: форк без секрета не должен ломать релиз,
// но и подписи у него не будет (mabase update у сборок с вшитым ключом такую
// загрузку отвергнет).
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex') // префикс DER для seed
const file = process.argv[2] ?? 'dist/release/checksums.txt'
const seed = process.env.MABASE_RELEASE_PRIVATE_KEY

if (!seed) {
  console.warn('MABASE_RELEASE_PRIVATE_KEY не задан: checksums.txt.sig не создан')
  process.exit(0)
}
const raw = Buffer.from(seed, 'base64')
if (raw.length !== 32) throw new Error('MABASE_RELEASE_PRIVATE_KEY: ожидаются 32 байта seed в base64')
const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw]), format: 'der', type: 'pkcs8' })
const data = readFileSync(file)
writeFileSync(`${file}.sig`, sign(null, data, key).toString('base64') + '\n')
console.log(`подписано: ${file}.sig`)

// Ключи подписи релизов: Ed25519.
//
//   bun scripts/keygen.ts > release-keys.env
//
// В release-keys.env будут две строки:
//   MABASE_RELEASE_PUBLIC_KEY=...   - в переменные репозитория (это не секрет)
//   MABASE_RELEASE_PRIVATE_KEY=...  - в секреты репозитория (никому не показывать)
//
// Приватный ключ - 32 байта seed в base64. Потеряли - подпись прошлых релизов
// больше не проверить (ключ вшит в бинарники), придётся менять ключ в новой
// версии, а старые обновления будут отказываться ставиться.
import { generateKeyPairSync } from 'node:crypto'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
// DER Ed25519: SPKI кончается 32 байтами открытого ключа, PKCS8 - 32 байтами seed
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64')
console.log(`MABASE_RELEASE_PUBLIC_KEY=${pub}`)
console.log(`MABASE_RELEASE_PRIVATE_KEY=${seed}`)

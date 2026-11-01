// Генерация артефактов, которые вшиваются в бинарник: SDK, скрипт админки,
// типы zod и публичный ключ подписи. Они лежат в src/generated/ и в git не
// попадают, поэтому в чистом клоне их нет - без генерации падают и tsc, и
// тесты (сервер импортирует generated/client и generated/admin).
//
// build.ts зовёт generate() перед компиляцией; scripts/generate.ts - перед
// typecheck и тестами (см. package.json).
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildAdmin } from './admin/bundle'
import { buildSdk } from './sdk'

const HEADER = '// Сгенерировано generate.ts - не править\n'

// .d.ts из node_modules/zod: в бинарнике node_modules нет, поэтому файлы
// вшиваются целиком (editor.ts пишет их в mb_data/types/zod).
export function readZodTypes(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const next = rel ? `${rel}/${name}` : name
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs, next)
      else if (name.endsWith('.d.ts')) out[next] = readFileSync(abs, 'utf8')
    }
  }
  walk(root, '')
  return out
}

export async function generate(): Promise<{ sdk: string }> {
  mkdirSync('src/generated', { recursive: true })
  const sdk = await buildSdk()
  writeFileSync('src/generated/client.ts', `${HEADER}export default ${JSON.stringify(sdk)}\n`)
  writeFileSync('src/generated/admin.ts', `${HEADER}export default ${JSON.stringify(await buildAdmin())}\n`)
  const zod = readZodTypes(join(import.meta.dir, '..', 'node_modules', 'zod'))
  writeFileSync('src/generated/zod-types.ts', `${HEADER}export default ${JSON.stringify(zod)} as Record<string, string>\n`)
  writeFileSync(
    'src/generated/release.ts',
    `${HEADER}export const RELEASE_PUBLIC_KEY = ${JSON.stringify(process.env.MABASE_RELEASE_PUBLIC_KEY ?? '')}\n`,
  )
  return { sdk }
}

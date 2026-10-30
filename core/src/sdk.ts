// SDK для браузера, который отдаёт сервер: GET /api/client.js. Фронтенду не
// нужны ни npm, ни сборщик: import { createClient } from '/api/client.js'.
//
// В бинарнике сборка SDK вшита (build.ts кладёт её в generated/client.ts до
// компиляции). Из исходников - собирается при первом запросе.
let cached: Promise<string> | null = null

// Внутри бинарника файлы лежат в виртуальной /$bunfs/. Из исходников
// собираем всегда: вшитая копия могла устареть после правки client.ts.
const compiled = import.meta.url.includes('$bunfs')

export function sdkBundle(): Promise<string> {
  return (cached ??= compiled ? import('./generated/client').then((m) => m.default as string) : buildSdk())
}

export async function buildSdk(): Promise<string> {
  const r = await Bun.build({ entrypoints: [new URL('./client.ts', import.meta.url).pathname], target: 'browser', minify: true })
  if (!r.success) throw new Error(`SDK не собрался: ${r.logs.join('\n')}`)
  return r.outputs[0]!.text()
}

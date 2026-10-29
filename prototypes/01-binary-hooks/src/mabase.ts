// Прототип: может ли бинарник из `bun build --compile` подгружать внешние
// .ts-хуки, отдавать им свой API как модуль 'mabase' и свою копию zod.
import { plugin } from 'bun'
import { z } from 'zod'
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

type Handler = (data: unknown) => unknown | Promise<unknown>
const handlers = new Map<string, Handler[]>()
const schemas: { name: string; schema: unknown }[] = []

const api = {
  z,
  version: '0.0.1-proto',
  on(event: string, fn: Handler) {
    handlers.set(event, [...(handlers.get(event) ?? []), fn])
  },
  async emit(event: string, data: unknown) {
    for (const fn of handlers.get(event) ?? []) await fn(data)
  },
  defineCollection(name: string, opts: { schema: unknown }) {
    schemas.push({ name, schema: opts.schema })
  },
}

// Виртуальный модуль: `import { on, z } from 'mabase'` в хуке получает объекты
// из бинарника, без node_modules.
plugin({
  name: 'mabase-virtual',
  setup(build) {
    build.module('mabase', () => ({ exports: api, loader: 'object' }))
  },
})

const root = process.cwd()
const dataDir = join(root, 'mb_data')
if (!existsSync(dataDir)) mkdirSync(dataDir)
writeFileSync(
  join(dataDir, 'types.d.ts'),
  `declare module 'mabase' {
  export const z: typeof import('zod').z
  export const version: string
  export function on(event: string, fn: (data: any) => unknown): void
  export function emit(event: string, data: unknown): Promise<void>
  export function defineCollection(name: string, opts: { schema: unknown }): void
}
`,
)

const hooksDir = resolve(root, 'mb_hooks')
const files = readdirSync(hooksDir).filter((f) => f.endsWith('.ts')).sort()
console.log(`[mabase] runtime: bun ${Bun.version}, hooks: ${files.join(', ')}`)

for (const f of files) {
  const t = performance.now()
  try {
    await import(join(hooksDir, f))
    console.log(`[mabase] loaded ${f} in ${(performance.now() - t).toFixed(1)}ms`)
  } catch (e) {
    console.log(`[mabase] FAILED ${f}: ${(e as Error).message}`)
  }
}

for (const { name, schema } of schemas) {
  console.log(
    `[mabase] collection ${name}: schema instanceof binary zod = ${schema instanceof z.ZodType}`,
  )
}

await api.emit('user.online', { userId: 'u1' })
console.log('[mabase] done')

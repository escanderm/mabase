// Тесты 176-178: типы для редактора (design.md §5). Бинарник кладёт в папку
// данных types.d.ts и типы zod рядом, чтобы конфиг и хуки подсказывались без
// node_modules; второй запуск ничего не переписывает.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { editorFiles, writeEditorTypes } from '../src/editor'
import { startServer } from '../src/server'
import { tmpDir } from './helpers'

describe('типы для редактора', () => {
  test('176. types.d.ts и типы zod пишутся в папку данных; повторно - только изменения', async () => {
    const dir = tmpDir('types')
    const first = await writeEditorTypes(dir)
    expect(first.total).toBeGreaterThan(100) // сам файл + .d.ts из zod
    expect(first.written).toBe(first.total)

    const main = readFileSync(join(dir, 'types.d.ts'), 'utf8')
    expect(main).toContain("declare module 'mabase'")
    expect(main).toContain("./types/zod/index.js") // z берётся из настоящих типов zod
    expect(readFileSync(join(dir, 'types/zod/index.d.ts'), 'utf8')).toContain('export')
    expect(readFileSync(join(dir, 'types/zod/v4/classic/schemas.d.ts'), 'utf8')).toContain('export')

    // второй запуск ничего не пишет: редактор не должен видеть мигание файлов
    expect((await writeEditorTypes(dir)).written).toBe(0)

    // а испорченный файл - перезаписывается
    writeFileSync(join(dir, 'types.d.ts'), 'испорчено')
    expect((await writeEditorTypes(dir)).written).toBe(1)
    expect(readFileSync(join(dir, 'types.d.ts'), 'utf8')).toContain("declare module 'mabase'")
  })

  test('177. сервер пишет типы при старте', async () => {
    const dataDir = tmpDir('types-srv')
    const s = await startServer({ dataDir, port: 0, hostname: '127.0.0.1', env: {}, onWarning: () => {}, db: { fsync: false } })
    try {
      expect(existsSync(join(dataDir, 'types.d.ts'))).toBe(true)
      expect(existsSync(join(dataDir, 'types', 'zod', 'index.d.ts'))).toBe(true)
      expect(existsSync(join(dataDir, 'types', 'zod', 'v4', 'classic', 'external.d.ts'))).toBe(true)
    } finally {
      await s.stop()
    }
  })

  test('178. в types.d.ts есть все публичные имена модуля mabase', async () => {
    const main = (await editorFiles())['types.d.ts']!
    for (const name of [
      'defineCollection',
      'defineConfig',
      'defineAction',
      'defineSeed',
      'export function on',
      'export const mail',
      'class ActionError',
      'ActionErrorCode',
      'export const z',
      'type Db',
      'type Hooks',
      'type Rules',
      'files?: Record<string, FileField>',
      'origin: Origin',
      "declare module 'mabase/client'",
      'createClient<Config',
      'TypedClient',
    ]) {
      expect(main).toContain(name)
    }
  })
})

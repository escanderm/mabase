// Тесты 187-190: горячая перезагрузка хуков (design.md §5, §20).
// 187 - reloadHooks заменяет регистрации и откатывается на ошибке;
// 188 - сервер после перезагрузки вызывает новый обработчик и ставит cron;
// 189 - watcher сам замечает правку и удаление файла;
// 190 - CLI передаёт папку хуков в конфиг сервера.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as api from '../src/api'
import { listHooks, reloadHooks } from '../src/hooks'
import { loadProject } from '../src/cli'
import { startServer } from '../src/server'
import { sleep, tmpDir, waitFor } from './helpers'

const API = new URL('../src/api.ts', import.meta.url).pathname
const hook = (body: string) => `import { on } from ${JSON.stringify(API)}\n${body}\n`
const seen = () => ((globalThis as any).__hooksSeen ??= [] as string[]) as string[]
const reset = () => {
  api.resetHooks()
  ;(globalThis as any).__hooksSeen = []
}

describe('перезагрузка хуков', () => {
  test('187. заменяет обработчики целиком; битый файл - откат к прежним', async () => {
    reset()
    const dir = tmpDir('hooks')
    const a = join(dir, 'a.ts')
    writeFileSync(a, hook(`on('x', async () => { (globalThis as any).__hooksSeen.push('x') })`))
    expect(await reloadHooks(dir)).toEqual({ files: 1, handlers: 1, schedules: 0 })
    expect([...api.eventHandlers().keys()]).toEqual(['x'])

    // правим тот же файл: старый обработчик исчезает
    writeFileSync(a, hook(`on('y', async () => { (globalThis as any).__hooksSeen.push('y') })`))
    expect(await reloadHooks(dir)).toEqual({ files: 1, handlers: 1, schedules: 0 })
    expect([...api.eventHandlers().keys()]).toEqual(['y'])

    // ломаем файл: прежние обработчики продолжают работать
    writeFileSync(a, `throw new Error('не компилируется')`)
    expect(await reloadHooks(dir).catch((e) => e.message)).toContain('не компилируется')
    expect([...api.eventHandlers().keys()]).toEqual(['y'])

    // добавили второй файл - оба работают
    writeFileSync(a, hook(`on('y', async () => {})`))
    writeFileSync(join(dir, 'b.ts'), hook(`on('z', async () => {})`))
    expect(await reloadHooks(dir)).toEqual({ files: 2, handlers: 2, schedules: 0 })
    expect([...api.eventHandlers().keys()].sort()).toEqual(['y', 'z'])
    reset()
  })

  test('188. сервер: reloadHooks подхватывает обработчик и cron-задачу', async () => {
    reset()
    const root = tmpDir('hooks-srv')
    const dir = join(root, 'mb_hooks')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.ts'), hook(`on('ping', async () => { (globalThis as any).__hooksSeen.push('ping') })`))

    const s = await startServer({
      dataDir: join(root, 'mb_data'),
      port: 0,
      hostname: '127.0.0.1',
      env: {},
      onWarning: () => {},
      db: { fsync: false },
      handlers: () => api.eventHandlers(),
      hooksDir: dir,
      watchHooks: false,
    })
    try {
      expect(await s.reloadHooks()).toEqual({ files: 1, handlers: 1, schedules: 0 })
      await s.db.transaction((tx) => tx.emit('ping', { a: 1 }))
      await waitFor(() => seen().includes('ping'), 2000)

      // добавили периодическую задачу - после перезагрузки она в _scheduled
      writeFileSync(
        join(dir, 'b.ts'),
        hook(`import { schedule } from ${JSON.stringify(API)}\nschedule('digest.daily', '0 9 * * *')\non('digest.daily', async () => {})`),
      )
      expect(await s.reloadHooks()).toMatchObject({ files: 2, schedules: 1 })
      const task = await s.db.c._scheduled!.findOne({ key: 'cron:digest.daily' })
      expect(task).toMatchObject({ event: 'digest.daily', cron: '0 9 * * *' })
    } finally {
      await s.stop()
    }
    reset()
  }, 30_000)

  test('189. watcher: правка и удаление файла подхватываются сами', async () => {
    reset()
    const root = tmpDir('hooks-watch')
    const dir = join(root, 'mb_hooks')
    mkdirSync(dir, { recursive: true })
    const s = await startServer({
      dataDir: join(root, 'mb_data'),
      port: 0,
      hostname: '127.0.0.1',
      env: {},
      onWarning: () => {},
      db: { fsync: false },
      handlers: () => api.eventHandlers(),
      hooksDir: dir,
      watchHooks: true,
    })
    try {
      const file = join(dir, 'w.ts')
      writeFileSync(file, hook(`on('watched', async () => {})`))
      await waitFor(() => api.eventHandlers().has('watched'), 5000)

      await sleep(200)
      unlinkSync(file)
      await waitFor(() => !api.eventHandlers().has('watched'), 5000)
    } finally {
      await s.stop()
      rmSync(dir, { recursive: true, force: true })
    }
    reset()
  }, 30_000)

  test('190. CLI: папка хуков попадает в конфиг сервера', async () => {
    reset()
    const root = tmpDir('hooks-cli')
    writeFileSync(join(root, 'mabase.config.ts'), `import { defineConfig } from 'mabase'\nexport default defineConfig({})`)
    mkdirSync(join(root, 'mb_hooks'))
    writeFileSync(join(root, 'mb_hooks', 'a.ts'), `import { on } from 'mabase'\non('boot', async () => {})`)

    const { config, hooks } = await loadProject({ root, dir: join(root, 'mb_data'), port: 0, dev: false, check: false })
    expect(hooks).toEqual(['a.ts'])
    expect(config.hooksDir).toBe(join(root, 'mb_hooks'))
    expect(config.watchHooks).toBeUndefined() // по умолчанию включено, если папка задана
    expect(listHooks(join(root, 'mb_hooks'))).toEqual(['a.ts'])
    reset()
  })
})

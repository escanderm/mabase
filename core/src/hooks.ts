// Хуки: загрузка mb_hooks/*.ts и горячая перезагрузка (design.md §5, §20).
//
// Перезагрузка - это заново импортировать все файлы папки: обработчики on() и
// задачи schedule() собираются заново, поэтому удалённый файл перестаёт
// работать, а не копит старые регистрации. Файлы импортируются с ?v=N - иначе
// import() вернёт закэшированный модуль и ничего не изменится.
//
// Ошибка в одном файле не роняет работающий сервер: восстанавливаются прежние
// обработчики, ошибка уходит в журнал и в tail.
import { existsSync, readdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import * as api from './api'

export const HOOK_FILE = /\.(m?[jt]s)$/
const SKIP = /\.d\.(m?ts)$/

export function listHooks(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => HOOK_FILE.test(f) && !SKIP.test(f))
    .sort()
}

export type HooksInfo = { files: number; handlers: number; schedules: number }

let version = 0
const fresh = (file: string) => `${file}?v=${++version}`

// Загрузить все хуки папки заново. Прежние регистрации заменяются целиком.
export async function reloadHooks(dir: string): Promise<HooksInfo> {
  const before = api.snapshotHooks()
  const files = listHooks(dir)
  api.resetHooks()
  try {
    for (const f of files) await import(fresh(join(dir, f)))
  } catch (err) {
    api.restoreHooks(before) // работающий сервер не должен остаться без логики
    throw err
  }
  return info(files.length)
}

function info(files: number): HooksInfo {
  let handlers = 0
  for (const list of api.eventHandlers().values()) handlers += list.length
  return { files, handlers, schedules: api.scheduledTasks().length }
}

// Следить за папкой хуков. onChange зовётся после паузы 150 мс: редакторы
// пишут файл в несколько приёмов и без паузы перезагрузка шла бы трижды.
export function watchHooks(dir: string, onChange: () => void): () => void {
  if (!existsSync(dir)) return () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: ReturnType<typeof watch>
  try {
    watcher = watch(dir, { persistent: false }, (_event, file) => {
      if (file && !HOOK_FILE.test(String(file))) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        onChange()
      }, 150)
    })
  } catch {
    return () => {}
  }
  return () => {
    if (timer) clearTimeout(timer)
    watcher.close()
  }
}

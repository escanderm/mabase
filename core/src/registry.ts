// Коллекции, созданные в админке ("+ создать"). Описание
// - имя и индексы - лежит в _collections и поднимается при старте.
//
// Откуда коллекция:
//   code   - объявлена в mabase.config.ts (или встроенная users): код главнее,
//            админка её индексы не меняет и не удаляет;
//   admin  - создана в админке: индексы и удаление - из админки;
//   data   - описания нет, но документы есть (пишет хук через db.c.x);
//   system - служебная (_presence, _scheduled ...).
// Клиентам коллекция без правил закрыта, откуда бы она ни взялась. Правила -
// в mabase.config.ts.
import type { Db } from './db'
import { ActionError } from './errors'

export const COLLECTIONS = '_collections'
export type CollectionSource = 'code' | 'admin' | 'data' | 'system'

const NAME = /^[A-Za-z][\w-]{0,63}$/

export class Registry {
  private admin = new Set<string>()

  constructor(private db: Db) {
    db.collection(COLLECTIONS)
  }

  // При старте, когда всё из кода уже объявлено.
  async load(warn: (m: string) => void): Promise<void> {
    for (const d of await this.db.c[COLLECTIONS]!.find()) {
      if (this.db.isDeclared(d._id)) {
        warn(`Коллекция ${d._id} объявлена и в mabase.config.ts, и в админке - работает описание из кода`)
        continue
      }
      try {
        this.db.collection(d._id, { indexes: d.indexes ?? [] })
        this.admin.add(d._id)
      } catch (err) {
        warn(`Коллекция ${d._id} из админки не поднялась: ${(err as Error).message}`)
      }
    }
  }

  source(name: string): CollectionSource {
    if (name.startsWith('_')) return 'system'
    if (this.admin.has(name)) return 'admin'
    return this.db.isDeclared(name) ? 'code' : 'data'
  }

  async create(name: unknown, indexes: unknown = []): Promise<void> {
    if (typeof name !== 'string' || !NAME.test(name)) throw new ActionError('bad_request', 'Имя: латиница, цифры, _ и -, начинается с буквы, до 64 символов')
    const src = this.source(name)
    if (src !== 'data') throw new ActionError('conflict', src === 'code' ? `${name} уже объявлена в mabase.config.ts` : `${name} уже есть`)
    const fields = checkIndexes(indexes)
    this.db.collection(name, { indexes: fields }) // ошибка в индексах - до записи описания
    await this.db.c[COLLECTIONS]!.upsert({ _id: name }, { indexes: fields })
    this.admin.add(name)
  }

  async setIndexes(name: string, indexes: unknown): Promise<void> {
    this.requireAdmin(name, 'индексы')
    const fields = checkIndexes(indexes)
    this.db.collection(name, { indexes: fields })
    await this.db.c[COLLECTIONS]!.update(name, { $set: { indexes: fields } })
  }

  // Все документы - одной транзакцией, потом описание.
  async drop(name: string): Promise<number> {
    const src = this.source(name)
    if (src === 'code') throw new ActionError('conflict', `${name} объявлена в mabase.config.ts: удалите её там, а документы - "Удалить по фильтру" с пустым фильтром`)
    if (src === 'system') throw new ActionError('forbidden', 'Служебную коллекцию удалить нельзя')
    const n = await this.db.drop(name)
    if (src === 'admin') {
      await this.db.c[COLLECTIONS]!.remove(name).catch(() => {})
      this.admin.delete(name)
    }
    return n
  }

  private requireAdmin(name: string, what: string): void {
    const src = this.source(name)
    if (src === 'admin') return
    if (src === 'code') throw new ActionError('conflict', `${name} объявлена в mabase.config.ts - ${what} задаются там`)
    throw new ActionError('conflict', `${name} не создана в админке - сначала "Создать коллекцию" с этим именем`)
  }
}

function checkIndexes(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((f) => typeof f === 'string' && /^[A-Za-z_][\w.-]{0,100}$/.test(f) && !f.startsWith('_'))) {
    throw new ActionError('bad_request', 'Индексы: имена полей, например ["userId", "status"]; служебные поля _id и _createdAt индексировать не нужно')
  }
  return [...new Set(v as string[])]
}

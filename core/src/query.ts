// Фильтры, обновления и значения документов (design.md §8).
// Матчер - sift. Перед ним фильтр проверяется по белому списку операторов:
// sift умеет $where и выполняет строку как код.
import sift from 'sift'
import { QueryError } from './errors'
import { getPath, pathValues } from './paths'

export type Doc = Record<string, any> & { _id: string }
export type Query = Record<string, unknown>
export type Update = {
  $set?: Record<string, unknown>
  $unset?: Record<string, unknown>
  $inc?: Record<string, number>
  $push?: Record<string, unknown>
  $pull?: Record<string, unknown>
}

export const SYSTEM_FIELDS = ['_id', '_createdAt', '_updatedAt'] as const

const FIELD_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$regex', '$options', '$not'])
const UPDATE_OPS = new Set(['$set', '$unset', '$inc', '$push', '$pull'])

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof RegExp)

const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v)

// ---------- пути ----------
// В paths.ts - без зависимостей: тот же порядок нужен SDK в браузере.

export { getPath, pathValues } from './paths'

function setPath(doc: any, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur = doc
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {}
    cur = cur[p]
  }
  cur[parts[parts.length - 1]!] = value
}

function unsetPath(doc: any, path: string): void {
  const parts = path.split('.')
  let cur = doc
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]!]
    if (cur == null || typeof cur !== 'object') return
  }
  delete cur[parts[parts.length - 1]!]
}

// ---------- фильтры ----------

function checkOperand(path: string, op: string, v: unknown): void {
  const bad = (why: string) => new QueryError(`${path}.${op}: ${why}`)
  switch (op) {
    case '$in':
    case '$nin':
      if (!Array.isArray(v)) throw bad('нужен массив')
      for (const x of v) if (!isScalar(x) && !(x instanceof RegExp)) throw bad('в списке только строки, числа, булевы и null')
      return
    case '$exists':
      if (typeof v !== 'boolean') throw bad('нужно true или false')
      return
    case '$regex':
      if (typeof v !== 'string' && !(v instanceof RegExp)) throw bad('нужна строка или RegExp')
      return
    case '$options':
      if (typeof v !== 'string' || !/^[imsu]*$/.test(v)) throw bad('допустимы флаги i, m, s, u')
      return
    case '$not':
      if (v instanceof RegExp) return
      if (!isPlainObject(v)) throw bad('нужен объект операторов или RegExp')
      checkOperators(path, v)
      return
    default:
      if (!isScalar(v)) throw bad('сравнивать можно только со строкой, числом, булевым или null')
  }
}

function checkOperators(path: string, cond: Record<string, unknown>): void {
  for (const [op, v] of Object.entries(cond)) {
    if (!FIELD_OPS.has(op)) throw new QueryError(`${path}: оператор ${op} не поддерживается`)
    checkOperand(path, op, v)
  }
}

function checkCondition(path: string, cond: unknown): void {
  if (path.startsWith('$')) throw new QueryError(`оператор ${path} не поддерживается`)
  if (path === '' || path.split('.').some((p) => p === '')) throw new QueryError(`пустое имя поля в "${path}"`)
  if (isScalar(cond) || cond instanceof RegExp) return
  if (Array.isArray(cond)) {
    if (!cond.every(isScalar)) throw new QueryError(`${path}: сравнение с массивом объектов не поддерживается`)
    return
  }
  if (!isPlainObject(cond)) throw new QueryError(`${path}: значение ${String(cond)} не поддерживается (даты храните числом)`)
  const keys = Object.keys(cond)
  if (keys.length === 0 || !keys.every((k) => k.startsWith('$'))) {
    throw new QueryError(
      `${path}: фильтр по объекту целиком не поддерживается - результат зависит от порядка ключей. ` +
        `Пишите через точку: { '${path}.поле': значение }`,
    )
  }
  checkOperators(path, cond)
}

export function validateQuery(query: unknown): asserts query is Query {
  if (!isPlainObject(query)) throw new QueryError('фильтр должен быть объектом')
  for (const [key, v] of Object.entries(query)) {
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(v) || v.length === 0) throw new QueryError(`${key}: нужен непустой массив`)
      for (const sub of v) validateQuery(sub)
    } else {
      checkCondition(key, v)
    }
  }
}

export type Matcher = (doc: Doc) => boolean

export function compileQuery(query: Query): Matcher {
  validateQuery(query)
  if (Object.keys(query).length === 0) return () => true
  return sift(query) as Matcher
}

// ---------- обновления ----------

export function validateUpdate(update: unknown): asserts update is Update {
  if (!isPlainObject(update)) throw new QueryError('обновление должно быть объектом')
  const keys = Object.keys(update)
  if (keys.length === 0) throw new QueryError('пустое обновление')
  for (const op of keys) {
    if (!UPDATE_OPS.has(op)) {
      throw new QueryError(
        op.startsWith('$') ? `оператор обновления ${op} не поддерживается` : `обновление без оператора: используйте { $set: { ${op}: ... } }`,
      )
    }
    const fields = (update as any)[op]
    if (!isPlainObject(fields)) throw new QueryError(`${op}: нужен объект { поле: значение }`)
    for (const [path, v] of Object.entries(fields)) {
      const root = path.split('.')[0]!
      if ((SYSTEM_FIELDS as readonly string[]).includes(root)) throw new QueryError(`${op}: поле ${root} меняет только ядро`)
      if (op === '$inc' && (typeof v !== 'number' || !Number.isFinite(v))) throw new QueryError(`$inc.${path}: нужно число`)
      if (op === '$pull' && isPlainObject(v)) validateQuery(v)
    }
  }
}

export function applyUpdate(doc: Doc, update: Update): Doc {
  validateUpdate(update)
  const next = structuredClone(doc) as Doc
  for (const [k, v] of Object.entries(update.$set ?? {})) setPath(next, k, structuredClone(v))
  for (const k of Object.keys(update.$unset ?? {})) unsetPath(next, k)
  for (const [k, v] of Object.entries(update.$inc ?? {})) {
    const cur = getPath(next, k)
    if (cur !== undefined && typeof cur !== 'number') throw new QueryError(`$inc.${k}: поле не число`)
    setPath(next, k, (cur ?? 0) + v)
  }
  for (const [k, v] of Object.entries(update.$push ?? {})) {
    const cur = getPath(next, k)
    if (cur !== undefined && !Array.isArray(cur)) throw new QueryError(`$push.${k}: поле не массив`)
    setPath(next, k, [...((cur as unknown[]) ?? []), structuredClone(v)])
  }
  for (const [k, v] of Object.entries(update.$pull ?? {})) {
    const cur = getPath(next, k)
    if (cur === undefined) continue
    if (!Array.isArray(cur)) throw new QueryError(`$pull.${k}: поле не массив`)
    // как в Mongo: значение - удалить равные, объект - удалить подходящие под условие
    const test = sift(v as any) as (x: unknown) => boolean
    setPath(next, k, cur.filter((x) => !test(x)))
  }
  return next
}

// ---------- документы ----------

// Документ уходит в лог через JSON. Всё, что JSON не переживёт без потерь,
// отклоняем сразу, иначе после рестарта документ молча станет другим.
export function assertJson(v: unknown, path = ''): void {
  const at = path || 'документ'
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(v)) throw new QueryError(`${at}: ${v} не сохраняется в JSON`)
      return
    case 'object':
      if (v === null) return
      if (Array.isArray(v)) {
        v.forEach((x, i) => {
          if (x === undefined) throw new QueryError(`${at}[${i}]: undefined в массиве не сохраняется`)
          assertJson(x, `${path}[${i}]`)
        })
        return
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
        const kind = (v as object).constructor?.name ?? 'объект'
        throw new QueryError(`${at}: ${kind} не сохраняется в JSON${kind === 'Date' ? ' - храните время числом (Date.now())' : ''}`)
      }
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined) continue // JSON.stringify пропустит - как и при чтении
        assertJson(x, path ? `${path}.${k}` : k)
      }
      return
    case 'undefined':
      return
    default:
      throw new QueryError(`${at}: ${typeof v} не сохраняется в JSON`)
  }
}

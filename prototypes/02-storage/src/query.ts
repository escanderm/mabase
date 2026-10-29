// Минимальный матчер и обновления. Не предмет проверки: потом заменим на sift.
export type Doc = Record<string, any> & { _id: string }
export type Query = Record<string, unknown>
export type Update = {
  $set?: Record<string, unknown>
  $unset?: Record<string, unknown>
  $inc?: Record<string, number>
}

export function getPath(doc: unknown, path: string): unknown {
  let cur: any = doc
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

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

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export function matches(doc: Doc, query: Query): boolean {
  for (const [path, expected] of Object.entries(query)) {
    const actual = getPath(doc, path)
    // как в Mongo: { tags: 'x' } совпадает, если массив содержит 'x'
    if (Array.isArray(actual) && !Array.isArray(expected)) {
      if (!actual.some((v) => equal(v, expected))) return false
    } else if (!equal(actual, expected)) {
      return false
    }
  }
  return true
}

export function applyUpdate(doc: Doc, update: Update): Doc {
  const next = structuredClone(doc)
  for (const [k, v] of Object.entries(update.$set ?? {})) setPath(next, k, v)
  for (const k of Object.keys(update.$unset ?? {})) unsetPath(next, k)
  for (const [k, v] of Object.entries(update.$inc ?? {})) {
    const cur = getPath(next, k)
    setPath(next, k, (typeof cur === 'number' ? cur : 0) + v)
  }
  return next
}

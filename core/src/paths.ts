// Пути в документе: 'a.b.c'. Без зависимостей - их использует и SDK в браузере.
export type Doc = Record<string, any> & { _id: string }

export function getPath(doc: unknown, path: string): unknown {
  let cur: any = doc
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

// Все значения по пути, как их видит sift: массивы раскрываются и в середине
// пути, и в конце, вложенные массивы - тоже (так делает sift; важнее, чтобы
// индекс и матчер совпадали). Нет значения -
// [undefined]. Отсюда берутся ключи индекса и ключ сортировки, поэтому индекс
// и полный перебор видят одно и то же.
export function pathValues(doc: unknown, parts: readonly string[]): unknown[] {
  const out: unknown[] = []
  const leaf = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) leaf(x)
    else out.push(v)
  }
  const walk = (v: unknown, i: number) => {
    if (i === parts.length) {
      leaf(v)
      return
    }
    if (Array.isArray(v)) {
      for (const el of v) walk(el, i)
      return
    }
    if (v === null || typeof v !== 'object') {
      out.push(undefined)
      return
    }
    walk((v as any)[parts[i]!], i + 1)
  }
  walk(doc, 0)
  if (out.length === 0) out.push(undefined) // пустой массив - как отсутствующее поле
  return out
}

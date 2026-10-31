// Пути в документе: 'a.b.c'. Без зависимостей - их использует и SDK в браузере.
export type Doc = Record<string, any> & { _id: string }

// Имена, через которые путь достаёт до прототипа объекта, а не до документа:
// { '__proto__.x': 1 } - это не поле, а запись в Object.prototype всего
// процесса (и чтение оттуда). Такой путь - всегда ошибка, а не попытка
// что-то найти, поэтому проверяется на входе и в самом setPath.
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])
const NUMERIC = /^\d+$/

export function forbiddenSegment(path: string): string | null {
  for (const part of path.split('.')) if (FORBIDDEN.has(part)) return part
  return null
}

// Только свои свойства: документ приходит из JSON, унаследованного в нём быть
// не может. Иначе клиентский путь вида 'constructor.name' или оставленное
// кем-то в прототипе значение читались бы как поле документа.
export function getPath(doc: unknown, path: string): unknown {
  let cur: any = doc
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    if (!Object.hasOwn(cur, part)) return undefined
    cur = cur[part]
  }
  return cur
}

// Все значения по пути, как их видит sift: массивы раскрываются и в середине
// пути, и в конце, вложенные массивы - тоже (так делает sift; важнее, чтобы
// индекс и матчер совпадали). Числовой сегмент ('tags.0') - это элемент
// массива, а не раскрытие: sift берёт item[key] при isNaN(Number(key)) === false.
// Нет значения - [undefined]. Отсюда берутся ключи индекса и ключ сортировки,
// поэтому индекс и полный перебор видят одно и то же.
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
    const seg = parts[i]!
    if (Array.isArray(v)) {
      if (NUMERIC.test(seg)) {
        walk(v[Number(seg)], i + 1) // tags.0 - первый элемент
        return
      }
      for (const el of v) walk(el, i)
      return
    }
    if (v === null || typeof v !== 'object') {
      out.push(undefined)
      return
    }
    if (!Object.hasOwn(v, seg)) {
      out.push(undefined) // как у отсутствующего поля, а не undefined-без-ключа
      return
    }
    walk((v as any)[seg], i + 1)
  }
  walk(doc, 0)
  if (out.length === 0) out.push(undefined) // пустой массив - как отсутствующее поле
  return out
}

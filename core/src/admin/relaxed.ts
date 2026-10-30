// Нестрогий JSON для строки фильтра: { roomId: 'general',
// n: { $gt: 5 }, text: /привет/i }. Ключи без кавычек, строки в одинарных
// кавычках, запятая в конце, регулярное выражение -> { $regex, $options }.
// Только разбор данных: ничего не выполняется (никакого eval).
export class RelaxedError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(`${message} (символ ${pos + 1})`)
  }
}

export function parseRelaxed(text: string): unknown {
  let i = 0
  const fail = (m: string): never => {
    throw new RelaxedError(m, i)
  }
  const ws = () => {
    while (i < text.length) {
      const c = text[i]!
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t') i++
      else if (c === '/' && text[i + 1] === '/') while (i < text.length && text[i] !== '\n') i++
      else break
    }
  }
  const expect = (c: string) => {
    ws()
    if (text[i] !== c) fail(`ожидалось "${c}"`)
    i++
  }
  const str = (q: string): string => {
    i++ // открывающая кавычка
    let out = ''
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\') {
        const e = text[++i]
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\\': '\\', '/': '/', '"': '"', "'": "'" }
        if (e === 'u') {
          const hex = text.slice(i + 1, i + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('неверный \\u')
          out += String.fromCharCode(parseInt(hex, 16))
          i += 5
          continue
        }
        if (e === undefined || !(e in map)) fail('неизвестная escape-последовательность')
        out += map[e!]
        i++
      } else out += text[i++]
    }
    if (text[i] !== q) fail('строка не закрыта')
    i++
    return out
  }
  const value = (): unknown => {
    ws()
    const c = text[i]
    if (c === undefined) fail('неожиданный конец')
    if (c === '{') return object()
    if (c === '[') return array()
    if (c === '"' || c === "'") return str(c)
    if (c === '/') return regex()
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i))
    if (m) {
      i += m[0].length
      return Number(m[0])
    }
    for (const [w, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(w, i) && !/[\w$]/.test(text[i + w.length] ?? '')) {
        i += w.length
        return v
      }
    }
    return fail('ожидалось значение')
  }
  const object = () => {
    i++
    const out: Record<string, unknown> = {}
    for (;;) {
      ws()
      if (text[i] === '}') {
        i++
        return out
      }
      let key: string
      if (text[i] === '"' || text[i] === "'") key = str(text[i]!)
      else {
        const m = /^[\w$.\-]+/.exec(text.slice(i))
        if (!m) fail('ожидался ключ')
        key = m![0]
        i += key.length
      }
      expect(':')
      out[key] = value()
      ws()
      if (text[i] === ',') i++
      else if (text[i] !== '}') fail('ожидалось "," или "}"')
    }
  }
  const array = () => {
    i++
    const out: unknown[] = []
    for (;;) {
      ws()
      if (text[i] === ']') {
        i++
        return out
      }
      out.push(value())
      ws()
      if (text[i] === ',') i++
      else if (text[i] !== ']') fail('ожидалось "," или "]"')
    }
  }
  const regex = () => {
    i++
    let src = ''
    let cls = false
    while (i < text.length && (text[i] !== '/' || cls)) {
      if (text[i] === '\\') src += text[i++]
      else if (text[i] === '[') cls = true
      else if (text[i] === ']') cls = false
      src += text[i++] ?? ''
    }
    if (text[i] !== '/') fail('регулярное выражение не закрыто')
    i++
    const flags = /^[imsx]*/.exec(text.slice(i))![0]
    i += flags.length
    return flags ? { $regex: src, $options: flags } : { $regex: src }
  }

  const v = value()
  ws()
  if (i < text.length) fail('лишние символы после значения')
  return v
}

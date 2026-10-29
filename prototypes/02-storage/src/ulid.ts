// ULID: 10 символов времени + 16 символов случайной части, Crockford base32.
// Внутри одной миллисекунды случайная часть увеличивается на 1, поэтому
// id из одного процесса строго возрастают.
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastTime = -1
const rnd: number[] = new Array(16).fill(0)

export function ulid(now = Date.now()): string {
  if (now <= lastTime) {
    // та же миллисекунда или часы ушли назад - продолжаем от прошлого id
    let i = 15
    while (i >= 0 && rnd[i] === 31) {
      rnd[i] = 0
      i--
    }
    if (i < 0) throw new Error('ULID: переполнение случайной части')
    rnd[i]!++
    now = lastTime
  } else {
    lastTime = now
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    for (let i = 0; i < 16; i++) rnd[i] = bytes[i]! & 31
  }
  let t = ''
  let x = now
  for (let i = 0; i < 10; i++) {
    t = ENC[x % 32] + t
    x = Math.floor(x / 32)
  }
  let r = ''
  for (const d of rnd) r += ENC[d]
  return t + r
}

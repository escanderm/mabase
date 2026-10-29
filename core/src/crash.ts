// Имитация падения процесса в заданной точке.
// MB_CRASH_AT=<точка>  - где падать;
// MB_CRASH_HIT=<n>     - на каком по счёту проходе через точку (по умолчанию 1).
const hits = new Map<string, number>()

export function crashPoint(name: string): void {
  if (process.env.MB_CRASH_AT !== name) return
  const n = (hits.get(name) ?? 0) + 1
  hits.set(name, n)
  if (n < Number(process.env.MB_CRASH_HIT ?? 1)) return
  process.kill(process.pid, 'SIGKILL')
  // сигнал доставляется не мгновенно - не даём коду идти дальше
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000)
}

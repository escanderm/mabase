// Одна общая FIFO-очередь записи. acquire() отдаёт функцию освобождения,
// её можно вызывать сколько угодно раз - сработает первый.
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve()

  acquire(): Promise<() => void> {
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const prev = this.tail
    this.tail = prev.then(() => gate)
    return prev.then(() => {
      let released = false
      return () => {
        if (released) return
        released = true
        open()
      }
    })
  }
}

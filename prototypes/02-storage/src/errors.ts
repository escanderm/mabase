export class TxTimeoutError extends Error {
  constructor(public holdMs: number) {
    super(`Транзакция держала очередь ${holdMs} мс и отменена по таймауту`)
    this.name = 'TxTimeoutError'
  }
}

export class TxAbortedError extends Error {
  constructor() {
    super('Транзакция уже отменена: запись и чтение из её контекста запрещены')
    this.name = 'TxAbortedError'
  }
}

export class DepthError extends Error {
  constructor(depth: number) {
    super(`Глубина вложенных записей ${depth} больше допустимой`)
    this.name = 'DepthError'
  }
}

export class NotFoundError extends Error {
  constructor(collection: string, id: string) {
    super(`${collection}/${id} не найден`)
    this.name = 'NotFoundError'
  }
}

export class DuplicateIdError extends Error {
  constructor(collection: string, id: string) {
    super(`${collection}/${id} уже существует`)
    this.name = 'DuplicateIdError'
  }
}

export class CorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptionError'
  }
}

export class ReadOnlyError extends Error {
  constructor(cause: unknown) {
    super(`База в режиме "только чтение": не удалось откатить запись в лог (${String(cause)})`)
    this.name = 'ReadOnlyError'
  }
}

export class LockedError extends Error {
  constructor(path: string, pid: number | null) {
    super(
      pid
        ? `База уже открыта процессом ${pid} (${path}). Второй писатель потеряет данные - остановите первый процесс`
        : `База уже открыта другим процессом (${path})`,
    )
    this.name = 'LockedError'
  }
}

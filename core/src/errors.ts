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

// Неверный фильтр, обновление или значение документа.
export class QueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryError'
  }
}

// Документ не прошёл схему коллекции. issues - как их отдал zod.
export class ValidationError extends Error {
  constructor(
    public collection: string,
    public issues: Array<{ path: PropertyKey[]; message: string }>,
  ) {
    super(`${collection}: документ не прошёл схему - ${issues.map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`).join('; ')}`)
    this.name = 'ValidationError'
  }
}

// Ошибка в описании коллекции: индекс на поле-объект и т. п.
export class DefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DefinitionError'
  }
}

// Ожидаемая ошибка действия: уходит клиенту с кодом и сообщением (design.md §10).
export const ACTION_ERROR_STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_credentials: 401, // неверный пароль или код
  too_many_requests: 429,
  unavailable: 503, // внешний сервис (authphone.su) не ответил
} as const
export type ActionErrorCode = keyof typeof ACTION_ERROR_STATUS

export class ActionError extends Error {
  constructor(
    public code: ActionErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'ActionError'
    if (!(code in ACTION_ERROR_STATUS)) throw new TypeError(`ActionError: неизвестный код ${code}`)
  }

  get status(): number {
    return ACTION_ERROR_STATUS[this.code]
  }
}

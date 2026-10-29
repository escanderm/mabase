import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../src/db'

const ROOT = join(import.meta.dir, '..', '.tmp')

export function tmpDir(prefix = 't'): string {
  mkdirSync(ROOT, { recursive: true })
  return mkdtempSync(join(ROOT, `${prefix}-`))
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    if (await check()) return
    await sleep(5)
  }
  throw new Error(`Условие не выполнилось за ${timeoutMs} мс`)
}

export function currentLogPath(dir: string): string {
  const gen = readFileSync(join(dir, 'CURRENT'), 'utf8').trim()
  return join(dir, `log.${gen}.jsonl`)
}

export function files(dir: string): string[] {
  return readdirSync(dir).sort()
}

// Всё содержимое базы в сравнимом виде.
export async function dump(db: Db, collections: string[]): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const c of collections) out[c] = await db.c[c]!.find()
  return out
}

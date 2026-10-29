interface Greeting { to: string; text: string }
enum Level { Info = 'info', Warn = 'warn' }
export function greet(to: string): Greeting & { level: Level } {
  return { to, text: `Привет, ${to}!`, level: Level.Info }
}

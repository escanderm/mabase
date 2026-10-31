// Тесты 194-198: настройки из env (design.md §5, §17). Фиксированный контракт
// MABASE_*, валидация, приоритет флаги > env > config, `mabase config`.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from '../src/cli'
import { configView } from '../src/config-view'
import { readEnv } from '../src/env'
import { loadProject } from '../src/cli'
import { tmpDir } from './helpers'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

const project = (cfg = '') => {
  const root = tmpDir('env')
  writeFileSync(join(root, 'mabase.config.ts'), `import { defineConfig } from 'mabase'\nexport default defineConfig({${cfg}})\n`)
  mkdirSync(join(root, 'mb_hooks'))
  return root
}

describe('env: контракт и валидация', () => {
  test('194. числа и флаги проверяются, неизвестное MABASE_* - предупреждение', () => {
    expect(readEnv({ MABASE_PORT: '9000' }).overrides.port).toBe(9000)
    expect(() => readEnv({ MABASE_PORT: 'тысяча' })).toThrow(/MABASE_PORT/)
    expect(() => readEnv({ MABASE_PORT: '70000' })).toThrow(/MABASE_PORT/)
    const partial = readEnv({ MABASE_S3_PATH_STYLE: 'yes' })
    expect(partial.overrides.storage?.s3?.forcePathStyle).toBe(true)
    expect(partial.warnings.join(' ')).toContain('S3 из env задан частично')
    expect(() => readEnv({ MABASE_S3_PATH_STYLE: 'может' })).toThrow(/MABASE_S3_PATH_STYLE/)
    expect(() => readEnv({ MABASE_SECRET: 'короткий' })).toThrow(/32/)

    const r = readEnv({ MABASE_POTR: '1', MABASE_PORT: '9000' })
    expect(r.warnings.join(' ')).toContain('MABASE_POTR')
    expect(r.overrides.port).toBe(9000)
    expect(readEnv({}).warnings).toEqual([])
  })

  test('195. S3, почта и OAuth собираются из env; частичная настройка - предупреждение', () => {
    const s3 = readEnv({ MABASE_S3_BUCKET: 'b', MABASE_S3_REGION: 'ru-central1', MABASE_S3_ACCESS_KEY_ID: 'k', MABASE_S3_SECRET_ACCESS_KEY: 's', MABASE_S3_PREFIX: 'app' })
    expect(s3.overrides.storage?.s3).toMatchObject({ bucket: 'b', region: 'ru-central1', accessKeyId: 'k', secretAccessKey: 's', prefix: 'app' })
    expect(readEnv({ MABASE_S3_BUCKET: 'b' }).warnings.join(' ')).toContain('region, accessKeyId, secretAccessKey')

    const mail = readEnv({ MABASE_SMTP_HOST: 'smtp.test', MABASE_SMTP_PORT: '587', MABASE_SMTP_PASS: 'p', MABASE_MAIL_FROM: 'a@b.c' })
    expect(mail.overrides.mail).toMatchObject({ from: 'a@b.c', smtp: { host: 'smtp.test', port: 587, pass: 'p' } })
    expect(() => readEnv({ MABASE_SMTP_PASS: 'p' })).toThrow(/MABASE_SMTP_HOST/)

    const auth = readEnv({ MABASE_GOOGLE_ID: 'id', MABASE_GOOGLE_SECRET: 'sec', MABASE_APP_URL: 'https://app.test/' })
    expect(auth.overrides.auth).toMatchObject({ appUrl: 'https://app.test', oauth: { google: { clientId: 'id', clientSecret: 'sec' } } })
    expect(() => readEnv({ MABASE_GITHUB_ID: 'id' })).toThrow(/MABASE_GITHUB_SECRET/)
  })

  test('196. приоритет: флаг > env > config; env перекрывает поля S3 из конфига', async () => {
    const root = project(`http: { serverUrl: 'https://config.test' }, storage: { s3: { bucket: 'from-config', region: 'cfg', accessKeyId: 'a', secretAccessKey: 's', prefix: 'keep' } }`)
    const env = { MABASE_PORT: '9000', MABASE_SERVER_URL: 'https://env.test', MABASE_S3_BUCKET: 'from-env', MABASE_S3_REGION: 'r2', MABASE_S3_ACCESS_KEY_ID: 'a2', MABASE_S3_SECRET_ACCESS_KEY: 's2' }

    // без флагов: главнее env
    const a = await loadProject(parseArgs(['serve', '--root', root]).flags, { env })
    expect(a.config.port).toBe(9000)
    expect(a.sources.port).toBe('MABASE_PORT')
    expect(a.config.http?.serverUrl).toBe('https://env.test')
    expect(a.sources.serverUrl).toBe('MABASE_SERVER_URL')
    expect(a.config.storage?.s3).toMatchObject({ bucket: 'from-env', region: 'r2', prefix: 'keep' }) // prefix остался из конфига
    expect(a.sources.storage).toBe('MABASE_S3_*')

    // флаг главнее env
    const b = await loadProject(parseArgs(['serve', '--root', root, '--port', '9001']).flags, { env })
    expect(b.config.port).toBe(9001)
    expect(b.sources.port).toBe('флаг --port')

    // без env - конфиг
    const c = await loadProject(parseArgs(['serve', '--root', root]).flags, { env: {} })
    expect(c.config.http?.serverUrl).toBe('https://config.test')
    expect(c.config.storage?.s3?.bucket).toBe('from-config')
    expect(c.sources.port).toBe('по умолчанию')
  })

  test('197. mabase config: значения и источники, секреты замаскированы', async () => {
    const root = project(`http: { cors: '*' }, storage: { s3: { bucket: 'b', region: 'r', accessKeyId: 'a', secretAccessKey: 'super-secret' } }`)
    const { config, sources, hooks, warnings } = await loadProject(parseArgs(['serve', '--root', root]).flags, {
      env: { MABASE_PORT: '9100', MABASE_SMTP_HOST: 'smtp.test', MABASE_SMTP_PASS: 'mail-secret' },
    })
    // почта без адреса приложения - предупреждение заранее, а не отказ при старте
    expect(warnings.join(' ')).toContain('MABASE_APP_URL')
    const lines = configView(config, { sources, hooks })
    const by = (k: string) => lines.find((l) => l.key === k)!
    expect(by('порт')).toMatchObject({ value: '9100', source: 'MABASE_PORT' })
    expect(by('CORS').value).toBe('*')
    expect(by('CORS').source).toBe('config')
    expect(by('файлы').value).toContain('S3 b @ aws')
    expect(by('файлы').value).toContain('***')
    expect(by('файлы').value).not.toContain('super-secret')
    expect(by('почта').value).toContain('SMTP smtp.test:587')
    expect(by('почта').source).toContain('MABASE_SMTP')
    expect(by('почта').value).not.toContain('mail-secret')
    // весь вывод не должен содержать секретов
    expect(JSON.stringify(lines)).not.toContain('super-secret')
    expect(JSON.stringify(lines)).not.toContain('mail-secret')
  })

  test('198. CLI: mabase config печатает настройки, не печатает секреты, код 0', async () => {
    const root = project(`storage: { s3: { bucket: 'b', region: 'r', accessKeyId: 'a', secretAccessKey: 'secret-value' } }`)
    const p = Bun.spawn(['bun', CLI, 'config', '--root', root], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, MABASE_PORT: '9200' },
    })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const all = out + err
    expect(await p.exited).toBe(0)
    expect(all).toContain('9200')
    expect(all).toContain('MABASE_PORT')
    expect(all).toContain('S3 b')
    expect(all).not.toContain('secret-value')
  }, 30_000)
})

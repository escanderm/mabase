// Файлы админки /_/: страница, стили и скрипт. В бинарнике скрипт вшит
// (build.ts кладёт сборку в generated/admin.ts), из исходников - собирается
// при первом запросе, как SDK.
import cssRaw from './style.css' with { type: 'text' }
import htmlRaw from './index.html' with { type: 'text' }

// Bun объявляет *.html как HTMLBundle (сборка фронтенда), но здесь импорт с
// type: 'text' - это строка. CSS в типах Bun нет вовсе (css.d.ts).
const css = cssRaw as unknown as string
const html = htmlRaw as unknown as string

const compiled = import.meta.url.includes('$bunfs')
let js: Promise<string> | null = null

export function adminScript(): Promise<string> {
  return (js ??= compiled ? import('../generated/admin').then((m) => m.default as string) : buildAdmin())
}

export async function buildAdmin(): Promise<string> {
  const r = await Bun.build({ entrypoints: [new URL('./app.ts', import.meta.url).pathname], target: 'browser', minify: true })
  if (!r.success) throw new Error(`админка не собралась: ${r.logs.join('\n')}`)
  return r.outputs[0]!.text()
}

// Страница без чужих скриптов и стилей: всё своё, встраивать в чужие сайты нельзя.
const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
}

export async function adminAsset(req: Request, path: string): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Только GET', { status: 405 })
  if (path === '/_') return new Response(null, { status: 301, headers: { Location: '/_/' } })
  if (path === '/_/') return new Response(html, { headers: { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8' } })
  if (path === '/_/app.css') return new Response(css, { headers: { ...SECURITY, 'Content-Type': 'text/css; charset=utf-8' } })
  if (path === '/_/app.js') return new Response(await adminScript(), { headers: { ...SECURITY, 'Content-Type': 'text/javascript; charset=utf-8' } })
  return new Response('Нет такого файла', { status: 404, headers: SECURITY })
}

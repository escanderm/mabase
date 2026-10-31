// Фальшивый S3 для тестов: хранит объекты в памяти и проверяет подпись SigV4
// независимой реализацией (неверная подпись - 403, как у настоящего S3).
import { createHash, createHmac } from 'node:crypto'

export const KEY = 'AKIDEXAMPLE'
export const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'

export const hex = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex')
export const hmac = (key: string | Buffer, d: string) => createHmac('sha256', key).update(d).digest()
export const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export type Call = { method: string; path: string; signed: boolean; payloadHash: string }
export type S3Config = { accessKeyId: string; secretAccessKey: string; region: string; bucket: string }

export function fakeS3(cfg: S3Config) {
  const objects = new Map<string, Uint8Array>()
  const calls: Call[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const body = new Uint8Array(await req.arrayBuffer())
      const payloadHash = req.headers.get('x-amz-content-sha256') ?? ''
      const signed = verify(req, url, cfg)
      calls.push({ method: req.method, path: url.pathname, signed, payloadHash })
      if (!signed) return new Response('SignatureDoesNotMatch', { status: 403 })
      if (req.method === 'PUT') {
        objects.set(url.pathname, body)
        return new Response(null, { status: 200 })
      }
      if (req.method === 'DELETE') {
        objects.delete(url.pathname)
        return new Response(null, { status: 204 })
      }
      if (req.method === 'HEAD') return new Response(null, { status: objects.has(url.pathname) ? 200 : 404 })
      const obj = objects.get(url.pathname)
      return obj ? new Response(obj as unknown as BodyInit) : new Response('NoSuchKey', { status: 404 })
    },
  })
  return { port: server.port!, objects, calls, stop: () => server.stop(true) }
}

// Независимая проверка AWS Signature V4: пересчитываем подпись из запроса и
// сравниваем с присланной.
export function verify(req: Request, url: URL, cfg: { accessKeyId: string; secretAccessKey: string; region: string }): boolean {
  const auth = req.headers.get('authorization') ?? ''
  const amzDate = req.headers.get('x-amz-date') ?? ''
  const payloadHash = req.headers.get('x-amz-content-sha256') ?? ''
  const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]
  const given = /Signature=([0-9a-f]+)/.exec(auth)?.[1]
  const scope = /Credential=([^,]+)/.exec(auth)?.[1]?.split('/').slice(1).join('/')
  if (!signed || !given || !scope || !amzDate) return false
  if (!auth.includes(`Credential=${cfg.accessKeyId}/`)) return false
  const date = amzDate.slice(0, 8)
  if (scope !== `${date}/${cfg.region}/s3/aws4_request`) return false
  const canonicalHeaders = signed
    .split(';')
    .map((k) => `${k}:${req.headers.get(k) ?? ''}\n`)
    .join('')
  const canonicalRequest = `${req.method}\n${url.pathname.split('/').map(enc).join('/')}\n\n${canonicalHeaders}\n${signed}\n${payloadHash}`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(canonicalRequest)}`
  const key = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, date), cfg.region), 's3'), 'aws4_request')
  return createHmac('sha256', key).update(stringToSign).digest('hex') === given
}

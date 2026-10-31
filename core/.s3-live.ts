import { S3Storage } from './src/files'
const env = process.env
const base = {
  bucket: env.MABASE_S3_BUCKET!,
  region: env.MABASE_S3_REGION ?? 'ru1',
  accessKeyId: env.MABASE_S3_ACCESS_KEY_ID!,
  secretAccessKey: env.MABASE_S3_SECRET_ACCESS_KEY!,
  endpoint: env.MABASE_S3_ENDPOINT!,
  prefix: 'mabase-live',
}
const meta = { _id: 'f1', collection: 'docs', recordId: 'r1', field: 'f', name: 'hello.txt', size: 5, mime: 'text/plain', createdAt: 0 }
for (const pathStyle of [true, false]) {
  const s3 = new S3Storage({ ...base, forcePathStyle: pathStyle })
  try {
    const t0 = performance.now()
    await s3.put(meta, new TextEncoder().encode('hello'))
    const head = await s3.head(meta)
    const full = new TextDecoder().decode(await s3.get(meta))
    const part = new TextDecoder().decode(await s3.get(meta, { start: 1, end: 3 }))
    await s3.delete(meta)
    console.log(JSON.stringify({ pathStyle, put: true, head, full, range: part, ms: Math.round(performance.now() - t0), after: await s3.head(meta) }))
  } catch (e) {
    console.log(JSON.stringify({ pathStyle, error: String((e as Error).message).slice(0, 300) }))
  }
}
process.exit(0)

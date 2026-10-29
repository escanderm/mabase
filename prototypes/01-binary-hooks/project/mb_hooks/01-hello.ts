import { on, z, defineCollection, version } from 'mabase'
import { greet } from '../lib/helper.ts'

const Message = z.object({ text: z.string().min(1), roomId: z.string() })
type Message = z.infer<typeof Message>
defineCollection('messages', { schema: Message })

const ok: Message = Message.parse({ text: 'hi', roomId: 'r1' })
const bad = Message.safeParse({ text: '' })
console.log(`  [01-hello] mabase ${version}, parse ok=${!!ok}, bad rejected=${!bad.success}`)

await new Promise((r) => setTimeout(r, 5)) // top-level await
on('user.online', ({ userId }: { userId: string }) => {
  console.log('  [01-hello] user.online ->', JSON.stringify(greet(userId)))
})

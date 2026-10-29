import { on } from 'mabase'
import pad from 'fake-pad'
on('user.online', ({ userId }: { userId: string }) => {
  console.log('  [02-npm] fake-pad ->', pad(userId, 8))
})

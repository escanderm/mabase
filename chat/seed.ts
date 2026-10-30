// mabase seed - тестовые данные для разработки.
// Идемпотентный: можно запускать сколько угодно раз, дублей не будет.
// Пароли - только для локальной разработки.
import { defineSeed } from 'mabase'

export default defineSeed(async ({ db, auth }) => {
  const alice = await auth.upsertUser({ email: 'alice@example.test', password: 'dev-alice-1', name: 'Алиса' })
  const bob = await auth.upsertUser({ email: 'bob@example.test', password: 'dev-bob-1', name: 'Боб' })
  const carol = await auth.upsertUser({ email: 'carol@example.test', password: 'dev-carol-1', name: 'Кэрол' })

  // своё _id - чтобы upsert находил ту же комнату при повторном запуске [Q10]
  await db.rooms.upsert(
    { _id: 'general' },
    { name: 'Общая', ownerId: alice._id, participants: [alice._id, bob._id] },
  )
  await db.rooms.upsert({ _id: 'private' }, { name: 'Только Кэрол', ownerId: carol._id, participants: [carol._id] })

  // много сообщений - проверить пагинацию. Пишется пачками по 1000 сам (design.md §15).
  const count = await db.messages.count({ roomId: 'general' })
  if (count === 0) {
    await db.messages.insertMany(
      Array.from({ length: 5000 }, (_, i) => ({
        roomId: 'general',
        authorId: i % 2 ? alice._id : bob._id,
        text: `Сообщение ${i + 1}`,
      })),
    )
  }

  await db.invites.upsert(
    { _id: 'carol-to-general' },
    { roomId: 'general', roomName: 'Общая', from: alice._id, fromName: 'Алиса', to: carol._id },
  )
})

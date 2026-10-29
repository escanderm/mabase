// Письмо о приглашении. Задачу ставит действие invite внутри своей транзакции,
// поэтому приглашение и задача сохраняются вместе или не сохраняются вовсе.
//
// Доставка - минимум один раз (design.md §13): обработчик может сработать
// повторно после падения. Поэтому:
// - проверяем, что приглашение ещё актуально;
// - передаём почтовому сервису ключ идемпотентности, чтобы он не отправил дубль.
import { on } from 'mabase'

on('invite.email', async ({ data, db, signal }) => {
  const inv = await db.invites.findOne({ _id: data.inviteId })
  if (!inv) return // приглашение уже приняли или отозвали - письмо не нужно

  const [to, from, room] = await Promise.all([
    db.users.findOne({ _id: inv.to }),
    db.users.findOne({ _id: inv.from }),
    db.rooms.findOne({ _id: inv.roomId }),
  ])
  if (!to || !from || !room) return

  // fetch здесь можно: on() работает вне транзакции и не держит очередь записи
  const res = await fetch(process.env.MAILER_URL!, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'idempotency-key': `invite:${inv._id}` },
    body: JSON.stringify({
      to: to.email,
      subject: `${from.name} приглашает вас в "${room.name}"`,
    }),
  })
  // ошибка -> повтор с паузой (design.md §13)
  if (!res.ok) throw new Error(`Почта ответила ${res.status}`)
})

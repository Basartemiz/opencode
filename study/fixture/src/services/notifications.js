// Messages to members. They are queued and sent by `flush()`, which the server calls every minute.
// The sender prints to the console; production would plug in an email provider here.

const outbox = []
const sent = []

let sender = (message) => {
  console.log(`[mail] to=${message.to} subject="${message.subject}"`)
}

export function setSender(fn) {
  sender = fn
}

export function queue(member, subject, body) {
  outbox.push({ to: member.email, memberId: member.id, subject, body, queued: new Date().toISOString() })
}

export function flush() {
  while (outbox.length > 0) {
    const message = outbox.shift()
    sender(message)
    sent.push(message)
  }
  return sent.length
}

export function pending() {
  return [...outbox]
}

export function history() {
  return [...sent]
}

export function clear() {
  outbox.length = 0
  sent.length = 0
}

export const templates = {
  dueSoon: (book, loan) => ({
    subject: `"${book.title}" is due soon`,
    body: `Please return or renew "${book.title}" by ${loan.due.slice(0, 10)}.`,
  }),
  overdue: (book, days, fee) => ({
    subject: `"${book.title}" is overdue`,
    body: `"${book.title}" is ${days} day(s) late. The current fee is ${fee}.`,
  }),
  returned: (book, fee) => ({
    subject: `Thanks for returning "${book.title}"`,
    body: fee > 0 ? `A late fee of €${fee.toFixed(2)} was added to your account.` : `See you next time!`,
  }),
}

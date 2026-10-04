// Admin CLI: `node src/cli.js <command>`.

import { search } from "./services/catalog.js"
import { listMembers } from "./services/members.js"
import { overdue } from "./services/loans.js"
import * as store from "./db/store.js"
import { formatFee } from "./services/fees.js"
import { formatDay } from "./utils/dates.js"

const commands = {
  books() {
    for (const book of search({ size: 1000 }).items) {
      console.log(`${book.id.padEnd(10)} ${book.available ? "in " : "out"}  ${book.title} — ${book.author}`)
    }
  },
  members() {
    for (const member of listMembers()) {
      console.log(`${member.id.padEnd(10)} ${member.name.padEnd(16)} owes ${formatFee(member.balance)}`)
    }
  },
  loans() {
    for (const loan of store.where("loans", (l) => l.returned === null)) {
      console.log(`${loan.id.padEnd(10)} ${loan.bookId} -> ${loan.memberId} due ${formatDay(loan.due)}`)
    }
  },
  overdue() {
    for (const loan of overdue()) {
      console.log(`${loan.id.padEnd(10)} ${loan.daysLate} days late, ${formatFee(loan.feeSoFar)}`)
    }
  },
}

const name = process.argv[2]
if (!commands[name]) {
  console.log(`usage: node src/cli.js <${Object.keys(commands).join("|")}>`)
  process.exit(name ? 1 : 0)
}
commands[name]()

import { test } from "node:test"
import assert from "node:assert/strict"
import { fresh, START, later } from "./helpers.js"
import { borrow, giveBack, renew, overdue, activeLoans, sendReminders } from "../src/services/loans.js"
import { getMember } from "../src/services/members.js"
import { isAvailable } from "../src/services/catalog.js"
import * as notifications from "../src/services/notifications.js"
import { MAX_LOANS_PER_MEMBER, LOAN_DAYS } from "../src/config.js"

test("borrowing makes the book unavailable until it is returned", () => {
  const { books, members } = fresh()
  const loan = borrow({ bookId: books[0].id, memberId: members[0].id, at: START })
  assert.equal(isAvailable(books[0].id), false)
  giveBack({ loanId: loan.id, at: later(3) })
  assert.equal(isAvailable(books[0].id), true)
})

test("a book on loan cannot be borrowed by someone else", () => {
  const { books, members } = fresh()
  borrow({ bookId: books[0].id, memberId: members[0].id, at: START })
  assert.throws(() => borrow({ bookId: books[0].id, memberId: members[1].id, at: START }), /not available/)
})

test("members cannot go over the loan limit", () => {
  const { books, members } = fresh()
  for (let i = 0; i < MAX_LOANS_PER_MEMBER; i++) borrow({ bookId: books[i].id, memberId: members[0].id, at: START })
  assert.throws(
    () => borrow({ bookId: books[MAX_LOANS_PER_MEMBER].id, memberId: members[0].id, at: START }),
    /already has/,
  )
  assert.equal(activeLoans(members[0].id).length, MAX_LOANS_PER_MEMBER)
})

test("returning late charges the member", () => {
  const { books, members } = fresh()
  const loan = borrow({ bookId: books[1].id, memberId: members[1].id, at: START })
  const returned = giveBack({ loanId: loan.id, at: later(LOAN_DAYS + 4) })
  assert.equal(returned.fee, 2)
  assert.equal(getMember(members[1].id).balance, 2)
})

test("renewing moves the due date, but not when overdue", () => {
  const { books, members } = fresh()
  const loan = borrow({ bookId: books[2].id, memberId: members[2].id, at: START })
  const renewed = renew({ loanId: loan.id, at: later(5) })
  assert.notEqual(renewed.due, loan.due)
  assert.throws(() => renew({ loanId: loan.id, at: later(40) }), /overdue/)
})

test("overdue lists late loans and reminders are queued", () => {
  const { books, members } = fresh()
  borrow({ bookId: books[3].id, memberId: members[3].id, at: START })
  assert.equal(overdue(later(LOAN_DAYS + 1)).length, 1)
  assert.equal(sendReminders(later(LOAN_DAYS + 1)), 1)
  assert.match(notifications.pending()[0].subject, /overdue/)
})

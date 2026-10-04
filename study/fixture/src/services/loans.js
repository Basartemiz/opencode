// Borrowing, returning and renewing books.

import * as store from "../db/store.js"
import { newLoan, isActive } from "../models/loan.js"
import { getBook, isAvailable } from "./catalog.js"
import { getMember, charge, isBlocked } from "./members.js"
import { lateFee, daysOverdue, formatFee } from "./fees.js"
import * as notifications from "./notifications.js"
import { ConflictError, ForbiddenError, NotFoundError } from "../utils/errors.js"
import { addDays, iso, isBefore, now } from "../utils/dates.js"
import { MAX_LOANS_PER_MEMBER, RENEWAL_LIMIT, RENEWAL_DAYS, REMINDER_DAYS_BEFORE } from "../config.js"

export function getLoan(id) {
  const loan = store.get("loans", id)
  if (!loan) throw new NotFoundError("loan", id)
  return loan
}

export function activeLoans(memberId) {
  return store.where("loans", (loan) => loan.memberId === memberId && isActive(loan))
}

export function borrow({ bookId, memberId, at = now() }) {
  const member = getMember(memberId)
  const book = getBook(bookId)
  if (isBlocked(member)) {
    throw new ForbiddenError(`${member.name} owes ${formatFee(member.balance)} and must pay before borrowing`)
  }
  if (activeLoans(memberId).length >= MAX_LOANS_PER_MEMBER) {
    throw new ForbiddenError(`${member.name} already has ${MAX_LOANS_PER_MEMBER} books`)
  }
  if (activeLoans(memberId).some((loan) => loan.bookId === bookId)) {
    throw new ConflictError(`${member.name} already has "${book.title}"`)
  }
  if (!isAvailable(bookId)) {
    throw new ConflictError(`"${book.title}" is not available right now`)
  }
  return store.insert("loans", newLoan({ id: store.nextId("loan"), bookId, memberId, at }))
}

export function giveBack({ loanId, at = now() }) {
  const loan = getLoan(loanId)
  if (!isActive(loan)) throw new ConflictError(`loan ${loanId} was already returned`)
  const fee = lateFee(loan, at)
  const updated = store.update("loans", loanId, { returned: iso(at), fee })
  const member = getMember(loan.memberId)
  if (fee > 0) charge(member.id, fee)
  const book = getBook(loan.bookId)
  const message = notifications.templates.returned(book, fee)
  notifications.queue(member, message.subject, message.body)
  return updated
}

export function renew({ loanId, at = now() }) {
  const loan = getLoan(loanId)
  if (!isActive(loan)) throw new ConflictError(`loan ${loanId} was already returned`)
  if (loan.renewals >= RENEWAL_LIMIT) throw new ForbiddenError(`loan ${loanId} cannot be renewed again`)
  if (!isBefore(at, loan.due)) throw new ForbiddenError(`loan ${loanId} is overdue and cannot be renewed`)
  return store.update("loans", loanId, {
    due: iso(addDays(loan.due, RENEWAL_DAYS)),
    renewals: loan.renewals + 1,
  })
}

export function overdue(at = now()) {
  return store
    .where("loans", (loan) => isActive(loan) && isBefore(loan.due, at))
    .map((loan) => ({ ...loan, daysLate: daysOverdue(loan, at), feeSoFar: lateFee(loan, at) }))
}

// Sends "due soon" and "overdue" messages. The server runs this once a day.
export function sendReminders(at = now()) {
  let count = 0
  for (const loan of store.where("loans", isActive)) {
    const member = getMember(loan.memberId)
    const book = getBook(loan.bookId)
    if (isBefore(loan.due, at)) {
      const days = daysOverdue(loan, at)
      const message = notifications.templates.overdue(book, days, formatFee(lateFee(loan, at)))
      notifications.queue(member, message.subject, message.body)
      count++
    } else if (!loan.reminded && isBefore(loan.due, addDays(at, REMINDER_DAYS_BEFORE))) {
      const message = notifications.templates.dueSoon(book, loan)
      notifications.queue(member, message.subject, message.body)
      store.update("loans", loan.id, { reminded: true })
      count++
    }
  }
  return count
}

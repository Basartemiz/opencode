import { addDays, iso } from "../utils/dates.js"
import { LOAN_DAYS } from "../config.js"

// A loan is "active" until the book comes back.
export function newLoan({ id, bookId, memberId, at }) {
  return {
    id,
    bookId,
    memberId,
    borrowed: iso(at),
    due: iso(addDays(at, LOAN_DAYS)),
    returned: null,
    renewals: 0,
    fee: 0,
    reminded: false,
  }
}

export function isActive(loan) {
  return loan.returned === null
}

export function publicLoan(loan) {
  return {
    id: loan.id,
    bookId: loan.bookId,
    memberId: loan.memberId,
    borrowed: loan.borrowed,
    due: loan.due,
    returned: loan.returned,
    renewals: loan.renewals,
    fee: loan.fee,
  }
}

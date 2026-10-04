// Late fees for overdue loans.

import { LATE_FEE_PER_DAY, MAX_FEE_PER_LOAN } from "../config.js"
import { daysBetween } from "../utils/dates.js"

// The fee for returning `loan` at `at`: a daily rate after the due date, capped per loan.
export function lateFee(loan, at) {
  const late = daysBetween(loan.due, at)
  if (late === 0) return 0
  return Math.min(late * LATE_FEE_PER_DAY, MAX_FEE_PER_LOAN)
}

export function daysOverdue(loan, at) {
  return daysBetween(loan.due, at)
}

export function formatFee(amount) {
  return `€${amount.toFixed(2)}`
}

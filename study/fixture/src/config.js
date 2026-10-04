// Library rules. Other modules import these instead of hard-coding numbers.

export const LOAN_DAYS = 14
export const MAX_LOANS_PER_MEMBER = 5
export const RENEWAL_LIMIT = 2
export const RENEWAL_DAYS = 7

// Late fees, in euros.
export const LATE_FEE_PER_DAY = 0.5
export const MAX_FEE_PER_LOAN = 20
// Members who owe more than this cannot borrow until they pay.
export const BLOCKING_BALANCE = 10

// Days before the due date when a reminder is sent.
export const REMINDER_DAYS_BEFORE = 2

export const DEFAULT_PAGE_SIZE = 20

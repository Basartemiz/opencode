// Date helpers. All dates are stored as ISO strings in UTC.

const DAY_MS = 24 * 60 * 60 * 1000

export function now() {
  return new Date()
}

export function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * DAY_MS)
}

export function addHours(date, hours) {
  return new Date(new Date(date).getTime() + hours * 60 * 60 * 1000)
}

// Whole days from `from` to `to`, rounded up, never negative.
export function daysBetween(from, to) {
  const diff = new Date(to).getTime() - new Date(from).getTime()
  if (diff <= 0) return 0
  return Math.ceil(diff / DAY_MS)
}

export function isBefore(a, b) {
  return new Date(a).getTime() < new Date(b).getTime()
}

export function iso(date) {
  return new Date(date).toISOString()
}

export function formatDay(date) {
  return iso(date).slice(0, 10)
}

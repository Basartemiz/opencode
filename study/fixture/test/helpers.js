import * as store from "../src/db/store.js"
import * as notifications from "../src/services/notifications.js"

export function fresh() {
  store.reset()
  notifications.clear()
  notifications.setSender(() => {})
  return {
    books: store.all("books"),
    members: store.all("members"),
  }
}

export const DAY = 24 * 60 * 60 * 1000
export const START = new Date("2026-03-01T10:00:00.000Z")
export const later = (days) => new Date(START.getTime() + days * DAY)

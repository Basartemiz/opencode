// In-memory store. Each collection is a Map from id to record.
// Records are copied on the way in and out so callers cannot change stored data by accident.

import { seed } from "./seed.js"

const collections = {
  books: new Map(),
  members: new Map(),
  loans: new Map(),
  payments: new Map(),
}

let counters = {}

function copy(record) {
  return record === undefined ? undefined : structuredClone(record)
}

export function nextId(prefix) {
  counters[prefix] = (counters[prefix] ?? 0) + 1
  return `${prefix}_${counters[prefix].toString(36)}`
}

export function insert(collection, record) {
  collections[collection].set(record.id, copy(record))
  return copy(record)
}

export function update(collection, id, changes) {
  const current = collections[collection].get(id)
  if (!current) return undefined
  const next = { ...current, ...changes }
  collections[collection].set(id, next)
  return copy(next)
}

export function get(collection, id) {
  return copy(collections[collection].get(id))
}

export function all(collection) {
  return [...collections[collection].values()].map(copy)
}

export function where(collection, predicate) {
  return all(collection).filter(predicate)
}

export function remove(collection, id) {
  return collections[collection].delete(id)
}

// Empties the store and loads the seed data again. Tests call this before each case.
export function reset({ withSeed = true } = {}) {
  for (const map of Object.values(collections)) map.clear()
  counters = {}
  if (withSeed) seed({ insert, nextId })
}

reset()

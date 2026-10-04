import { AppError } from "./errors.js"

export function requireString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== "string") throw new AppError(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length < min) throw new AppError(`${field} is required`)
  if (trimmed.length > max) throw new AppError(`${field} is too long`)
  return trimmed
}

export function requireId(value, field) {
  if (typeof value !== "string" || !/^[a-z]+_[a-z0-9]+$/.test(value)) {
    throw new AppError(`${field} is not a valid id`)
  }
  return value
}

export function optionalInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === "") return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppError(`${field} must be a whole number between ${min} and ${max}`)
  }
  return number
}

export function requireEmail(value) {
  const email = requireString(value, "email", { max: 120 }).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("email is not valid")
  return email
}

import { requireString, optionalInt } from "../utils/validate.js"
import { AppError } from "../utils/errors.js"

export const GENRES = ["fiction", "tech", "science", "comics", "history", "kids"]

export function newBook(input, id) {
  const genre = requireString(input.genre ?? "fiction", "genre")
  if (!GENRES.includes(genre)) throw new AppError(`genre must be one of ${GENRES.join(", ")}`)
  return {
    id,
    title: requireString(input.title, "title"),
    author: requireString(input.author, "author"),
    genre,
    year: optionalInt(input.year, "year", { min: 1000, max: 2100 }),
    copies: optionalInt(input.copies, "copies", { min: 1, max: 50 }) ?? 1,
    active: true,
  }
}

export function publicBook(book, { available } = {}) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    genre: book.genre,
    year: book.year,
    copies: book.copies,
    ...(available === undefined ? {} : { available }),
  }
}

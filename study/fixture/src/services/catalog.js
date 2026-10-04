// Books: adding, searching and checking availability.

import * as store from "../db/store.js"
import { newBook, publicBook } from "../models/book.js"
import { isActive } from "../models/loan.js"
import { NotFoundError } from "../utils/errors.js"
import { DEFAULT_PAGE_SIZE } from "../config.js"

export function getBook(id) {
  const book = store.get("books", id)
  if (!book || !book.active) throw new NotFoundError("book", id)
  return book
}

export function addBook(input) {
  return store.insert("books", newBook(input, store.nextId("book")))
}

export function retireBook(id) {
  getBook(id)
  return store.update("books", id, { active: false })
}

// How many copies are on the shelf right now.
export function availableCopies(bookId) {
  const book = getBook(bookId)
  const out = store.where("loans", (loan) => loan.bookId === bookId && isActive(loan)).length
  return Math.max(0, book.copies - out)
}

export function isAvailable(bookId) {
  return availableCopies(bookId) > 0
}

export function search({ q, genre, available, page = 1, size = DEFAULT_PAGE_SIZE } = {}) {
  const needle = q?.trim().toLowerCase()
  let books = store.where("books", (book) => book.active)
  if (needle) {
    books = books.filter(
      (book) => book.title.toLowerCase().includes(needle) || book.author.toLowerCase().includes(needle),
    )
  }
  if (genre) books = books.filter((book) => book.genre === genre)
  let results = books.map((book) => publicBook(book, { available: availableCopies(book.id) > 0 }))
  if (available !== undefined) results = results.filter((book) => book.available === available)
  results.sort((a, b) => a.title.localeCompare(b.title))
  const start = (page - 1) * size
  return { total: results.length, page, size, items: results.slice(start, start + size) }
}

import { test } from "node:test"
import assert from "node:assert/strict"
import { fresh, START } from "./helpers.js"
import { search, addBook, retireBook, getBook } from "../src/services/catalog.js"
import { borrow } from "../src/services/loans.js"

test("search matches title and author, case-insensitive", () => {
  fresh()
  assert.equal(search({ q: "snow" }).total, 1)
  assert.equal(search({ q: "KLEPPMANN" }).total, 1)
})

test("search can filter by availability", () => {
  const { books, members } = fresh()
  borrow({ bookId: books[0].id, memberId: members[0].id, at: START })
  const out = search({ available: false })
  assert.deepEqual(out.items.map((b) => b.id), [books[0].id])
})

test("retired books disappear", () => {
  fresh()
  const book = addBook({ title: "Dune", author: "Frank Herbert", genre: "fiction", year: 1965 })
  retireBook(book.id)
  assert.throws(() => getBook(book.id), /not found/)
})

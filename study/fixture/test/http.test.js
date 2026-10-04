import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "../src/http/server.js"
import { fresh } from "./helpers.js"

let server
let base

before(async () => {
  server = createServer()
  await new Promise((resolve) => server.listen(0, resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}

test("borrow and return over HTTP", async () => {
  const { books, members } = fresh()
  const created = await call("POST", "/loans", { bookId: books[0].id, memberId: members[0].id })
  assert.equal(created.status, 201)
  const again = await call("POST", "/loans", { bookId: books[0].id, memberId: members[1].id })
  assert.equal(again.status, 409)
  const back = await call("POST", `/loans/${created.body.id}/return`)
  assert.equal(back.status, 200)
  assert.ok(back.body.returned)
})

test("unknown routes and ids give 404", async () => {
  fresh()
  assert.equal((await call("GET", "/nope")).status, 404)
  assert.equal((await call("GET", "/books/book_zz")).status, 404)
})

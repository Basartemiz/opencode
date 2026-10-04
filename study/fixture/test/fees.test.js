import { test } from "node:test"
import assert from "node:assert/strict"
import { lateFee, formatFee } from "../src/services/fees.js"
import { LATE_FEE_PER_DAY, MAX_FEE_PER_LOAN } from "../src/config.js"
import { later } from "./helpers.js"

const loan = { due: later(0).toISOString() }

test("no fee when returned on time", () => {
  assert.equal(lateFee(loan, later(0)), 0)
})

test("fee grows per late day", () => {
  assert.equal(lateFee(loan, later(3)), 3 * LATE_FEE_PER_DAY)
})

test("fee is capped per loan", () => {
  assert.equal(lateFee(loan, later(1000)), MAX_FEE_PER_LOAN)
})

test("formatFee shows euros with cents", () => {
  assert.equal(formatFee(2.5), "€2.50")
})

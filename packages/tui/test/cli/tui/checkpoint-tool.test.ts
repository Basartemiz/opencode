import { describe, expect, test } from "bun:test"
import { formatCheckpoint, toolDisplay } from "../../../src/routes/session"

describe("checkpoint tool row", () => {
  test("has its own row instead of the generic one, which lists every input such as the long explanation", () => {
    expect(toolDisplay("checkpoint")).toBe("checkpoint")
  })

  test("shows the checkpoint number, its title, and the user's decision", () => {
    expect(formatCheckpoint({ title: "Add discount codes" }, { number: 1, revision: 1 })).toBe(
      "Checkpoint 1: Add discount codes",
    )
    expect(formatCheckpoint({ title: "Declare the code" }, { number: 1, revision: 2, decision: "approve" })).toBe(
      "Checkpoint 1 (revision 2): Declare the code · approved",
    )
  })

  test("says when there was nothing to review", () => {
    expect(formatCheckpoint({ title: "Rename" }, { skipped: true })).toBe("Checkpoint skipped: no files changed")
  })

  test("is empty while the checkpoint is still being prepared", () => {
    expect(formatCheckpoint({ title: "Rename" }, {})).toBeUndefined()
  })
})

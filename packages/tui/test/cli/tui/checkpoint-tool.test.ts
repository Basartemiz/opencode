import { describe, expect, test } from "bun:test"
import { formatCheckpoint, formatCheckpointError, toolDisplay } from "../../../src/routes/session"

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

  test("says in one line why a checkpoint did not reach the user", () => {
    expect(formatCheckpointError("Checkpoint sent back: your explanation does not match what changed")).toBe(
      "Checkpoint sent back: the agent's notes did not match the changes, so it is rewriting them",
    )
    expect(
      formatCheckpointError("The checkpoint tool was called with invalid arguments: SchemaError(Missing key)"),
    ).toBe("Checkpoint incomplete: the agent left out a part of its explanation and is trying again")
    expect(formatCheckpointError("something else")).toBe("Checkpoint failed")
  })
})

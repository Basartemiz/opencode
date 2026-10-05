import { describe, expect, test } from "bun:test"
import { CheckpointFeedback } from "../../src/checkpoint/feedback"

const patch = (file: string, ...body: string[]) => [`Index: ${file}`, `--- ${file}`, `+++ ${file}`, ...body].join("\n")

// A whole-file patch, as git snapshots store it: a change in objectId(), and one in password() far below it.
const file = {
  file: "src/validations/custom.validation.js",
  patch: patch(
    "src/validations/custom.validation.js",
    "@@ -1,13 +1,13 @@",
    "-const objectId = (value, helpers) => {",
    "+const objectId = (value, helpers = {}) => {",
    "   if (!value.match(/^[0-9a-fA-F]{24}$/)) {",
    "     return helpers.message('must be a valid id');",
    "   }",
    "   return value;",
    " };",
    " ",
    " const password = (value, helpers) => {",
    "-  if (value.length < 8) {",
    "-    return helpers.message('password must be at least 8 characters');",
    "+  if (value.length < 4) {",
    "+    return helpers.message('password must be at least 4 characters');",
    "   }",
    "   return value;",
    " };",
  ),
  symbols: [
    { name: "objectId", kind: "function" as const, change: "changed" as const, start: 1, end: 6 },
    { name: "password", kind: "function" as const, change: "changed" as const, start: 8, end: 13 },
  ],
}
const checkpoint = { number: 1, revision: 1 }

describe("CheckpointFeedback.message", () => {
  test("names the file, the function, the lines, and the checkpoint before what the user wants", () => {
    expect(CheckpointFeedback.message({ checkpoint, file, chunk: 1, action: "revert" })).toBe(
      "In src/validations/custom.validation.js, password(), lines 9–10 (checkpoint 1): revert this change.",
    )
    expect(
      CheckpointFeedback.message({ checkpoint, file, chunk: 0, action: "change", text: "  Drop the default.  " }),
    ).toBe("In src/validations/custom.validation.js, objectId(), line 1 (checkpoint 1): Drop the default.")
  })

  test("adds what the user wrote after a revert", () => {
    expect(CheckpointFeedback.message({ checkpoint, file, chunk: 1, action: "revert", text: "The tests need 8." })).toBe(
      "In src/validations/custom.validation.js, password(), lines 9–10 (checkpoint 1): revert this change. The tests need 8.",
    )
  })

  test("leaves out the function for a change outside one, and names the revision", () => {
    const top = { file: "src/config.js", patch: patch("src/config.js", "@@ -1,2 +1,1 @@", "-const DEBUG = true", " const PORT = 3000") }

    expect(CheckpointFeedback.message({ checkpoint: { number: 2, revision: 3 }, file: top, chunk: 0, action: "revert" })).toBe(
      "In src/config.js, removed line 1 (checkpoint 2, revision 3): revert this change.",
    )
  })

  test("has no message for a change the file does not have, or a change request without text", () => {
    expect(CheckpointFeedback.message({ checkpoint, file, chunk: 5, action: "revert" })).toBeUndefined()
    expect(CheckpointFeedback.message({ checkpoint, file, chunk: 0, action: "change", text: "  " })).toBeUndefined()
  })
})

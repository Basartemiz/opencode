import { describe, expect, test } from "bun:test"
import { CheckpointExplain } from "../../src/checkpoint/explain"

const patch = (file: string, ...body: string[]) => [`Index: ${file}`, `--- ${file}`, `+++ ${file}`, ...body].join("\n")

// A whole-file patch, as git snapshots store it: two changes far apart in one block.
const file = {
  file: "src/validations/custom.validation.js",
  status: "modified" as const,
  patch: patch(
    "src/validations/custom.validation.js",
    "@@ -1,14 +1,14 @@",
    " const objectId = (value, helpers) => {",
    "-  if (!value.match(/^[0-9a-fA-F]{24}$/)) {",
    "+  if (!/^[0-9a-fA-F]{24}$/.test(value)) {",
    "     return helpers.message('must be a valid id');",
    "   }",
    "   return value;",
    " };",
    " ",
    " // Passwords need a letter and a number.",
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
    { name: "password", kind: "function" as const, change: "changed" as const, start: 9, end: 14 },
  ],
}

describe("CheckpointExplain.request", () => {
  test("gives the model only the facts of one change: where it is, its lines, and the files that import the file", () => {
    expect(
      CheckpointExplain.request({
        title: "Lower the password minimum",
        file,
        chunk: 1,
        importers: ["src/validations/user.validation.js"],
      }),
    ).toBe(
      [
        "Checkpoint: Lower the password minimum",
        "File: src/validations/custom.validation.js (changed)",
        "Files that import it: src/validations/user.validation.js",
        "",
        "The change to explain (+ added, - removed, other lines unchanged):",
        "Lines 10–11, in password():",
        "  ",
        "  // Passwords need a letter and a number.",
        "  const password = (value, helpers) => {",
        "-   if (value.length < 8) {",
        "-     return helpers.message('password must be at least 8 characters');",
        "+   if (value.length < 4) {",
        "+     return helpers.message('password must be at least 4 characters');",
        "    }",
        "    return value;",
        "  };",
        "",
        "Explain what this change does and what it means for the code that uses it.",
      ].join("\n"),
    )
  })

  test("covers every change of the file when no change is picked, and ends with the user's question", () => {
    const text = CheckpointExplain.request({
      title: "Lower the password minimum",
      file,
      importers: [],
      question: "  Why is 4 enough?  ",
    })

    expect(text).toContain("Files that import it: none found")
    expect(text).toContain("Its changes (+ added, - removed, other lines unchanged):")
    expect(text).toContain("Line 2, in objectId():")
    expect(text).toContain("Lines 10–11, in password():")
    expect(text.endsWith("The user asks: Why is 4 enough?")).toBe(true)
  })

  test("keeps a long file to a few screens of lines", () => {
    const long = {
      ...file,
      symbols: [],
      patch: patch("src/big.js", "@@ -0,0 +1,400 @@", ...Array.from({ length: 400 }, (_, index) => `+line ${index}`)),
    }

    const lines = CheckpointExplain.request({ title: "Big", file: long, importers: [] }).split("\n")

    expect(lines.length).toBeLessThan(170)
    expect(lines).toContain("… 251 more lines")
  })
})

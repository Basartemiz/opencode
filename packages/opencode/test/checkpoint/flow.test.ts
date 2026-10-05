import { describe, expect, test } from "bun:test"
import { CheckpointFlow } from "../../src/checkpoint/flow"

const patch = (file: string, ...body: string[]) => [`Index: ${file}`, `--- ${file}`, `+++ ${file}`, ...body].join("\n")

const files = [
  {
    file: "src/auth.js",
    status: "added" as const,
    additions: 2,
    deletions: 0,
    patch: patch("src/auth.js", "@@ -0,0 +1,2 @@", "+export function login(user) {", "+}"),
    symbols: [{ name: "login", kind: "function" as const, change: "added" as const, start: 1, end: 2 }],
  },
  {
    file: "src/old.js",
    status: "deleted" as const,
    additions: 0,
    deletions: 1,
    patch: patch("src/old.js", "@@ -1 +0,0 @@", "-x"),
  },
]
const links = [
  { from: "src/server.js", to: "src/auth.js" },
  { from: "src/auth.js", to: "src/db.js" },
]

describe("CheckpointFlow.boxes", () => {
  test("allows the files around the change: the changed ones, what they import, and what imports them", () => {
    expect(CheckpointFlow.boxes(files, links)).toEqual(["src/auth.js", "src/server.js", "src/db.js"])
  })
})

describe("CheckpointFlow.request", () => {
  test("gives the model only the facts of the change, with the boxes it may use", () => {
    const text = CheckpointFlow.request({
      steps: ["I added login() to auth.js."],
      impact: "Users can log in.",
      files,
      links,
      boxes: CheckpointFlow.boxes(files, links),
    })

    expect(text).toBe(
      [
        "Boxes you may use:",
        "- user",
        "- src/auth.js",
        "- src/server.js",
        "- src/db.js",
        "",
        "Which file imports which:",
        "- src/server.js imports src/auth.js",
        "- src/auth.js imports src/db.js",
        "",
        "What changed:",
        "- src/auth.js: new file, +2; login() (new)",
        "    + export function login(user) {",
        "    + }",
        "- src/old.js: deleted, -1",
        "    - x",
        "",
        "What the agent that made the change says it did:",
        "1. I added login() to auth.js.",
        "Impact: Users can log in.",
      ].join("\n"),
    )
  })
})

describe("CheckpointFlow.parse", () => {
  const boxes = ["src/auth.js", "src/server.js", "src/db.js"]

  test("reads the arrows of the model's answer, even inside a code block", () => {
    const answer = [
      "```json",
      JSON.stringify({
        flow: [
          { from: "User", to: "./src/server.js", action: "posts the login form to /login" },
          { from: "src/server.js", to: "src/auth.js", action: "asks login() to check the password" },
          { from: "src/auth.js", to: "src/auth.js", action: "compares the password hash" },
        ],
      }),
      "```",
    ].join("\n")

    expect(CheckpointFlow.parse(answer, boxes)).toEqual([
      { from: "user", to: "src/server.js", action: "posts the login form to /login" },
      { from: "src/server.js", to: "src/auth.js", action: "asks login() to check the password" },
      { from: "src/auth.js", to: "src/auth.js", action: "compares the password hash" },
    ])
  })

  test("leaves out arrows whose boxes are routes, words like system, or files the change does not touch", () => {
    const answer = JSON.stringify({
      flow: [
        { from: "user", to: "/register", action: "posts registration data" },
        { from: "System", to: "user", action: "responds with a token" },
        { from: "src/auth.js", to: "src/payments.js", action: "charges the card" },
        { from: "src/auth.js", to: "src/db.js", action: "looks up the user" },
      ],
    })

    expect(CheckpointFlow.parse(answer, boxes)).toEqual([
      { from: "src/auth.js", to: "src/db.js", action: "looks up the user" },
    ])
  })

  test("finds nothing in an answer that is not the expected JSON", () => {
    expect(CheckpointFlow.parse("I could not draw it.", boxes)).toEqual([])
    expect(CheckpointFlow.parse('{"arrows": []}', boxes)).toEqual([])
  })

  test("keeps at most seven arrows", () => {
    const step = { from: "user", to: "src/auth.js", action: "logs in" }

    expect(CheckpointFlow.parse(JSON.stringify({ flow: Array.from({ length: 9 }, () => step) }), boxes)).toHaveLength(7)
  })
})

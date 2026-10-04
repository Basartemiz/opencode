import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Checkpoint } from "../../src/checkpoint"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { it } from "../lib/effect"

const sessionID = SessionID.make("ses_checkpoint")
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

type PartInput = (messageID: MessageID) => SessionV1.Part

function user(created = 0): SessionV1.WithParts {
  return {
    info: { id: MessageID.ascending(), sessionID, role: "user", time: { created }, agent: "understand", model },
    parts: [],
  }
}

function assistant(
  agent: string,
  parts: PartInput[],
  extra: Partial<Pick<SessionV1.Assistant, "time" | "cost" | "tokens">> = {},
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 0 },
      parentID: MessageID.ascending(),
      modelID: model.modelID,
      providerID: model.providerID,
      mode: agent,
      agent,
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...extra,
    },
    parts: parts.map((part) => part(id)),
  }
}

const stepStart =
  (snapshot?: string): PartInput =>
  (messageID) => ({ id: PartID.ascending(), sessionID, messageID, type: "step-start", snapshot })

const tool =
  (name: string, state: SessionV1.ToolState): PartInput =>
  (messageID) => ({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "tool",
    tool: name,
    callID: `call_${PartID.ascending()}`,
    state,
  })

const completed = (metadata: Record<string, unknown>): SessionV1.ToolState => ({
  status: "completed",
  input: {},
  output: "",
  title: "",
  metadata,
  time: { start: 0, end: 0 },
})

const failed = (metadata?: Record<string, unknown>, error = "failed"): SessionV1.ToolState => ({
  status: "error",
  input: {},
  error,
  metadata,
  time: { start: 0, end: 0 },
})

const running = (metadata: Record<string, unknown>): SessionV1.ToolState => ({
  status: "running",
  input: {},
  metadata,
  time: { start: 0 },
})

const edit = (file: string, additions: number, deletions: number) =>
  tool("edit", completed({ filediff: { file, additions, deletions } }))

const record = (input: { number: number; revision?: number; decision: string; snapshot?: string }) => ({
  number: input.number,
  revision: input.revision ?? 1,
  title: `Checkpoint ${input.number}`,
  steps: ["I changed a file."],
  impact: "impact",
  snapshot: input.snapshot,
  files: [],
  decision: input.decision,
  time: { asked: 0, answered: 0 },
})

const result = (metadata: Record<string, unknown>) => Effect.succeed({ title: "", output: "", metadata })

const tokens = (input: number, output: number) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } })

const changed = (file: string, additions = 1, deletions = 0) => result({ filediff: { file, additions, deletions } })

const agent = (checkpoint?: Checkpoint.Limits) => ({ name: "understand", checkpoint })

const patch = (file: string, ...body: string[]) =>
  [
    `Index: ${file}`,
    "===================================================================",
    `--- ${file}`,
    `+++ ${file}`,
    ...body,
  ].join("\n")
const first = patch("a.ts", "@@ -1 +1 @@", "-a", "+b")
const second = patch("a.ts", "@@ -5,0 +6,1 @@", "+c")

describe("Checkpoint.hunks", () => {
  test("parses hunk ranges and per-hunk line counts from a unified diff", () => {
    const patch = [
      "Index: a.ts",
      "===================================================================",
      "--- a.ts",
      "+++ a.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1",
      "-const b = 2",
      "+const b = 3",
      "+const c = 4",
      " export {}",
      "@@ -10 +11,0 @@",
      "-removed",
      "\\ No newline at end of file",
    ].join("\n")

    expect(Checkpoint.hunks(patch)).toEqual([
      { before: { start: 1, lines: 3 }, after: { start: 1, lines: 4 }, additions: 2, deletions: 1 },
      { before: { start: 10, lines: 1 }, after: { start: 11, lines: 0 }, additions: 0, deletions: 1 },
    ])
  })
})

describe("Checkpoint.hunks with combined patches", () => {
  test("reads each patch separately when several edits of one file are combined", () => {
    expect(Checkpoint.hunks(`${first}\n${second}`)).toEqual([
      { before: { start: 1, lines: 1 }, after: { start: 1, lines: 1 }, additions: 1, deletions: 1 },
      { before: { start: 5, lines: 0 }, after: { start: 6, lines: 1 }, additions: 1, deletions: 0 },
    ])
  })
})

describe("Checkpoint.blocks", () => {
  test("splits a diff into changed blocks with line numbers on both sides", () => {
    const text = patch(
      "a.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1",
      "-const b = 2",
      "+const b = 3",
      "+const c = 4",
      " export {}",
      "\\ No newline at end of file",
    )

    expect(Checkpoint.blocks(text)).toEqual([
      {
        before: { start: 1, lines: 3 },
        after: { start: 1, lines: 4 },
        lines: [
          { kind: "same", text: "const a = 1", old: 1, new: 1 },
          { kind: "del", text: "const b = 2", old: 2 },
          { kind: "add", text: "const b = 3", new: 2 },
          { kind: "add", text: "const c = 4", new: 3 },
          { kind: "same", text: "export {}", old: 3, new: 4 },
        ],
      },
    ])
  })

  test("reads each patch separately when several edits of one file are combined", () => {
    expect(
      Checkpoint.blocks(`${first}\n${second}`).map((block) => block.lines.map((line) => `${line.kind} ${line.text}`)),
    ).toEqual([["del a", "add b"], ["add c"]])
  })
})

describe("Checkpoint.edited", () => {
  test("collects the agent's file edits since the last checkpoint, one entry per file", () => {
    const messages = [
      user(),
      assistant("understand", [
        tool("edit", completed({ filediff: { file: "/p/old.ts", patch: first, additions: 1, deletions: 1 } })),
        tool("checkpoint", completed(record({ number: 1, decision: "approve" }))),
        tool("edit", completed({ filediff: { file: "/p/a.ts", patch: first, additions: 1, deletions: 1 } })),
        tool("edit", completed({ filediff: { file: "/p/a.ts", patch: second, additions: 1, deletions: 0 } })),
        tool(
          "write",
          completed({
            exists: false,
            filediff: {
              file: "/p/b.ts",
              patch: patch("b.ts", "@@ -0,0 +1,2 @@", "+x", "+y"),
              additions: 2,
              deletions: 0,
            },
          }),
        ),
        tool(
          "apply_patch",
          completed({
            files: [
              {
                filePath: "/p/c.ts",
                type: "delete",
                patch: patch("c.ts", "@@ -1,3 +0,0 @@", "-x", "-y", "-z"),
                additions: 0,
                deletions: 3,
              },
            ],
          }),
        ),
        tool("edit", failed()),
      ]),
    ]

    expect(
      Checkpoint.edited(messages, "understand").map((file) => [
        file.file,
        file.status,
        file.additions,
        file.deletions,
        file.hunks.length,
      ]),
    ).toEqual([
      ["/p/a.ts", "modified", 2, 1, 2],
      ["/p/b.ts", "added", 2, 0, 1],
      ["/p/c.ts", "deleted", 0, 3, 1],
    ])
  })
})

describe("Checkpoint.summary", () => {
  const checkpoint = {
    number: 1,
    revision: 1,
    title: "Rename",
    steps: ["I renamed greet to welcome.", "I updated its two callers."],
    impact: "Callers change.",
  }

  test("fits on one screen: one line per step, a compact file list, and the map link", () => {
    const text = Checkpoint.summary(
      {
        ...checkpoint,
        files: [
          { file: "README.md", status: "added", additions: 26, deletions: 0, hunks: [], patch: first },
          { file: "src/cart.js", status: "modified", additions: 6, deletions: 2, hunks: [] },
        ],
      },
      "http://127.0.0.1:4000/a1b2c3/ses_1",
    )

    expect(text).toBe(
      [
        "Checkpoint 1: Rename",
        "",
        "Agent says (not verified):",
        "  1. I renamed greet to welcome.",
        "  2. I updated its two callers.",
        "  Impact: Callers change.",
        "",
        "Changed (from the diff): 2 files, +32 -2",
        "  A README.md +26   M src/cart.js +6 -2",
        "",
        "Full diff and map:",
        "  http://127.0.0.1:4000/a1b2c3/ses_1",
      ].join("\n"),
    )
  })

  test("wraps a long step onto more lines instead of cutting it", () => {
    const long = `I ${"changed many things ".repeat(10).trim()}`
    const lines = Checkpoint.summary({ ...checkpoint, steps: [long], impact: long, files: [] }).split("\n")

    const step = lines.slice(
      lines.findIndex((line) => line.startsWith("  1. ")),
      lines.findIndex((line) => line.startsWith("  Impact: ")),
    )
    expect(step.length).toBeGreaterThan(1)
    expect(step.every((line) => line.length <= 80)).toBe(true)
    expect(step.slice(1).every((line) => line.startsWith("     "))).toBe(true)
    expect(step.map((line) => line.trim()).join(" ")).toBe(`1. ${long}`)
    expect(lines.join("\n")).not.toContain("…")
  })

  test("shows every step", () => {
    const steps = Array.from({ length: 8 }, (_, index) => `I did step ${index + 1}.`)
    const text = Checkpoint.summary({ ...checkpoint, steps, files: [] })

    expect(text).toContain("  8. I did step 8.")
    expect(text).not.toContain("more steps")
  })

  test("wraps a long file list and points to the map for the rest", () => {
    const files = Array.from({ length: 30 }, (_, index) => ({
      file: `src/feature/file${index}.ts`,
      status: "added" as const,
      additions: 1,
      deletions: 0,
      hunks: [],
    }))
    const lines = Checkpoint.summary({ ...checkpoint, files }).split("\n")

    const rows = lines.filter((line) => line.startsWith("  A "))
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.length <= 80)).toBe(true)
    const shown = rows.flatMap((row) => row.trim().split("   ")).length
    expect(lines).toContain(`  … ${30 - shown} more files on the map`)
  })

  test("leaves the changed lines out, because the map shows them", () => {
    const text = Checkpoint.summary({
      ...checkpoint,
      files: [{ file: "a.ts", status: "modified", additions: 1, deletions: 1, hunks: [], patch: first }],
    })

    expect(text).toContain("M a.ts +1 -1")
    expect(text).not.toContain("+b")
  })

  test("numbers the steps itself when the agent already numbered them or split them over lines", () => {
    const text = Checkpoint.summary({
      ...checkpoint,
      steps: ["1. I renamed greet.", "2)  I updated\n   its callers."],
      files: [],
    })

    expect(text).toContain("  1. I renamed greet.\n  2. I updated its callers.\n")
  })

  test("says when the changes come from the edit tools instead of git", () => {
    const text = Checkpoint.summary({ ...checkpoint, source: "edits", files: [] })

    expect(text).toContain("shell commands are not shown")
  })
})

describe("Checkpoint.history", () => {
  test("lists answered checkpoints and the one waiting for the user, but not skipped ones", () => {
    const { decision: _, ...waiting } = record({ number: 1, revision: 2, decision: "approve" })
    const messages = [
      user(),
      assistant("understand", [
        tool("checkpoint", completed(record({ number: 1, decision: "revise" }))),
        tool("checkpoint", completed({ skipped: true, snapshot: "s1" })),
        tool("checkpoint", running(waiting)),
      ]),
    ]

    expect(
      Checkpoint.history(messages).map((entry) => [entry.number, entry.revision, entry.status, entry.decision]),
    ).toEqual([
      [1, 1, "answered", "revise"],
      [1, 2, "waiting", undefined],
    ])
  })

  test("counts a stopped checkpoint as answered", () => {
    const messages = [
      user(),
      assistant("understand", [tool("checkpoint", failed(record({ number: 1, decision: "stop" })))]),
    ]

    expect(Checkpoint.history(messages).map((entry) => [entry.status, entry.decision])).toEqual([["answered", "stop"]])
  })
})

describe("Checkpoint.stats", () => {
  const timed = (input: Parameters<typeof record>[0], asked: number, answered: number) => ({
    ...record(input),
    time: { asked, answered },
  })

  test("measures a run for a user study: decisions, waiting time, forced checkpoints, and changes", () => {
    const messages = [
      user(1_000),
      assistant(
        "understand",
        [
          stepStart("s0"),
          edit("a.ts", 3, 1),
          tool("checkpoint", completed({ ...timed({ number: 1, decision: "revise" }, 2_000, 5_000), comment: "No" })),
          edit("a.ts", 1, 0),
          tool("edit", failed(undefined, "Checkpoint required: you changed 6 files")),
          tool("checkpoint", completed(timed({ number: 1, revision: 2, decision: "approve" }, 6_000, 10_000))),
        ],
        { time: { created: 1_500, completed: 12_000 }, cost: 0.25, tokens: tokens(100, 20) },
      ),
      assistant(
        "understand",
        [
          stepStart("s1"),
          tool("write", completed({ filediff: { file: "b.ts", additions: 2, deletions: 0 } })),
          tool("checkpoint", failed(timed({ number: 2, decision: "stop" }, 13_000, 14_000))),
        ],
        { time: { created: 12_500, completed: 15_000 }, cost: 0.5, tokens: tokens(200, 30) },
      ),
    ]

    const result = Checkpoint.stats(messages)

    expect(result.agents).toEqual(["understand"])
    expect(result.run).toEqual({
      started: 1_000,
      finished: 15_000,
      totalMs: 14_000,
      waitingMs: 8_000,
      workingMs: 6_000,
    })
    expect(result.checkpoints).toEqual({ total: 3, approved: 1, revised: 1, stopped: 1, auto: 0, forced: 1 })
    expect(
      result.waits.map((wait) => [wait.number, wait.revision, wait.decision, wait.waitedMs, wait.comment]),
    ).toEqual([
      [1, 1, "revise", 3_000, "No"],
      [1, 2, "approve", 4_000, undefined],
      [2, 1, "stop", 1_000, undefined],
    ])
    expect(result.changes).toEqual({ edits: 3, files: 2, additions: 6, deletions: 1 })
    expect(result.model).toEqual({ steps: 2, cost: 0.75, tokens: { input: 300, output: 50 } })
  })

  test("also measures a build-mode run, which has no checkpoints", () => {
    const messages = [
      user(1_000),
      assistant("build", [stepStart(), edit("a.ts", 4, 0)], { time: { created: 1_100, completed: 4_000 } }),
    ]

    const result = Checkpoint.stats(messages)

    expect(result.agents).toEqual(["build"])
    expect(result.run).toEqual({ started: 1_000, finished: 4_000, totalMs: 3_000, waitingMs: 0, workingMs: 3_000 })
    expect(result.checkpoints).toEqual({ total: 0, approved: 0, revised: 0, stopped: 0, auto: 0, forced: 0 })
    expect(result.changes).toEqual({ edits: 1, files: 1, additions: 4, deletions: 0 })
  })
})

describe("Checkpoint.usage", () => {
  test("counts the different files and the lines the agent changed since the last checkpoint", () => {
    const messages = [
      user(),
      assistant("understand", [
        stepStart("s0"),
        edit("old.ts", 3, 1),
        tool("checkpoint", completed(record({ number: 1, decision: "approve" }))),
        edit("a.ts", 2, 0),
        tool("write", completed({ filediff: { file: "b.ts", additions: 5, deletions: 0 } })),
        tool(
          "apply_patch",
          completed({
            files: [
              { filePath: "a.ts", type: "update", additions: 1, deletions: 1 },
              { filePath: "c.ts", type: "add", additions: 4, deletions: 0 },
            ],
          }),
        ),
        tool("edit", failed()),
        tool("read", completed({})),
      ]),
    ]

    const used = Checkpoint.usage(messages, "understand")

    expect([...used.files]).toEqual(["a.ts", "b.ts", "c.ts"])
    expect(used.lines).toBe(13)
  })

  test("a checkpoint the user stopped also resets the count", () => {
    const messages = [
      user(),
      assistant("understand", [
        edit("a.ts", 3, 1),
        tool("checkpoint", failed(record({ number: 1, decision: "stop" }))),
        edit("b.ts", 1, 0),
      ]),
    ]

    const used = Checkpoint.usage(messages, "understand")

    expect([...used.files]).toEqual(["b.ts"])
    expect(used.lines).toBe(1)
  })

  test("only counts changes made by the given agent", () => {
    const messages = [
      user(),
      assistant("build", [edit("a.ts", 5, 0), edit("b.ts", 5, 0)]),
      user(),
      assistant("understand", [edit("c.ts", 1, 0)]),
    ]

    const used = Checkpoint.usage(messages, "understand")

    expect([...used.files]).toEqual(["c.ts"])
    expect(used.lines).toBe(1)
  })
})

describe("Checkpoint.next", () => {
  test("starts at checkpoint 1", () => {
    expect(Checkpoint.next([user()])).toEqual({ number: 1, revision: 1 })
  })

  test("moves to the next checkpoint after an approval", () => {
    const messages = [
      user(),
      assistant("understand", [tool("checkpoint", completed(record({ number: 1, decision: "approve" })))]),
    ]

    expect(Checkpoint.next(messages)).toEqual({ number: 2, revision: 1 })
  })

  test("keeps the checkpoint number and counts the revision after a revision request", () => {
    const messages = [
      user(),
      assistant("understand", [
        tool("checkpoint", completed(record({ number: 1, decision: "approve" }))),
        tool("checkpoint", completed(record({ number: 2, revision: 1, decision: "revise" }))),
      ]),
    ]

    expect(Checkpoint.next(messages)).toEqual({ number: 2, revision: 2 })
  })

  test("ignores checkpoints that had nothing to review", () => {
    const messages = [
      user(),
      assistant("understand", [
        tool("checkpoint", completed(record({ number: 1, decision: "approve" }))),
        tool("checkpoint", completed({ skipped: true, snapshot: "s2" })),
      ]),
    ]

    expect(Checkpoint.next(messages)).toEqual({ number: 2, revision: 1 })
  })
})

describe("Checkpoint.baseline", () => {
  test("uses the snapshot of the last checkpoint", () => {
    const messages = [
      user(),
      assistant("understand", [
        stepStart("s0"),
        tool("checkpoint", completed(record({ number: 1, decision: "approve", snapshot: "s1" }))),
      ]),
    ]

    expect(Checkpoint.baseline(messages, "understand")).toBe("s1")
  })

  test("falls back to the first step snapshot of the current run of the agent", () => {
    const messages = [
      user(),
      assistant("build", [stepStart("b0")]),
      user(),
      assistant("understand", [stepStart("u0")]),
      assistant("understand", [stepStart("u1")]),
    ]

    expect(Checkpoint.baseline(messages, "understand")).toBe("u0")
  })

  test("is undefined when no snapshot was recorded", () => {
    expect(Checkpoint.baseline([user(), assistant("understand", [stepStart()])], "understand")).toBeUndefined()
  })
})

describe("Checkpoint.gate", () => {
  test("is undefined for agents without limits", () => {
    expect(Checkpoint.gate(agent(), [])).toBeUndefined()
  })

  it.effect("blocks the next edit once the file limit is reached", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ files: 2, lines: 100 }), [user()])!

      yield* gate.run("edit", changed("a.ts"))
      yield* gate.run("write", changed("b.ts"))
      const exit = yield* gate.run("edit", changed("c.ts")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Checkpoint.RequiredError)
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("you changed 2 files and 2 lines")
    }),
  )

  it.effect("editing the same file again does not count as another file", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ files: 2, lines: 100 }), [user()])!

      yield* gate.run("edit", changed("a.ts"))
      yield* gate.run("edit", changed("a.ts"))
      yield* gate.run("edit", changed("b.ts"))
      const exit = yield* gate.run("edit", changed("b.ts")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("blocks the next edit once the line limit is passed", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ files: 10, lines: 5 }), [user()])!

      yield* gate.run("edit", changed("a.ts", 4, 2))
      const exit = yield* gate.run("edit", changed("a.ts")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("counts files changed in earlier steps", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ files: 2, lines: 100 }), [
        user(),
        assistant("understand", [edit("a.ts", 1, 0), edit("b.ts", 1, 0)]),
      ])!

      const exit = yield* gate.run("edit", changed("c.ts")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("a completed checkpoint resets the budget", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ files: 1, lines: 100 }), [user()])!

      yield* gate.run("edit", changed("a.ts"))
      yield* gate.run("checkpoint", result(record({ number: 1, decision: "approve" })))
      const exit = yield* gate.run("edit", changed("b.ts")).pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.effect("never blocks tools that do not edit files", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ files: 0, lines: 0 }), [user()])!

      const exit = yield* gate.run("read", result({})).pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.effect("blocks edits while a checkpoint is waiting for the user", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ files: 5, lines: 100 }), [user()])!
      const answer = yield* Deferred.make<void>()
      const review = yield* gate
        .run("checkpoint", Deferred.await(answer).pipe(Effect.andThen(result({}))))
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      const exit = yield* gate.run("edit", result({})).pipe(Effect.exit)
      yield* Deferred.succeed(answer, undefined)
      yield* Fiber.join(review)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Checkpoint.BlockedError)
    }),
  )

  it.effect("refuses a checkpoint while edits are still running", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ files: 5, lines: 100 }), [user()])!
      const done = yield* Deferred.make<void>()
      const writing = yield* gate
        .run("edit", Deferred.await(done).pipe(Effect.andThen(result({}))))
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      const exit = yield* gate.run("checkpoint", result({})).pipe(Effect.exit)
      yield* Deferred.succeed(done, undefined)
      yield* Fiber.join(writing)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Checkpoint.BlockedError)
    }),
  )
})

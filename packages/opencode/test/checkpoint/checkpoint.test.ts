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

function user(): SessionV1.WithParts {
  return {
    info: { id: MessageID.ascending(), sessionID, role: "user", time: { created: 0 }, agent: "understand", model },
    parts: [],
  }
}

function assistant(agent: string, parts: PartInput[]): SessionV1.WithParts {
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

const failed = (metadata?: Record<string, unknown>): SessionV1.ToolState => ({
  status: "error",
  input: {},
  error: "failed",
  metadata,
  time: { start: 0, end: 0 },
})

const edit = (additions: number, deletions: number) =>
  tool("edit", completed({ filediff: { file: "a.ts", additions, deletions } }))

const record = (input: { step: number; revision?: number; decision: string; snapshot?: string }) => ({
  step: input.step,
  revision: input.revision ?? 1,
  title: `Step ${input.step}`,
  why: "why",
  impact: "impact",
  snapshot: input.snapshot,
  files: [],
  decision: input.decision,
  time: { asked: 0, answered: 0 },
})

const result = (metadata: Record<string, unknown>) => Effect.succeed({ title: "", output: "", metadata })

const agent = (checkpoint?: Checkpoint.Limits) => ({ name: "understand", checkpoint })

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

describe("Checkpoint.usage", () => {
  test("counts completed edits and their changed lines since the last checkpoint", () => {
    const messages = [
      user(),
      assistant("understand", [
        stepStart("s0"),
        edit(3, 1),
        tool("checkpoint", completed(record({ step: 1, decision: "approve" }))),
        edit(2, 0),
        tool("write", completed({ filediff: { additions: 5, deletions: 0 } })),
        tool(
          "apply_patch",
          completed({
            files: [
              { additions: 1, deletions: 1 },
              { additions: 4, deletions: 0 },
            ],
          }),
        ),
        tool("edit", failed()),
        tool("read", completed({})),
      ]),
    ]

    expect(Checkpoint.usage(messages, "understand")).toEqual({ edits: 3, lines: 13 })
  })

  test("a checkpoint the user stopped also resets the count", () => {
    const messages = [
      user(),
      assistant("understand", [
        edit(3, 1),
        tool("checkpoint", failed(record({ step: 1, decision: "stop" }))),
        edit(1, 0),
      ]),
    ]

    expect(Checkpoint.usage(messages, "understand")).toEqual({ edits: 1, lines: 1 })
  })

  test("only counts edits made by the given agent", () => {
    const messages = [
      user(),
      assistant("build", [edit(5, 0), edit(5, 0)]),
      user(),
      assistant("understand", [edit(1, 0)]),
    ]

    expect(Checkpoint.usage(messages, "understand")).toEqual({ edits: 1, lines: 1 })
  })
})

describe("Checkpoint.next", () => {
  test("starts at step 1", () => {
    expect(Checkpoint.next([user()])).toEqual({ step: 1, revision: 1 })
  })

  test("moves to the next step after an approval", () => {
    const messages = [
      user(),
      assistant("understand", [tool("checkpoint", completed(record({ step: 1, decision: "approve" })))]),
    ]

    expect(Checkpoint.next(messages)).toEqual({ step: 2, revision: 1 })
  })

  test("keeps the step number and counts the revision after a revision request", () => {
    const messages = [
      user(),
      assistant("understand", [
        tool("checkpoint", completed(record({ step: 1, decision: "approve" }))),
        tool("checkpoint", completed(record({ step: 2, revision: 1, decision: "revise" }))),
      ]),
    ]

    expect(Checkpoint.next(messages)).toEqual({ step: 2, revision: 2 })
  })

  test("ignores checkpoints that had nothing to review", () => {
    const messages = [
      user(),
      assistant("understand", [
        tool("checkpoint", completed(record({ step: 1, decision: "approve" }))),
        tool("checkpoint", completed({ skipped: true, snapshot: "s2" })),
      ]),
    ]

    expect(Checkpoint.next(messages)).toEqual({ step: 2, revision: 1 })
  })
})

describe("Checkpoint.baseline", () => {
  test("uses the snapshot of the last checkpoint", () => {
    const messages = [
      user(),
      assistant("understand", [
        stepStart("s0"),
        tool("checkpoint", completed(record({ step: 1, decision: "approve", snapshot: "s1" }))),
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

  it.effect("blocks the next edit once the edit limit is reached", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ edits: 2, lines: 100 }), [user()])!
      const change = result({ filediff: { additions: 1, deletions: 0 } })

      yield* gate.run("edit", change)
      yield* gate.run("write", change)
      const exit = yield* gate.run("edit", change).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Checkpoint.RequiredError)
    }),
  )

  it.effect("blocks the next edit once the line limit is reached", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ edits: 10, lines: 5 }), [user()])!

      yield* gate.run("edit", result({ filediff: { additions: 4, deletions: 2 } }))
      const exit = yield* gate.run("edit", result({})).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("counts edits made in earlier steps", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ edits: 2, lines: 100 }), [
        user(),
        assistant("understand", [edit(1, 0), edit(1, 0)]),
      ])!

      const exit = yield* gate.run("edit", result({})).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("a completed checkpoint resets the budget", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ edits: 1, lines: 100 }), [user()])!

      yield* gate.run("edit", result({}))
      yield* gate.run("checkpoint", result(record({ step: 1, decision: "approve" })))
      const exit = yield* gate.run("edit", result({})).pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.effect("never blocks tools that do not edit files", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ edits: 0, lines: 0 }), [user()])!

      const exit = yield* gate.run("read", result({})).pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.effect("blocks edits while a checkpoint is waiting for the user", () =>
    Effect.gen(function* () {
      const gate = Checkpoint.gate(agent({ edits: 5, lines: 100 }), [user()])!
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
      const gate = Checkpoint.gate(agent({ edits: 5, lines: 100 }), [user()])!
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

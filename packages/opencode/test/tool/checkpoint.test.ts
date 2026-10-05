import { expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Cause, Effect, Exit, Fiber, Queue, Schema } from "effect"
import { CheckpointTool } from "../../src/tool/checkpoint"
import { Checkpoint } from "../../src/checkpoint"
import { CheckpointMap } from "../../src/checkpoint/map"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "../../src/lsp/lsp"
import { LLM } from "../../src/session/llm"
import { Provider } from "../../src/provider/provider"
import { Question } from "../../src/question"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Snapshot } from "../../src/snapshot"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      MessageV2.node,
      Question.node,
      EventV2Bridge.node,
      Truncate.node,
      Agent.node,
      Snapshot.node,
      RuntimeFlags.node,
      CheckpointMap.node,
      FSUtil.node,
      Ripgrep.node,
      LSP.node,
      LLM.node,
      Provider.node,
    ]),
  ),
)

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const params = {
  title: "Rename the greeting",
  steps: ["I changed the greeting from hi to hello.", "I imported greet in main.ts."],
  impact: "Everything that prints the greeting changes.",
  overview: "The greeting is now hello everywhere.",
  notes: [{ file: "src/greet.ts", purpose: "Holds greet().", change: "It returns hello now." }],
  check: "Run main.ts and look for hello.",
}

const explain = (...files: string[]) => ({
  ...params,
  notes: files.map((file) => ({ file, purpose: "Holds part of the program.", change: "Changed for this test." })),
})

const write = (file: string, content: string) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    yield* Effect.promise(() => Bun.write(path.join(instance.directory, file), content))
  })

// An understand-mode turn: the user's prompt, then an assistant step that snapshots the project before editing.
const start = Effect.fn("CheckpointToolTest.start")(function* (permission?: PermissionV1.Ruleset) {
  const sessions = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  const session = yield* sessions.create(permission ? { permission } : {})
  const user: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "understand",
    model,
  }
  yield* sessions.updateMessage(user)
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    agent: "understand",
    mode: "understand",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: assistant.id,
    type: "step-start",
    snapshot: yield* snapshot.track(),
  })
  return { sessionID: session.id, messageID: assistant.id }
})

const context = (turn: { sessionID: SessionID; messageID: MessageID }, recorded: unknown[] = []) => ({
  sessionID: turn.sessionID,
  messageID: turn.messageID,
  callID: `call_${PartID.ascending()}`,
  agent: "understand",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: (input: { metadata?: unknown }) =>
    Effect.sync(() => {
      recorded.push(input.metadata)
    }),
  ask: () => Effect.void,
})

const pending = Effect.fn("CheckpointToolTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const item = (yield* question.list())[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("5 seconds"))
  }
})

// Runs the checkpoint tool and answers its question with `answer`.
const review = Effect.fn("CheckpointToolTest.review")(function* (
  turn: { sessionID: SessionID; messageID: MessageID },
  answer: string,
  recorded: unknown[] = [],
  input = params,
) {
  const question = yield* Question.Service
  const info = yield* CheckpointTool
  const tool = yield* info.init()
  const fiber = yield* tool.execute(input, context(turn, recorded)).pipe(Effect.forkScoped)
  const asked = yield* pending(question)
  yield* question.reply({ requestID: asked.id, answers: [[answer]] })
  return { asked, exit: yield* Fiber.join(fiber).pipe(Effect.exit) }
})

const decode = Schema.decodeUnknownSync(Checkpoint.Info)

it.instance(
  "shows the diff since the run started and continues when the user approves",
  () =>
    Effect.gen(function* () {
      yield* write("src/greet.ts", "export function greet() {\n  return 'hi'\n}\n")
      const turn = yield* start()
      yield* write("src/greet.ts", "export function greet() {\n  return 'hello'\n}\n")
      yield* write("src/main.ts", "import { greet } from './greet'\n")
      const input = { ...params, notes: [...params.notes, ...explain("src/main.ts").notes] }

      const { asked, exit } = yield* review(turn, "Approve", [], input)

      expect(asked.questions[0].header).toBe("Checkpoint 1")
      expect(asked.questions[0].question).toContain("src/greet.ts")
      expect(asked.questions[0].question).toContain("src/main.ts")
      expect(asked.questions[0].question).toContain("1. I changed the greeting from hi to hello.")
      expect(asked.questions[0].question).toContain("Full diff and map:\n  http://127.0.0.1:")
      if (!Exit.isSuccess(exit)) throw new Error("checkpoint failed")
      const info = decode(exit.value.metadata)
      expect(info.decision).toBe("approve")
      expect(info.number).toBe(1)
      expect(info.steps).toEqual(params.steps)
      expect(info.overview).toBe(params.overview)
      // No model answers in these tests, so the checkpoint reaches the user without a flowchart.
      expect(info.flow).toBeUndefined()
      expect(info.notes).toEqual(input.notes)
      expect(info.check).toBe(params.check)
      // Computed from the import lines, so the map can draw which file uses which.
      expect(info.links).toEqual([{ from: "src/main.ts", to: "src/greet.ts" }])
      expect(info.files.map((file) => [file.file, file.status, file.additions, file.deletions])).toEqual([
        ["src/greet.ts", "modified", 1, 1],
        ["src/main.ts", "added", 1, 0],
      ])
      expect(info.files[0].hunks).toHaveLength(1)
      expect(info.files[0].hunks[0]).toMatchObject({ additions: 1, deletions: 1 })
      expect(exit.value.output).toContain("approved")
    }),
  { git: true },
  // The first test of the file also starts git and the services, which can take more than the default 5 seconds.
  15_000,
)

it.instance(
  "links a changed file to the unchanged files that import it, so the map can check the flowchart's arrows",
  () =>
    Effect.gen(function* () {
      yield* write("src/app.ts", "import { greet } from './greet'\n")
      yield* write("src/greet.ts", "export const greet = () => 'hi'\n")
      const turn = yield* start()
      yield* write("src/greet.ts", "export const greet = () => 'hello'\n")

      const { exit } = yield* review(turn, "Approve")

      if (!Exit.isSuccess(exit)) throw new Error("checkpoint failed")
      const info = decode(exit.value.metadata)
      expect(info.files.map((file) => file.file)).toEqual(["src/greet.ts"])
      expect(info.links).toEqual([{ from: "src/app.ts", to: "src/greet.ts" }])
    }),
  { git: true },
)

it.instance(
  "records the functions the change touched and the unchanged files that use them",
  () =>
    Effect.gen(function* () {
      yield* write("src/cart.js", "export function total(items) {\n  return items.length\n}\n")
      yield* write("src/checkout.js", "import { total } from './cart.js'\nexport const pay = (items) => total(items)\n")
      const turn = yield* start()
      yield* write("src/cart.js", "export function total(items) {\n  return items.length * 2\n}\n")

      const { exit } = yield* review(turn, "Approve", [], explain("src/cart.js"))

      if (!Exit.isSuccess(exit)) throw new Error("checkpoint failed")
      const info = decode(exit.value.metadata)
      expect(info.files[0].symbols).toEqual([{ name: "total", kind: "function", change: "changed", start: 1, end: 3 }])
      expect(info.affected).toEqual([
        {
          file: "src/checkout.js",
          uses: ["src/cart.js"],
          names: ["total"],
          lines: [
            { line: 1, text: "import { total } from './cart.js'" },
            { line: 2, text: "export const pay = (items) => total(items)" },
          ],
        },
      ])
    }),
  { git: true },
)

it.instance(
  "sends the explanation back to the agent once, with the real changes, when its notes do not match them",
  () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const turn = yield* start()
      yield* write("src/index.ts", "export const code = 'SAVE10'\n")
      const info = yield* CheckpointTool
      const tool = yield* info.init()

      const exit = yield* tool.execute(params, context(turn)).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(Checkpoint.MismatchError)
      if (error instanceof Checkpoint.MismatchError) {
        expect(error.message).toContain("notes about files that did not change since the last checkpoint: src/greet.ts")
        expect(error.message).toContain("no note for these changed files: src/index.ts")
        expect(error.message).toContain("- src/index.ts: new file, +1; code (new)")
        expect(error.message).toContain("    + export const code = 'SAVE10'")
      }
      // The user is not asked about an explanation that does not match the changes.
      expect(yield* question.list()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "shows the checkpoint to the user when the agent's second try still does not match",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const turn = yield* start()
      yield* write("src/index.ts", "export const code = 'SAVE10'\n")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: turn.sessionID,
        messageID: turn.messageID,
        type: "tool",
        tool: "checkpoint",
        callID: "call_sent_back",
        state: {
          status: "error",
          input: params,
          error: "Checkpoint sent back: your explanation does not match what changed since the last checkpoint.",
          time: { start: 0, end: 0 },
        },
      })

      const { asked, exit } = yield* review(turn, "Approve")

      expect(asked.questions[0].header).toBe("Checkpoint 1")
      if (!Exit.isSuccess(exit)) throw new Error("checkpoint failed")
      expect(decode(exit.value.metadata).files.map((file) => file.file)).toEqual(["src/index.ts"])
    }),
  { git: true },
)

it.instance(
  "returns the user's feedback to the agent when they ask for a revision",
  () =>
    Effect.gen(function* () {
      const turn = yield* start()
      yield* write("greet.ts", "export const greeting = 'hello'\n")

      const { exit } = yield* review(turn, "Use a named constant for the greeting")

      if (!Exit.isSuccess(exit)) throw new Error("checkpoint failed")
      const info = decode(exit.value.metadata)
      expect(info.decision).toBe("revise")
      expect(info.comment).toBe("Use a named constant for the greeting")
      expect(exit.value.output).toContain("Use a named constant for the greeting")
    }),
  { git: true },
)

it.instance(
  "asks the user again after a revision request, even when the agent only rewrote its explanation",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const turn = yield* start()
      yield* write("greet.ts", "export const greeting = 'hello'\n")
      const first = yield* review(turn, "Draw the flow with files, not routes")
      if (!Exit.isSuccess(first.exit)) throw new Error("checkpoint failed")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: turn.sessionID,
        messageID: turn.messageID,
        type: "tool",
        tool: "checkpoint",
        callID: "call_first",
        state: {
          status: "completed",
          input: params,
          output: first.exit.value.output,
          title: first.exit.value.title,
          metadata: first.exit.value.metadata,
          time: { start: 0, end: 0 },
        },
      })

      const second = yield* review(turn, "Approve")

      expect(second.asked.questions[0].header).toBe("Checkpoint 1 (revision 2)")
      if (!Exit.isSuccess(second.exit)) throw new Error("checkpoint failed")
      expect(decode(second.exit.value.metadata).files.map((file) => file.file)).toEqual(["greet.ts"])
    }),
  { git: true },
)

it.instance(
  "ends the run and records the decision when the user stops",
  () =>
    Effect.gen(function* () {
      const turn = yield* start()
      yield* write("greet.ts", "export const greeting = 'hello'\n")
      const recorded: unknown[] = []

      const { exit } = yield* review(turn, "Stop", recorded)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)
      expect(decode(recorded.at(-1)).decision).toBe("stop")
    }),
  { git: true },
)

it.instance(
  "diffs a later checkpoint against the previous one",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const turn = yield* start()
      yield* write("first.ts", "export const first = 1\n")
      const first = yield* review(turn, "Approve", [], explain("first.ts"))
      if (!Exit.isSuccess(first.exit)) throw new Error("checkpoint failed")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: turn.sessionID,
        messageID: turn.messageID,
        type: "tool",
        tool: "checkpoint",
        callID: "call_first",
        state: {
          status: "completed",
          input: explain("first.ts"),
          output: first.exit.value.output,
          title: first.exit.value.title,
          metadata: first.exit.value.metadata,
          time: { start: 0, end: 0 },
        },
      })
      yield* write("second.ts", "export const second = 2\n")

      const second = yield* review(turn, "Approve", [], explain("second.ts"))

      expect(second.asked.questions[0].header).toBe("Checkpoint 2")
      if (!Exit.isSuccess(second.exit)) throw new Error("checkpoint failed")
      expect(decode(second.exit.value.metadata).files.map((file) => file.file)).toEqual(["second.ts"])
    }),
  { git: true },
)

it.instance(
  "does not interrupt the user when no files changed",
  () =>
    Effect.gen(function* () {
      const turn = yield* start()
      const info = yield* CheckpointTool
      const tool = yield* info.init()

      const result = yield* tool.execute(params, context(turn))

      expect(result.metadata).toMatchObject({ skipped: true })
      expect(result.output).toContain("No files changed")
    }),
  { git: true },
)

it.instance(
  "approves automatically when nobody can answer questions in the session",
  () =>
    Effect.gen(function* () {
      const turn = yield* start([{ permission: "question", pattern: "*", action: "deny" }])
      yield* write("greet.ts", "export const greeting = 'hello'\n")
      const info = yield* CheckpointTool
      const tool = yield* info.init()

      const result = yield* tool.execute(params, context(turn))

      expect(decode(result.metadata).decision).toBe("auto")
    }),
  { git: true },
)

it.instance("uses the edit tools' own diffs when the project is not a git repository", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* TestInstance
    const turn = yield* start()
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: turn.sessionID,
      messageID: turn.messageID,
      type: "tool",
      tool: "edit",
      callID: "call_edit",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "",
        metadata: {
          filediff: {
            file: path.join(instance.directory, "greet.ts"),
            patch: ["Index: greet.ts", "--- greet.ts", "+++ greet.ts", "@@ -1 +1 @@", "-'hi'", "+'hello'"].join("\n"),
            additions: 1,
            deletions: 1,
          },
        },
        time: { start: 0, end: 0 },
      },
    })

    const { asked, exit } = yield* review(turn, "Approve")

    expect(asked.questions[0].question).toContain("shell commands are not shown")
    expect(asked.questions[0].question).toContain("M greet.ts +1 -1")
    if (!Exit.isSuccess(exit)) throw new Error("checkpoint failed")
    const info = decode(exit.value.metadata)
    expect(info.source).toBe("edits")
    expect(info.files.map((file) => file.file)).toEqual(["greet.ts"])
  }),
)

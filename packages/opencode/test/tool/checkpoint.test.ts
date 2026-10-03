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
    ]),
  ),
)

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const params = {
  title: "Rename the greeting",
  why: "The old greeting was too short.",
  impact: "Everything that prints the greeting changes.",
}

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
) {
  const question = yield* Question.Service
  const info = yield* CheckpointTool
  const tool = yield* info.init()
  const fiber = yield* tool.execute(params, context(turn, recorded)).pipe(Effect.forkScoped)
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

      const { asked, exit } = yield* review(turn, "Approve")

      expect(asked.questions[0].header).toBe("Step 1")
      expect(asked.questions[0].question).toContain("src/greet.ts")
      expect(asked.questions[0].question).toContain("src/main.ts")
      expect(asked.questions[0].question).toContain(params.why)
      if (!Exit.isSuccess(exit)) throw new Error("checkpoint failed")
      const info = decode(exit.value.metadata)
      expect(info.decision).toBe("approve")
      expect(info.step).toBe(1)
      expect(info.files.map((file) => [file.file, file.status, file.additions, file.deletions])).toEqual([
        ["src/greet.ts", "modified", 1, 1],
        ["src/main.ts", "added", 1, 0],
      ])
      expect(info.files[0].hunks).toHaveLength(1)
      expect(info.files[0].hunks[0]).toMatchObject({ additions: 1, deletions: 1 })
      expect(exit.value.output).toContain("approved")
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
      const first = yield* review(turn, "Approve")
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
      yield* write("second.ts", "export const second = 2\n")

      const second = yield* review(turn, "Approve")

      expect(second.asked.questions[0].header).toBe("Step 2")
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

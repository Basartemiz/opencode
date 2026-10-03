import { Effect, Option, Schema } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export const Limits = Schema.Struct({
  edits: Schema.Finite,
  lines: Schema.Finite,
})
export type Limits = typeof Limits.Type

// Edits and changed lines an agent may make before it has to call checkpoint.
export const LIMITS: Limits = { edits: 5, lines: 100 }

const Range = Schema.Struct({
  start: Schema.Finite,
  lines: Schema.Finite,
})

export const Hunk = Schema.Struct({
  before: Range,
  after: Range,
  additions: Schema.Finite,
  deletions: Schema.Finite,
})
export type Hunk = typeof Hunk.Type

export const File = Schema.Struct({
  file: Schema.String,
  status: Schema.Literals(["added", "deleted", "modified"]),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  hunks: Schema.Array(Hunk),
  patch: Schema.optional(Schema.String),
})
export type File = typeof File.Type

export const Decision = Schema.Literals(["approve", "revise", "stop", "auto"])
export type Decision = typeof Decision.Type

// Stored as the checkpoint tool part's metadata, so every step survives in session history.
export const Info = Schema.Struct({
  step: Schema.Finite,
  revision: Schema.Finite,
  title: Schema.String,
  why: Schema.String,
  impact: Schema.String,
  base: Schema.optional(Schema.String),
  snapshot: Schema.optional(Schema.String),
  files: Schema.Array(File),
  decision: Decision,
  comment: Schema.optional(Schema.String),
  time: Schema.Struct({
    asked: Schema.Finite,
    answered: Schema.optional(Schema.Finite),
  }),
})
export type Info = typeof Info.Type

export class RequiredError extends Schema.TaggedErrorClass<RequiredError>()("CheckpointRequiredError", {
  edits: Schema.Finite,
  lines: Schema.Finite,
  limits: Limits,
}) {
  override get message() {
    return `Checkpoint required: you made ${this.edits} edits changing ${this.lines} lines since the last checkpoint (limit: ${this.limits.edits} edits or ${this.limits.lines} lines). Call the checkpoint tool now so the user can review these changes, then continue.`
  }
}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("CheckpointBlockedError", {
  reason: Schema.Literals(["reviewing", "editing"]),
}) {
  override get message() {
    if (this.reason === "reviewing")
      return "A checkpoint is waiting for the user's decision. Do not edit files in the same response as a checkpoint; wait for its result first."
    return "Your file edits are still running. Call checkpoint on its own in your next response, after the edits have finished."
  }
}

export function hunks(patch: string): Hunk[] {
  const lines = patch.split("\n")
  return lines.flatMap((line, index) => {
    const header = line.match(HUNK_HEADER)
    if (!header) return []
    const end = lines.findIndex((next, position) => position > index && next.startsWith("@@"))
    const body = lines.slice(index + 1, end === -1 ? undefined : end)
    return [
      {
        before: { start: Number(header[1]), lines: Number(header[2] ?? 1) },
        after: { start: Number(header[3]), lines: Number(header[4] ?? 1) },
        additions: body.filter((item) => item.startsWith("+")).length,
        deletions: body.filter((item) => item.startsWith("-")).length,
      },
    ]
  })
}

// The agent's edits and changed lines since its last checkpoint, used to force a checkpoint when it skips them.
export function usage(messages: SessionV1.WithParts[], agent: string) {
  const parts = messages.flatMap((message) =>
    message.info.role === "assistant" && message.info.agent === agent ? message.parts : [],
  )
  return parts
    .slice(parts.findLastIndex(resets) + 1)
    .flatMap((part) =>
      part.type === "tool" && EDIT_TOOLS.has(part.tool) && part.state.status === "completed"
        ? [changed(part.tool, part.state.metadata)]
        : [],
    )
    .reduce((total, lines) => ({ edits: total.edits + 1, lines: total.lines + lines }), { edits: 0, lines: 0 })
}

export function next(messages: SessionV1.WithParts[]) {
  const last = messages
    .flatMap((message) => message.parts)
    .flatMap((part) => {
      const info = record(part)
      return info ? [info] : []
    })
    .at(-1)
  if (!last) return { step: 1, revision: 1 }
  if (last.decision === "revise") return { step: last.step, revision: last.revision + 1 }
  return { step: last.step + 1, revision: 1 }
}

// The snapshot the next checkpoint diffs against: the previous checkpoint, or the start of the agent's current run.
export function baseline(messages: SessionV1.WithParts[], agent: string) {
  const last = messages.flatMap((message) => message.parts).findLast(resets)
  if (last?.type === "tool" && "metadata" in last.state)
    return Option.getOrUndefined(Schema.decodeUnknownOption(Snapshotted)(last.state.metadata))?.snapshot
  return messages.reduce<string | undefined>((found, message) => {
    if (message.info.role !== "assistant") return found
    if (message.info.agent !== agent) return undefined
    return found ?? message.parts.find((part): part is SessionV1.StepStartPart => part.type === "step-start")?.snapshot
  }, undefined)
}

// The text the user reviews: facts computed from the diff, kept apart from the agent's own explanation.
export function summary(input: Pick<Info, "step" | "revision" | "title" | "why" | "impact" | "files">) {
  const width = Math.max(0, ...input.files.map((file) => file.file.length))
  return [
    `${label(input)}: ${input.title}`,
    "",
    "What changed (computed from the diff):",
    ...(input.files.length
      ? input.files.map(
          (file) => `  ${STATUS[file.status]} ${file.file.padEnd(width)}  +${file.additions} -${file.deletions}`,
        )
      : ["  The exact diff is unavailable: snapshots need a git repository."]),
    "",
    "Agent's explanation (not verified):",
    `  Why: ${input.why}`,
    `  Impact: ${input.impact}`,
    "",
    "Approve to continue, Stop to end the run, or type feedback to request changes.",
  ].join("\n")
}

export function label(input: Pick<Info, "step" | "revision">) {
  if (input.revision > 1) return `Step ${input.step} (revision ${input.revision})`
  return `Step ${input.step}`
}

const STATUS = { added: "A", deleted: "D", modified: "M" } as const

// Tracks one provider step's tool calls for agents with checkpoint limits.
export function gate(agent: { name: string; checkpoint?: Limits }, messages: SessionV1.WithParts[]) {
  const limits = agent.checkpoint
  if (!limits) return
  const state = { ...usage(messages, agent.name), editing: 0, reviewing: false }
  return {
    run: <A extends { metadata: object }, R>(tool: string, effect: Effect.Effect<A, never, R>) =>
      Effect.gen(function* () {
        if (tool === "checkpoint") {
          if (state.editing > 0) return yield* Effect.die(new BlockedError({ reason: "editing" }))
          state.reviewing = true
          const result = yield* effect.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                state.reviewing = false
              }),
            ),
          )
          state.edits = 0
          state.lines = 0
          return result
        }
        if (!EDIT_TOOLS.has(tool)) return yield* effect
        if (state.reviewing) return yield* Effect.die(new BlockedError({ reason: "reviewing" }))
        if (state.edits >= limits.edits || state.lines > limits.lines)
          return yield* Effect.die(new RequiredError({ edits: state.edits, lines: state.lines, limits }))
        state.editing++
        const result = yield* effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              state.editing--
            }),
          ),
        )
        state.edits++
        state.lines += changed(tool, result.metadata)
        return result
      }),
  }
}

const Counts = Schema.Struct({ additions: Schema.Finite, deletions: Schema.Finite })
const EditResult = Schema.Struct({ filediff: Counts })
const PatchResult = Schema.Struct({ files: Schema.Array(Counts) })
const Snapshotted = Schema.Struct({ snapshot: Schema.String })

function changed(tool: string, metadata: unknown) {
  if (tool === "apply_patch")
    return Option.match(Schema.decodeUnknownOption(PatchResult)(metadata), {
      onNone: () => 0,
      onSome: (result) => result.files.reduce((total, file) => total + file.additions + file.deletions, 0),
    })
  return Option.match(Schema.decodeUnknownOption(EditResult)(metadata), {
    onNone: () => 0,
    onSome: (result) => result.filediff.additions + result.filediff.deletions,
  })
}

function record(part: SessionV1.Part) {
  if (part.type !== "tool" || part.tool !== "checkpoint") return
  if (part.state.status !== "completed" && part.state.status !== "error") return
  return Option.getOrUndefined(Schema.decodeUnknownOption(Info)(part.state.metadata))
}

// A finished checkpoint starts a new step; a stopped one counts too, since the user saw its diff.
function resets(part: SessionV1.Part) {
  if (part.type !== "tool" || part.tool !== "checkpoint") return false
  return part.state.status === "completed" || record(part)?.decision === "stop"
}

export * as Checkpoint from "."

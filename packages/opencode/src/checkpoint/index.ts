import { Effect, Option, Schema } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { CheckpointLinks } from "./links"

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
// Several edits of one file are stored as concatenated patches, each starting with its own file header.
const PATCH_START = /^(?=Index: |diff --git )/m
// The terminal shows a checkpoint in a small panel, so its text is kept to one screen; the map page shows the rest.
const WIDTH = 78
const ROW_WIDTH = 76
const MAX_ROWS = 3
// Agents sometimes number their own steps; the summary numbers them itself.
const STEP_MARKER = /^\s*(?:\d+[.)]|[-*•])\s+/
// Starts the error that sends a checkpoint back to the agent, so the next call can tell it was sent back already.
const SENT_BACK = "Checkpoint sent back"
// The agent sees this many changed lines of each file when its explanation is sent back.
const SAMPLE_LINES = 8
// Unchanged lines kept around each change when a file's diff is split into its separate changes.
const CONTEXT = 3

export const Limits = Schema.Struct({
  files: Schema.Finite,
  lines: Schema.Finite,
})
export type Limits = typeof Limits.Type

// Different files and changed lines an agent may build up before it has to call checkpoint.
export const LIMITS: Limits = { files: 6, lines: 400 }

const Range = Schema.Struct({
  start: Schema.Finite,
  lines: Schema.Finite,
})
type Range = typeof Range.Type

type Line = { kind: "add" | "del" | "same"; text: string; old?: number; new?: number }
type Block = { before: Range; after: Range; lines: Line[] }

export const Hunk = Schema.Struct({
  before: Range,
  after: Range,
  additions: Schema.Finite,
  deletions: Schema.Finite,
})
export type Hunk = typeof Hunk.Type

// A function, class, or other named part of a file that a change touched. Its lines are in the file after the
// change, or in the file before it when the change removed it.
export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["class", "type", "function", "method", "variable"]),
  // The class or function it sits in, such as the class of a method.
  parent: Schema.optional(Schema.String),
  change: Schema.Literals(["added", "changed", "removed"]),
  start: Schema.Finite,
  end: Schema.Finite,
})
export type Symbol = typeof Symbol.Type

export const File = Schema.Struct({
  file: Schema.String,
  status: Schema.Literals(["added", "deleted", "modified"]),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  hunks: Schema.Array(Hunk),
  patch: Schema.optional(Schema.String),
  symbols: Schema.optional(Schema.Array(Symbol)),
})
export type File = typeof File.Type

export const Decision = Schema.Literals(["approve", "revise", "stop", "auto"])
export type Decision = typeof Decision.Type

// The agent's explainer for the map page. These are claims; the map shows them next to the computed diff.
export const Note = Schema.Struct({ file: Schema.String, purpose: Schema.String, change: Schema.String })
export type Note = typeof Note.Type

// One arrow of the agent's state-machine explanation: what happens when the program moves from one file to the next.
export const Transition = Schema.Struct({ from: Schema.String, to: Schema.String, action: Schema.String })
export type Transition = typeof Transition.Type

// A changed file and a project file it uses, read from its import lines.
export const Link = Schema.Struct({ from: Schema.String, to: Schema.String })
export type Link = typeof Link.Type

// A file the checkpoint did not change that imports a changed file, so the change may break it.
export const Affected = Schema.Struct({
  file: Schema.String,
  // The changed files it imports.
  uses: Schema.Array(Schema.String),
  // The changed or removed functions and classes of those files that it mentions.
  names: Schema.Array(Schema.String),
  // Where it mentions them, or where it imports a changed file when it mentions none.
  lines: Schema.Array(Schema.Struct({ line: Schema.Finite, text: Schema.String })),
})
export type Affected = typeof Affected.Type

// Stored as the checkpoint tool part's metadata, so every checkpoint survives in session history.
export const Info = Schema.Struct({
  number: Schema.Finite,
  revision: Schema.Finite,
  title: Schema.String,
  steps: Schema.Array(Schema.String),
  impact: Schema.String,
  overview: Schema.optional(Schema.String),
  flow: Schema.optional(Schema.Array(Transition)),
  notes: Schema.optional(Schema.Array(Note)),
  check: Schema.optional(Schema.String),
  links: Schema.optional(Schema.Array(Link)),
  affected: Schema.optional(Schema.Array(Affected)),
  base: Schema.optional(Schema.String),
  snapshot: Schema.optional(Schema.String),
  files: Schema.Array(File),
  // "edits" when there were no git snapshots and the files came from the edit tools' own diffs.
  source: Schema.optional(Schema.Literals(["snapshot", "edits"])),
  decision: Decision,
  comment: Schema.optional(Schema.String),
  time: Schema.Struct({
    asked: Schema.Finite,
    answered: Schema.optional(Schema.Finite),
  }),
})
export type Info = typeof Info.Type

// A checkpoint that is still waiting for the user has no decision yet.
const Entry = Schema.Struct({ ...Info.fields, decision: Schema.optional(Decision) })

export class RequiredError extends Schema.TaggedErrorClass<RequiredError>()("CheckpointRequiredError", {
  files: Schema.Finite,
  lines: Schema.Finite,
  limits: Limits,
}) {
  override get message() {
    return `Checkpoint required: you changed ${this.files} ${this.files === 1 ? "file" : "files"} and ${this.lines} lines since the last checkpoint (limit: ${this.limits.files} files or ${this.limits.lines} lines). Call the checkpoint tool now so the user can review these changes, then continue.`
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

// The agent's notes describe other files than the ones that changed, so the user is not asked yet: the agent gets
// the real changes and one more try.
export class MismatchError extends Schema.TaggedErrorClass<MismatchError>()("CheckpointMismatchError", {
  stray: Schema.Array(Schema.String),
  missing: Schema.Array(Schema.String),
  changes: Schema.String,
}) {
  override get message() {
    return [
      `${SENT_BACK}: your explanation does not match what changed since the last checkpoint, so the user has not seen it yet.`,
      ...(this.stray.length
        ? [`You wrote notes about files that did not change since the last checkpoint: ${this.stray.join(", ")}.`]
        : []),
      ...(this.missing.length ? [`You wrote no note for these changed files: ${this.missing.join(", ")}.`] : []),
      "",
      "What changed since the last checkpoint:",
      this.changes,
      "",
      "Call checkpoint again and describe only these changes: rewrite the title, steps, impact, overview, flow, and notes, with one note for each changed file.",
    ].join("\n")
  }
}

export function hunks(patch: string): Hunk[] {
  return blocks(patch).map((block) => ({
    before: block.before,
    after: block.after,
    additions: block.lines.filter((line) => line.kind === "add").length,
    deletions: block.lines.filter((line) => line.kind === "del").length,
  }))
}

// The changed blocks of a patch with every line and its line numbers, for the map page.
export function blocks(patch: string): Block[] {
  return patch.split(PATCH_START).flatMap((section) => {
    const lines = section.split("\n")
    return lines.flatMap((line, index) => {
      const header = line.match(HUNK_HEADER)
      if (!header) return []
      const end = lines.findIndex((next, position) => position > index && next.startsWith("@@"))
      const before = { start: Number(header[1]), lines: Number(header[2] ?? 1) }
      const after = { start: Number(header[3]), lines: Number(header[4] ?? 1) }
      const body = lines.slice(index + 1, end === -1 ? undefined : end).filter((item) => /^[-+ ]/.test(item))
      return [{ before, after, lines: numbered(body, before.start, after.start) }]
    })
  })
}

// The separate changes of a patch, each with up to three unchanged lines around it, as git shows a diff. Snapshot
// patches keep the whole file as one block, so one block can hold many changes far apart.
export function chunks(patch: string): Block[] {
  return blocks(patch).flatMap((block) => {
    const changed = block.lines.flatMap((line, index) => (line.kind === "same" ? [] : [index]))
    // Changes closer than twice the context share their unchanged lines, so they stay one chunk.
    const groups = changed.reduce<number[][]>((all, index) => {
      const last = all.at(-1)
      if (last && index - last[last.length - 1] - 1 <= 2 * CONTEXT) return [...all.slice(0, -1), [...last, index]]
      return [...all, [index]]
    }, [])
    return groups.map((group) => {
      const start = Math.max(0, group[0] - CONTEXT)
      const end = Math.min(block.lines.length, group[group.length - 1] + CONTEXT + 1)
      if (start === 0 && end === block.lines.length) return block
      return {
        before: side(block, start, end, "old"),
        after: side(block, start, end, "new"),
        lines: block.lines.slice(start, end),
      }
    })
  })
}

// Where a chunk's changes are, as the user reads them: "lines 9–10" of the file after the change, or "removed lines
// 4–6" of the file before it when the chunk only removes lines.
export function span(lines: readonly Line[]) {
  const added = lines.flatMap((line) => (line.kind === "add" && line.new !== undefined ? [line.new] : []))
  const removed = lines.flatMap((line) => (line.kind === "del" && line.old !== undefined ? [line.old] : []))
  const numbers = added.length ? added : removed
  const first = Math.min(...numbers)
  const last = Math.max(...numbers)
  const text = first === last ? `line ${first}` : `lines ${first}–${last}`
  return added.length ? text : `removed ${text}`
}

// The files and lines the agent changed since its last checkpoint, used to force a checkpoint when it skips them.
export function usage(messages: SessionV1.WithParts[], agent: string) {
  const done = unreviewed(messages, agent)
  return {
    files: new Set(done.map((change) => change.file)),
    lines: done.reduce((total, change) => total + change.additions + change.deletions, 0),
  }
}

// Without git snapshots, the edit tools' own diffs are the record of what the next checkpoint covers: the changes since
// the last checkpoint the user settled, which after a revision request includes the change being revised.
export function edited(messages: SessionV1.WithParts[], agent: string): File[] {
  const groups = unreviewed(messages, agent, settles).reduce(
    (result, change) => result.set(change.file, [...(result.get(change.file) ?? []), change]),
    new Map<string, Change[]>(),
  )
  return [...groups].map(([file, items]) => {
    const patch = items.map((item) => item.patch).join("\n")
    return {
      file,
      status: items[0]?.status === "added" ? "added" : items.at(-1)?.status === "deleted" ? "deleted" : "modified",
      additions: items.reduce((total, item) => total + item.additions, 0),
      deletions: items.reduce((total, item) => total + item.deletions, 0),
      hunks: hunks(patch),
      patch,
    }
  })
}

export function next(messages: SessionV1.WithParts[]) {
  const last = messages
    .flatMap((message) => message.parts)
    .flatMap((part) => {
      const info = record(part)
      return info ? [info] : []
    })
    .at(-1)
  if (!last) return { number: 1, revision: 1 }
  if (last.decision === "revise") return { number: last.number, revision: last.revision + 1 }
  return { number: last.number + 1, revision: 1 }
}

// Every checkpoint as the map page shows it: answered, or still waiting for the user's decision.
export function history(messages: SessionV1.WithParts[]) {
  return listed(messages).map((item) => item.entry)
}

// One checkpoint, with the tool part that holds it and the assistant message that made it.
export function locate(messages: SessionV1.WithParts[], number: number, revision: number) {
  return listed(messages).findLast((item) => item.entry.number === number && item.entry.revision === revision)
}

// The checkpoint waiting for the user's decision, if there is one, with the tool part that asks for it.
export function waiting(messages: SessionV1.WithParts[]) {
  return listed(messages).findLast((item) => item.entry.status === "waiting")
}

// Measures a session for a user study, so understand-mode runs can be compared with build-mode runs of similar tasks.
export function stats(messages: SessionV1.WithParts[]) {
  const assistants = messages.flatMap((message) => (message.info.role === "assistant" ? [message.info] : []))
  const parts = messages.flatMap((message) => message.parts)
  const tools = parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
  const checkpoints = parts.flatMap((part) => {
    const info = record(part)
    return info ? [info] : []
  })
  const done = tools.flatMap((part) =>
    part.state.status === "completed" ? changes(part.tool, part.state.metadata) : [],
  )
  const started = messages.find((message) => message.info.role === "user")?.info.time.created
  const finished = assistants.length
    ? Math.max(...assistants.map((info) => info.time.completed ?? info.time.created))
    : undefined
  const waits = checkpoints.map((info) => ({
    number: info.number,
    revision: info.revision,
    title: info.title,
    decision: info.decision,
    comment: info.comment,
    waitedMs: info.time.answered === undefined ? undefined : info.time.answered - info.time.asked,
    files: info.files.length,
    additions: info.files.reduce((total, file) => total + file.additions, 0),
    deletions: info.files.reduce((total, file) => total + file.deletions, 0),
  }))
  const totalMs = started !== undefined && finished !== undefined ? finished - started : 0
  const waitingMs = waits.reduce((total, wait) => total + (wait.waitedMs ?? 0), 0)
  return {
    agents: [...new Set(assistants.map((info) => info.agent))],
    run: { started, finished, totalMs, waitingMs, workingMs: totalMs - waitingMs },
    checkpoints: {
      total: checkpoints.length,
      approved: checkpoints.filter((info) => info.decision === "approve").length,
      revised: checkpoints.filter((info) => info.decision === "revise").length,
      stopped: checkpoints.filter((info) => info.decision === "stop").length,
      auto: checkpoints.filter((info) => info.decision === "auto").length,
      forced: tools.filter(
        (part) =>
          EDIT_TOOLS.has(part.tool) &&
          part.state.status === "error" &&
          part.state.error.includes("Checkpoint required"),
      ).length,
      sentBack: tools.filter(returned).length,
    },
    waits,
    changes: {
      edits: tools.filter((part) => EDIT_TOOLS.has(part.tool) && part.state.status === "completed").length,
      files: new Set(done.map((change) => change.file)).size,
      additions: done.reduce((total, change) => total + change.additions, 0),
      deletions: done.reduce((total, change) => total + change.deletions, 0),
    },
    model: {
      steps: parts.filter((part) => part.type === "step-start").length,
      cost: assistants.reduce((total, info) => total + info.cost, 0),
      tokens: {
        input: assistants.reduce((total, info) => total + info.tokens.input, 0),
        output: assistants.reduce((total, info) => total + info.tokens.output, 0),
      },
    },
  }
}

// The snapshot the next checkpoint diffs against: the previous checkpoint, or the start of the agent's current run.
// After a revision request it is where the revised checkpoint started.
export function baseline(messages: SessionV1.WithParts[], agent: string) {
  const last = messages.flatMap((message) => message.parts).findLast(resets)
  // A revision covers the whole change again, so it reaches the user even when only the explanation changed.
  const revised = last && record(last)
  if (revised?.decision === "revise") return revised.base
  if (last?.type === "tool" && "metadata" in last.state)
    return Option.getOrUndefined(Schema.decodeUnknownOption(Snapshotted)(last.state.metadata))?.snapshot
  return messages.reduce<string | undefined>((found, message) => {
    if (message.info.role !== "assistant") return found
    if (message.info.agent !== agent) return undefined
    return found ?? message.parts.find((part): part is SessionV1.StepStartPart => part.type === "step-start")?.snapshot
  }, undefined)
}

// Where the agent's notes and the diff disagree: notes about files that did not change, and changed files without a note.
export function mismatch(notes: readonly Note[], files: readonly Pick<File, "file">[]) {
  return {
    stray: notes
      .filter((note) => !files.some((file) => CheckpointLinks.same(note.file, file.file)))
      .map((note) => note.file),
    missing: files
      .filter((file) => !notes.some((note) => CheckpointLinks.same(note.file, file.file)))
      .map((file) => file.file),
  }
}

// Whether the agent was already sent back to fix its explanation of the changes since the last checkpoint.
export function sentBack(messages: SessionV1.WithParts[]) {
  const parts = messages.flatMap((message) => message.parts)
  return parts.slice(parts.findLastIndex(resets) + 1).some(returned)
}

// The changes since the last checkpoint as the agent reads them when its explanation is sent back: each file with
// its line counts and the parts it changed, then its first changed lines.
export function facts(
  files: readonly Pick<File, "file" | "status" | "additions" | "deletions" | "patch" | "symbols">[],
) {
  return files
    .flatMap((file) => {
      const lines = blocks(file.patch ?? "").flatMap((block) => block.lines.filter((line) => line.kind !== "same"))
      const parts = (file.symbols ?? []).map((symbol) => `${named(symbol)} (${CHANGE[symbol.change]})`)
      return [
        `- ${file.file}: ${WORD[file.status]}, ${counts(file.additions, file.deletions)}${parts.length ? `; ${parts.join(", ")}` : ""}`,
        ...lines
          .slice(0, SAMPLE_LINES)
          .map((line) => `    ${line.kind === "add" ? "+" : "-"} ${line.text.slice(0, 160)}`),
        ...(lines.length > SAMPLE_LINES ? [`    … ${lines.length - SAMPLE_LINES} more changed lines`] : []),
      ]
    })
    .join("\n")
}

// The text the user reviews in the terminal: the agent's claims, then the facts from the diff, kept to one screen.
// The map page at `map` shows the full steps, the agent's explainer, and every changed line.
export function summary(
  input: Pick<Info, "number" | "revision" | "title" | "steps" | "impact" | "files" | "source">,
  map?: string,
) {
  const entries = input.files.map(
    (file) => `${STATUS[file.status]} ${file.file} ${counts(file.additions, file.deletions)}`,
  )
  const rows = wrap(entries, ROW_WIDTH).slice(0, MAX_ROWS)
  const hidden = entries.length - rows.reduce((total, row) => total + row.length, 0)
  return [
    `${label(input)}: ${input.title}`,
    "",
    "Agent says (not verified):",
    ...input.steps.flatMap((step, index) => hang(`  ${index + 1}. `, step.replace(STEP_MARKER, ""))),
    ...hang("  Impact: ", input.impact),
    "",
    `Changed (from the diff): ${input.files.length} ${input.files.length === 1 ? "file" : "files"}, ${counts(
      input.files.reduce((total, file) => total + file.additions, 0),
      input.files.reduce((total, file) => total + file.deletions, 0),
    )}`,
    ...(input.source === "edits"
      ? ["  Taken from the agent's edit tools; changes made with shell commands are not shown."]
      : []),
    ...rows.map((row) => `  ${row.join("   ")}`),
    ...(hidden > 0 ? [`  … ${hidden} more files on the map`] : []),
    // The link gets a line of its own, so the terminal does not break it and it stays clickable.
    ...(map ? ["", "Full diff and map:", `  ${map}`] : []),
  ].join("\n")
}

export function label(input: Pick<Info, "number" | "revision">) {
  if (input.revision > 1) return `Checkpoint ${input.number} (revision ${input.revision})`
  return `Checkpoint ${input.number}`
}

const STATUS = { added: "A", deleted: "D", modified: "M" } as const
const WORD = { added: "new file", deleted: "deleted", modified: "changed" } as const
const CHANGE = { added: "new", changed: "changed", removed: "removed" } as const

// A function as "total()", a method as "Cart.total()", and a class or type with its kind.
export function named(symbol: Symbol) {
  if (symbol.kind === "method") return `${symbol.parent ? `${symbol.parent}.` : ""}${symbol.name}()`
  if (symbol.kind === "function") return `${symbol.name}()`
  if (symbol.kind === "class" || symbol.kind === "type") return `${symbol.kind} ${symbol.name}`
  return symbol.name
}

function counts(additions: number, deletions: number) {
  if (!deletions) return `+${additions}`
  if (!additions) return `-${deletions}`
  return `+${additions} -${deletions}`
}

// Wraps the agent's text under its label instead of cutting it, so nothing it wrote is lost.
function hang(label: string, text: string) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .reduce<string[]>((lines, word) => {
      const last = lines.at(-1)
      if (last === undefined) return [label + word]
      if (`${last} ${word}`.length <= WIDTH) return [...lines.slice(0, -1), `${last} ${word}`]
      return [...lines, " ".repeat(label.length) + word]
    }, [])
}

// Packs the entries into rows of at most `width` characters; an entry wider than that gets a row of its own.
function wrap(entries: string[], width: number) {
  return entries.reduce<string[][]>((rows, entry) => {
    const last = rows.at(-1)
    if (last && [...last, entry].join("   ").length <= width) return [...rows.slice(0, -1), [...last, entry]]
    return [...rows, [entry]]
  }, [])
}

// One side of a chunk's range. A side without lines starts at the line before it, as in a unified diff.
function side(block: Block, start: number, end: number, key: "old" | "new"): Range {
  const numbers = block.lines.slice(start, end).flatMap((line) => (line[key] === undefined ? [] : [line[key]]))
  if (numbers.length) return { start: numbers[0], lines: numbers.length }
  const earlier = block.lines.slice(0, start).findLast((line) => line[key] !== undefined)?.[key]
  return { start: earlier ?? Math.max(0, (key === "old" ? block.before.start : block.after.start) - 1), lines: 0 }
}

function numbered(body: string[], old: number, next: number) {
  return body.reduce<{ old: number; new: number; lines: Line[] }>(
    (result, line) => {
      const text = line.slice(1)
      if (line.startsWith("+"))
        return { ...result, new: result.new + 1, lines: [...result.lines, { kind: "add", text, new: result.new }] }
      if (line.startsWith("-"))
        return { ...result, old: result.old + 1, lines: [...result.lines, { kind: "del", text, old: result.old }] }
      return {
        old: result.old + 1,
        new: result.new + 1,
        lines: [...result.lines, { kind: "same", text, old: result.old, new: result.new }],
      }
    },
    { old, new: next, lines: [] },
  ).lines
}

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
          state.files = new Set()
          state.lines = 0
          return result
        }
        if (!EDIT_TOOLS.has(tool)) return yield* effect
        if (state.reviewing) return yield* Effect.die(new BlockedError({ reason: "reviewing" }))
        if (state.files.size >= limits.files || state.lines > limits.lines)
          return yield* Effect.die(new RequiredError({ files: state.files.size, lines: state.lines, limits }))
        state.editing++
        const result = yield* effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              state.editing--
            }),
          ),
        )
        const done = changes(tool, result.metadata)
        state.files = new Set([...state.files, ...done.map((change) => change.file)])
        state.lines += done.reduce((total, change) => total + change.additions + change.deletions, 0)
        return result
      }),
  }
}

const Counts = Schema.Struct({ additions: Schema.Finite, deletions: Schema.Finite })
const Snapshotted = Schema.Struct({ snapshot: Schema.String })
const EditDiff = Schema.Struct({
  exists: Schema.optional(Schema.Boolean),
  filediff: Schema.Struct({ ...Counts.fields, file: Schema.String, patch: Schema.optional(Schema.String) }),
})
const PatchDiff = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      ...Counts.fields,
      filePath: Schema.String,
      movePath: Schema.optional(Schema.String),
      type: Schema.String,
      patch: Schema.optional(Schema.String),
    }),
  ),
})

type Change = Omit<File, "hunks">

// The file changes the agent's completed edits made since its last checkpoint.
function unreviewed(messages: SessionV1.WithParts[], agent: string, since: (part: SessionV1.Part) => boolean = resets) {
  const parts = messages.flatMap((message) =>
    message.info.role === "assistant" && message.info.agent === agent ? message.parts : [],
  )
  return parts
    .slice(parts.findLastIndex(since) + 1)
    .flatMap((part) =>
      part.type === "tool" && part.state.status === "completed" ? changes(part.tool, part.state.metadata) : [],
    )
}

function changes(tool: string, metadata: unknown): Change[] {
  if (tool === "apply_patch")
    return Option.match(Schema.decodeUnknownOption(PatchDiff)(metadata), {
      onNone: () => [],
      onSome: (result) =>
        result.files.map((file) => ({
          file: file.movePath ?? file.filePath,
          status: file.type === "add" ? "added" : file.type === "delete" ? "deleted" : "modified",
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch,
        })),
    })
  if (!EDIT_TOOLS.has(tool)) return []
  return Option.match(Schema.decodeUnknownOption(EditDiff)(metadata), {
    onNone: () => [],
    onSome: (result) => [
      {
        file: result.filediff.file,
        status: result.exists === false ? "added" : "modified",
        additions: result.filediff.additions,
        deletions: result.filediff.deletions,
        patch: result.filediff.patch,
      },
    ],
  })
}

// Every checkpoint in the session with where it is: answered, or still waiting for the user's decision.
function listed(messages: SessionV1.WithParts[]) {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "tool" || part.tool !== "checkpoint" || !("metadata" in part.state)) return []
      const entry = Option.getOrUndefined(Schema.decodeUnknownOption(Entry)(part.state.metadata))
      const status = part.state.status === "running" ? "waiting" : "answered"
      if (!entry || (status === "answered" && !entry.decision)) return []
      return [{ entry: { ...entry, status }, part, message: message.info }]
    }),
  )
}

function record(part: SessionV1.Part) {
  if (part.type !== "tool" || part.tool !== "checkpoint") return
  if (part.state.status !== "completed" && part.state.status !== "error") return
  return Option.getOrUndefined(Schema.decodeUnknownOption(Info)(part.state.metadata))
}

// A checkpoint the tool sent back to the agent because its explanation did not match the changes.
function returned(part: SessionV1.Part) {
  return (
    part.type === "tool" &&
    part.tool === "checkpoint" &&
    part.state.status === "error" &&
    part.state.error.includes(SENT_BACK)
  )
}

// A checkpoint the user settled: approved, stopped, or with nothing to review. A revision request does not settle it.
function settles(part: SessionV1.Part) {
  return resets(part) && record(part)?.decision !== "revise"
}

// A finished checkpoint starts a new review; a stopped one counts too, since the user saw its diff.
function resets(part: SessionV1.Part) {
  if (part.type !== "tool" || part.tool !== "checkpoint") return false
  return part.state.status === "completed" || record(part)?.decision === "stop"
}

export * as Checkpoint from "."

import path from "path"
import { Clock, Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./checkpoint.txt"
import { Agent } from "../agent/agent"
import { Checkpoint } from "../checkpoint"
import { CheckpointMap } from "../checkpoint/map"
import { CheckpointLinks } from "../checkpoint/links"
import { CheckpointSymbols } from "../checkpoint/symbols"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "../lsp/lsp"
import { Permission } from "../permission"
import { Question } from "../question"
import { Session } from "../session/session"
import { Snapshot } from "../snapshot"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"

// Larger patches are left out of the stored checkpoint to keep session history small.
const MAX_PATCH = 20_000

export const Parameters = Schema.Struct({
  title: Schema.String.annotate({ description: "Short name for the feature or change (3-8 words)" }),
  steps: Schema.Array(Schema.String).annotate({
    description:
      'What you did since the last checkpoint, in order. One short sentence per step that starts with "I" and says what you changed and why',
  }),
  impact: Schema.String.annotate({ description: "One sentence: what the program now does differently" }),
  // The rest is for the map page: an explainer for someone new to this code.
  overview: Schema.String.annotate({
    description: "The big picture: 2-4 sentences on what this change does and why, for someone new to this code",
  }),
  flow: Schema.Array(
    Schema.Struct({
      from: Schema.String.annotate({
        description: 'The file where this step starts, relative to the project, or "user" when the user starts it',
      }),
      to: Schema.String.annotate({ description: "The file it goes to; the same file when it stays there" }),
      action: Schema.String.annotate({
        description: "What happens, in a few words, such as 'asks total() for the price'",
      }),
    }),
  ).annotate({
    description:
      "How the program works through your change, as a state machine: one arrow per step, in order, from the user's action to the result. 3-7 arrows",
  }),
  notes: Schema.Array(
    Schema.Struct({
      file: Schema.String.annotate({ description: "A file you changed, as a path relative to the project" }),
      purpose: Schema.String.annotate({ description: "One sentence: what this file is for" }),
      change: Schema.String.annotate({ description: "One or two sentences: what you changed in it and why" }),
    }),
  ).annotate({ description: "One note for each file you changed since the last checkpoint" }),
  check: Schema.String.annotate({
    description: "How the user can try the change: a command to run or what to click, and what they should see",
  }),
})

type Metadata = Checkpoint.Info | { skipped: boolean; snapshot?: string }

// Extends the question rejection so the session loop ends the run, as it does when a question is dismissed.
class StoppedError extends Question.RejectedError {
  override get message() {
    return "The user stopped the run at this checkpoint."
  }
}

export const CheckpointTool = Tool.define(
  "checkpoint",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const question = yield* Question.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const flags = yield* RuntimeFlags.Service
    const maps = yield* CheckpointMap.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const lsp = yield* LSP.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const messages = yield* sessions.messages({ sessionID: ctx.sessionID })
          const base = Checkpoint.baseline(messages, ctx.agent)
          const head = yield* snapshot.track()
          const diffs = base && head ? yield* snapshot.diffFull(base, head) : undefined
          const instance = yield* InstanceState.context
          // Without git snapshots, fall back to the diffs the edit tools recorded themselves.
          const changes = diffs
            ? diffs.map((diff) => ({
                file: diff.file ?? "",
                status: diff.status ?? "modified",
                additions: diff.additions,
                deletions: diff.deletions,
                hunks: Checkpoint.hunks(diff.patch ?? ""),
                patch: diff.patch,
              }))
            : Checkpoint.edited(messages, ctx.agent).map((file) => ({
                ...file,
                file: path.relative(instance.directory, file.file),
              }))
          if (changes.length === 0)
            return {
              title: "Nothing to review",
              output:
                "No files changed since the last checkpoint, so there is nothing to review. Call checkpoint only after you change files.",
              metadata: { skipped: true, snapshot: head },
            }

          const source: Checkpoint.Info["source"] = diffs ? "snapshot" : "edits"
          const root = diffs ? instance.worktree : instance.directory
          // Read from the whole patches, before long ones are left out of the stored checkpoint.
          const symbols = yield* CheckpointSymbols.find(fs, lsp, root, changes)
          const files = changes.map((file, index) => ({
            ...file,
            symbols: symbols[index],
            patch: file.patch && file.patch.length <= MAX_PATCH ? file.patch : undefined,
          }))
          const changed = files.filter((file) => file.status !== "deleted").map((file) => file.file)
          const links = yield* CheckpointLinks.find(fs, root, [
            ...new Set([...changed, ...CheckpointLinks.mentioned(params.flow, changed)]),
          ])
          const pending = {
            ...Checkpoint.next(messages),
            ...params,
            base,
            snapshot: head,
            source,
            files,
            links,
            affected: yield* CheckpointLinks.affected(fs, ripgrep, root, files),
            time: { asked: yield* Clock.currentTimeMillis },
          }
          const title = `${Checkpoint.label(pending)}: ${params.title}`
          yield* ctx.metadata({ title, metadata: pending })

          const session = yield* sessions.get(ctx.sessionID)
          const agent = yield* agents.get(ctx.agent)
          // Same rule the registry uses for the question tool, plus sessions that deny questions,
          // such as non-interactive `opencode run`.
          const interactive =
            (["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool) &&
            Permission.evaluate("question", "*", agent?.permission ?? [], session.permission ?? []).action !== "deny"
          const answer = interactive
            ? yield* question
                .ask({
                  sessionID: ctx.sessionID,
                  questions: [
                    {
                      question: Checkpoint.summary(pending, yield* maps.url(ctx.sessionID)),
                      header: Checkpoint.label(pending),
                      custom: true,
                      options: [
                        { label: "Approve", description: "Continue the work" },
                        { label: "Stop", description: "End the run here" },
                      ],
                    },
                  ],
                  tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
                })
                .pipe(
                  Effect.map((answers) => answers[0]?.[0]?.trim() ?? ""),
                  Effect.catch(() => Effect.succeed("stop")),
                )
            : undefined

          const decision = decide(answer)
          const info: Checkpoint.Info = {
            ...pending,
            decision,
            comment: decision === "revise" && answer ? answer : undefined,
            time: { asked: pending.time.asked, answered: yield* Clock.currentTimeMillis },
          }
          if (info.decision === "stop") {
            yield* ctx.metadata({ title, metadata: info })
            return yield* new StoppedError()
          }
          return { title, output: output(info), metadata: info }
        }).pipe(Effect.orDie),
    }
  }),
)

function decide(answer: string | undefined): Checkpoint.Decision {
  if (answer === undefined) return "auto"
  if (answer.toLowerCase() === "approve") return "approve"
  if (answer.toLowerCase() === "stop") return "stop"
  return "revise"
}

function output(info: Checkpoint.Info) {
  if (info.decision === "approve")
    return `The user approved checkpoint ${info.number}. Continue with your plan, and call checkpoint again when the next feature or behavior change is complete.`
  if (info.decision === "auto")
    return `Nobody can answer questions in this session, so checkpoint ${info.number} was approved automatically. Continue with your plan.`
  if (!info.comment)
    return `The user did not approve checkpoint ${info.number} and gave no feedback. Ask them what to change with the question tool before continuing.`
  return `The user asked you to revise checkpoint ${info.number}:\n"${info.comment}"\nApply this feedback now, then call checkpoint again for the revised changes before starting anything new.`
}

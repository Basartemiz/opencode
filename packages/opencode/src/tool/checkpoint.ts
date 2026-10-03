import { Clock, Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./checkpoint.txt"
import { Agent } from "../agent/agent"
import { Checkpoint } from "../checkpoint"
import { Permission } from "../permission"
import { Question } from "../question"
import { Session } from "../session/session"
import { Snapshot } from "../snapshot"
import { RuntimeFlags } from "@/effect/runtime-flags"

// Larger patches are left out of the stored checkpoint to keep session history small.
const MAX_PATCH = 20_000

export const Parameters = Schema.Struct({
  title: Schema.String.annotate({ description: "Short name for this step (3-8 words)" }),
  why: Schema.String.annotate({ description: "One or two sentences: why you made this change" }),
  impact: Schema.String.annotate({ description: "One or two sentences: what this change affects" }),
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
          if (diffs?.length === 0)
            return {
              title: "Nothing to review",
              output:
                "No files changed since the last checkpoint, so there is nothing to review. Call checkpoint only after you change files.",
              metadata: { skipped: true, snapshot: head },
            }

          const pending = {
            ...Checkpoint.next(messages),
            ...params,
            base,
            snapshot: head,
            files: (diffs ?? []).map((diff) => ({
              file: diff.file ?? "",
              status: diff.status ?? "modified",
              additions: diff.additions,
              deletions: diff.deletions,
              hunks: Checkpoint.hunks(diff.patch ?? ""),
              patch: diff.patch && diff.patch.length <= MAX_PATCH ? diff.patch : undefined,
            })),
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
                      question: Checkpoint.summary(pending),
                      header: Checkpoint.label(pending),
                      custom: true,
                      options: [
                        { label: "Approve", description: "Continue with the next step" },
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
    return `The user approved step ${info.step}. Continue with the next step, and call checkpoint again after your next meaningful change.`
  if (info.decision === "auto")
    return `Nobody can answer questions in this session, so step ${info.step} was approved automatically. Continue with the next step.`
  if (!info.comment)
    return `The user did not approve step ${info.step} and gave no feedback. Ask them what to change with the question tool before continuing.`
  return `The user asked you to revise step ${info.step}:\n"${info.comment}"\nApply this feedback to the same step now, then call checkpoint again before starting anything new.`
}

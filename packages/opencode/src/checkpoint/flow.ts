import { Effect, Option, Schema, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import type { LLM } from "@/session/llm"
import { Checkpoint } from "."
import { CheckpointLinks } from "./links"
import PROMPT from "./flow.txt"

// The flowchart on the map. It is drawn by a short request of its own that reads only the facts of the change, not
// the agent's long conversation, so it cannot mix in earlier checkpoints, and it may only use files as boxes.

const MAX_ARROWS = 7
const RETRY =
  "Your last answer had no arrows that could be used. Answer with JSON only, and use only the boxes listed above."

const Answer = Schema.Struct({ flow: Schema.Array(Checkpoint.Transition) })

// The files the flowchart may use as boxes: the changed ones, the files they import, and the files that import them.
export function boxes(files: readonly Pick<Checkpoint.File, "file" | "status">[], links: readonly Checkpoint.Link[]) {
  return [
    ...new Set([
      ...files.filter((file) => file.status !== "deleted").map((file) => file.file),
      ...links.flatMap((link) => [link.from, link.to]),
    ]),
  ]
}

// What the model reads to draw the flowchart.
export function request(input: {
  steps: readonly string[]
  impact: string
  files: Parameters<typeof Checkpoint.facts>[0]
  links: readonly Checkpoint.Link[]
  boxes: readonly string[]
}) {
  return [
    "Boxes you may use:",
    ...["user", ...input.boxes].map((box) => `- ${box}`),
    "",
    "Which file imports which:",
    ...(input.links.length ? input.links.map((link) => `- ${link.from} imports ${link.to}`) : ["- none found"]),
    "",
    "What changed:",
    Checkpoint.facts(input.files),
    "",
    "What the agent that made the change says it did:",
    ...input.steps.map((step, index) => `${index + 1}. ${step}`),
    `Impact: ${input.impact}`,
  ].join("\n")
}

// The arrows of the model's answer between the user and the allowed files. Arrows to anything else are left out.
export function parse(text: string, boxes: readonly string[]): Checkpoint.Transition[] {
  const json = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)),
  )
  const answer = Option.getOrUndefined(Schema.decodeUnknownOption(Answer)(json))
  const box = (name: string) =>
    CheckpointLinks.user(name) ? "user" : boxes.find((file) => CheckpointLinks.same(file, name))
  return (answer?.flow ?? [])
    .flatMap((step) => {
      const from = box(step.from)
      const to = box(step.to)
      return from && to && step.action.trim() ? [{ from, to, action: step.action.trim() }] : []
    })
    .slice(0, MAX_ARROWS)
}

// Asks the model for the flowchart, and once more when its answer has no arrows that can be used.
export const draw = Effect.fn("CheckpointFlow.draw")(function* (
  llm: LLM.Interface,
  input: {
    model: Provider.Model
    agent: Agent.Info
    user: SessionV1.User
    sessionID: string
    request: string
    boxes: readonly string[]
  },
) {
  const ask = (text: string) =>
    llm
      .stream({
        agent: { ...input.agent, prompt: PROMPT },
        user: input.user,
        sessionID: input.sessionID,
        model: input.model,
        system: [],
        tools: {},
        retries: 1,
        messages: [{ role: "user", content: text }],
      })
      .pipe(
        Stream.filter(LLMEvent.is.textDelta),
        Stream.map((event) => event.text),
        Stream.mkString,
        Effect.map((answer) => parse(answer, input.boxes)),
      )
  const first = yield* ask(input.request)
  if (first.length) return first
  return yield* ask(`${input.request}\n\n${RETRY}`)
})

export * as CheckpointFlow from "./flow"

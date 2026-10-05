import { Effect, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import type { LLM } from "@/session/llm"

// A short request of its own to the session's model, outside the agent's conversation. The map's flowchart and its
// explanations read only the facts they are given, and nothing is written to the session.
export const answer = Effect.fn("CheckpointModel.answer")(function* (
  llm: LLM.Interface,
  input: {
    model: Provider.Model
    agent: Agent.Info
    user: SessionV1.User
    sessionID: string
    prompt: string
    request: string
  },
) {
  return yield* llm
    .stream({
      agent: { ...input.agent, prompt: input.prompt },
      user: input.user,
      sessionID: input.sessionID,
      model: input.model,
      system: [],
      tools: {},
      retries: 1,
      messages: [{ role: "user", content: input.request }],
    })
    .pipe(
      Stream.filter(LLMEvent.is.textDelta),
      Stream.map((event) => event.text),
      Stream.mkString,
    )
})

export * as CheckpointModel from "./model"

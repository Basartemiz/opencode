import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import type { LLM } from "@/session/llm"
import { Checkpoint } from "."
import { CheckpointModel } from "./model"
import { CheckpointSymbols } from "./symbols"
import PROMPT from "./explain.txt"

// "Explain" on the map page: the model explains a changed file, or one change in it, from the facts of the change
// alone. It never reads the agent's conversation, so it cannot mix in other work, and nothing goes into the session.

// The model reads at most this many lines of changes, and this much of each line.
const MAX_LINES = 150
const MAX_WIDTH = 200
const WORD = { added: "new file", deleted: "deleted", modified: "changed" } as const

// What the model reads: the checkpoint's title, the file, its changes with the functions they fall in, the files that
// import it, and the user's question.
export function request(input: {
  title: string
  file: Pick<Checkpoint.File, "file" | "status" | "patch" | "symbols">
  // One change of the file, as its position in the file's chunks; without it, every change of the file.
  chunk?: number
  importers: readonly string[]
  question?: string
}) {
  const chunks = Checkpoint.chunks(input.file.patch ?? "")
  const symbols = input.file.symbols ?? []
  const lines = (input.chunk === undefined ? chunks : chunks.slice(input.chunk, input.chunk + 1)).flatMap((chunk) => {
    const names = CheckpointSymbols.within(chunk, symbols).map((index) => Checkpoint.named(symbols[index]))
    const where = Checkpoint.span(chunk.lines)
    return [
      `${where.charAt(0).toUpperCase()}${where.slice(1)}${names.length ? `, in ${names.join(", ")}` : ""}:`,
      ...chunk.lines.map(
        (line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "} ${line.text.slice(0, MAX_WIDTH)}`,
      ),
    ]
  })
  const question = input.question?.trim()
  return [
    `Checkpoint: ${input.title}`,
    `File: ${input.file.file} (${WORD[input.file.status]})`,
    `Files that import it: ${input.importers.length ? input.importers.join(", ") : "none found"}`,
    "",
    `${input.chunk === undefined ? "Its changes" : "The change to explain"} (+ added, - removed, other lines unchanged):`,
    ...lines.slice(0, MAX_LINES),
    ...(lines.length > MAX_LINES ? [`… ${lines.length - MAX_LINES} more lines`] : []),
    "",
    question
      ? `The user asks: ${question}`
      : "Explain what this change does and what it means for the code that uses it.",
  ].join("\n")
}

export const ask = Effect.fn("CheckpointExplain.ask")(function* (
  llm: LLM.Interface,
  input: {
    model: Provider.Model
    agent: Agent.Info
    user: SessionV1.User
    sessionID: string
    request: string
  },
) {
  return (yield* CheckpointModel.answer(llm, { ...input, prompt: PROMPT })).trim()
})

export * as CheckpointExplain from "./explain"

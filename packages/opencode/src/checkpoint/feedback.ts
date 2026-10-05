import { Checkpoint } from "."
import { CheckpointSymbols } from "./symbols"

// "Revert this" and "Ask for a change" on the map page send the agent a message about one change. It starts with where
// the change is, taken from the checkpoint itself, so the user only says what they want.

export function message(input: {
  checkpoint: Pick<Checkpoint.Info, "number" | "revision">
  file: Pick<Checkpoint.File, "file" | "patch" | "symbols">
  // The change's position in the file's chunks.
  chunk: number
  action: "revert" | "change"
  text?: string
}) {
  const chunk = Checkpoint.chunks(input.file.patch ?? "")[input.chunk]
  const text = input.text?.trim()
  if (!chunk || (input.action === "change" && !text)) return undefined
  const symbols = input.file.symbols ?? []
  const names = CheckpointSymbols.within(chunk, symbols).map((index) => Checkpoint.named(symbols[index]))
  const place = [input.file.file, ...(names.length ? [sentence(names)] : []), Checkpoint.span(chunk.lines)].join(", ")
  const checkpoint =
    input.checkpoint.revision > 1
      ? `checkpoint ${input.checkpoint.number}, revision ${input.checkpoint.revision}`
      : `checkpoint ${input.checkpoint.number}`
  const wanted = input.action === "revert" ? ["revert this change.", text].filter(Boolean).join(" ") : text
  return `In ${place} (${checkpoint}): ${wanted}`
}

function sentence(items: string[]) {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join("")
}

export * as CheckpointFeedback from "./feedback"

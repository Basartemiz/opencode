import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Exit, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_gate")
const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

const understand: Agent.Info = {
  name: "understand",
  mode: "primary",
  options: {},
  checkpoint: { edits: 2, lines: 100 },
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const build: Agent.Info = { ...understand, name: "build", checkpoint: undefined }

const assistant: SessionV1.Assistant = {
  id: MessageID.ascending(),
  sessionID,
  role: "assistant",
  parentID: MessageID.ascending(),
  agent: "understand",
  mode: "understand",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  time: { created: 1 },
}

const editPart = (): SessionV1.ToolPart => ({
  id: PartID.ascending(),
  sessionID,
  messageID: assistant.id,
  type: "tool",
  tool: "edit",
  callID: `call_${PartID.ascending()}`,
  state: {
    status: "completed",
    input: {},
    output: "",
    title: "",
    metadata: { filediff: { additions: 1, deletions: 0 } },
    time: { start: 0, end: 0 },
  },
})

// Two edits already happened in earlier steps without a checkpoint.
const history: SessionV1.WithParts[] = [{ info: assistant, parts: [editPart(), editPart()] }]

const layer = Layer.mergeAll(
  Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (_name, _input, output) => Effect.succeed(output),
    } satisfies Plugin.Interface),
  ),
  Layer.succeed(
    Permission.Service,
    Permission.Service.of({
      ask: () => Effect.void,
      reply: () => Effect.void,
      list: () => Effect.succeed([]),
    } satisfies Permission.Interface),
  ),
  Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      tools: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
    } as Partial<MCP.Interface> as MCP.Interface),
  ),
  Layer.succeed(
    Truncate.Service,
    Truncate.Service.of({
      cleanup: () => Effect.void,
      write: () => Effect.succeed("output.txt"),
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
    } satisfies Truncate.Interface),
  ),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["edit"]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () =>
        Effect.succeed([
          {
            id: "edit",
            description: "pretends to edit a file",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: () =>
              Effect.succeed({
                title: "edit",
                metadata: { filediff: { additions: 1, deletions: 0 } },
                output: "Edit applied successfully.",
              }),
          } satisfies Tool.Def,
        ]),
    }),
  ),
)

const it = testEffect(layer)

const runEdit = Effect.fn("CheckpointGateTest.runEdit")(function* (agent: Agent.Info) {
  const tools = yield* SessionTools.resolve({
    agent,
    model,
    session: { id: sessionID, permission: [] } as unknown as Session.Info,
    processor: {
      message: assistant,
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
    bypassAgentCheck: false,
    messages: history,
    promptOps: {} as never,
  })
  const execute = tools.edit.execute
  if (!execute) throw new Error("edit tool is missing execute")
  return yield* Effect.tryPromise(() =>
    execute({}, { toolCallId: "call_edit", abortSignal: new AbortController().signal, messages: [] }),
  ).pipe(Effect.exit)
})

it.effect("blocks the next edit when the agent skipped too many checkpoints", () =>
  Effect.gen(function* () {
    const exit = yield* runEdit(understand)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("Checkpoint required")
  }),
)

it.effect("does not limit edits for agents without checkpoint limits", () =>
  Effect.gen(function* () {
    const exit = yield* runEdit(build)

    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

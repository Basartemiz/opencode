import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { CheckpointMap } from "../../src/checkpoint/map"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionProjector.node, MessageV2.node, EventV2Bridge.node, CheckpointMap.node]),
  ),
)

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const patch = (file: string, ...body: string[]) => [`Index: ${file}`, `--- ${file}`, `+++ ${file}`, ...body].join("\n")

const checkpoint = {
  number: 1,
  revision: 1,
  title: "Add greeting",
  steps: ["I added greet()."],
  impact: "The program can greet.",
  overview: "The program can greet now.",
  flow: [
    { from: "user", to: "src/greet.ts", action: "runs greet()" },
    { from: "./src/greet.ts", to: "src/text.ts", action: "reads the text" },
    { from: "src/greet.ts", to: "src/log.ts", action: "logs it" },
    { from: "src/greet.ts", to: "You", action: "shows the greeting" },
  ],
  notes: [
    { file: "./src/greet.ts", purpose: "Holds greet().", change: "New file." },
    { file: "src/missing.ts", purpose: "Calls greet().", change: "Uses the greeting." },
  ],
  check: "Run greet.ts.",
  links: [{ from: "src/greet.ts", to: "src/text.ts" }],
  files: [
    {
      file: "src/greet.ts",
      status: "added",
      additions: 1,
      deletions: 0,
      hunks: [],
      patch: patch("src/greet.ts", "@@ -0,0 +1,1 @@", "+export const greet = () => 'hi'"),
    },
  ],
  decision: "approve",
  time: { asked: 1_000, answered: 4_000 },
}

const tool = (
  sessionID: SessionID,
  messageID: MessageID,
  name: string,
  state: SessionV1.ToolState,
): SessionV1.ToolPart => ({
  id: PartID.ascending(),
  sessionID,
  messageID,
  type: "tool",
  tool: name,
  callID: `call_${PartID.ascending()}`,
  state,
})

const completed = (metadata: Record<string, unknown>): SessionV1.ToolState => ({
  status: "completed",
  input: {},
  output: "",
  title: "",
  metadata,
  time: { start: 0, end: 0 },
})

// A session where understand mode made one approved checkpoint.
const session = Effect.fn("CheckpointMapTest.session")(function* () {
  const sessions = yield* Session.Service
  const info = yield* sessions.create({ title: "Greeting" })
  const user: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: info.id,
    role: "user",
    time: { created: 0 },
    agent: "understand",
    model,
  }
  yield* sessions.updateMessage(user)
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: info.id,
    role: "assistant",
    parentID: user.id,
    agent: "understand",
    mode: "understand",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: 0 },
  }
  yield* sessions.updateMessage(assistant)
  yield* sessions.updatePart(tool(info.id, assistant.id, "checkpoint", completed(checkpoint)))
  return info
})

const get = (url: string) => Effect.promise(() => fetch(url))

it.instance("serves a session's map page, its data, and its study data behind a private link", () =>
  Effect.gen(function* () {
    const maps = yield* CheckpointMap.Service
    const info = yield* session()
    const url = yield* maps.url(info.id)

    const page = yield* get(url)
    const listed = yield* get(`${url}/data`).pipe(Effect.flatMap((response) => Effect.promise(() => response.json())))
    expect(Array.isArray(listed.project)).toBe(true)
    const data = yield* get(`${url}/data`)
    const stats = yield* get(`${url}/stats`)

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{16}\/ses_\w+$/)
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(yield* Effect.promise(() => page.text())).toContain("<title>Understand map</title>")
    const body = yield* Effect.promise(() => data.json())
    expect(body.session.title).toBe("Greeting")
    expect(body.checkpoints[0].overview).toBe(checkpoint.overview)
    expect(body.checkpoints[0].links).toEqual(checkpoint.links)
    expect(body.checkpoints[0].files[0].blocks[0].lines).toEqual([
      { kind: "add", text: "export const greet = () => 'hi'", new: 1 },
    ])
    expect(stats.headers.get("content-disposition")).toContain("attachment")
    expect((yield* Effect.promise(() => stats.json())).checkpoints.approved).toBe(1)
  }),
)

it.instance("refuses requests without the link's secret, and answers 404 for unknown sessions", () =>
  Effect.gen(function* () {
    const maps = yield* CheckpointMap.Service
    const info = yield* session()
    const url = new URL(yield* maps.url(info.id))

    const wrong = yield* get(`${url.origin}/wrong-secret/${info.id}/data`)
    const unknown = yield* get(`${url.href.replace(info.id, SessionID.descending())}/data`)

    expect(wrong.status).toBe(404)
    expect(unknown.status).toBe(404)
  }),
)

describe("CheckpointMap.data", () => {
  test("checks each arrow the agent drew against the imports OpenCode found", () => {
    const sessionID = SessionID.make("ses_arrows")
    const result = CheckpointMap.data(
      { id: sessionID, title: "Greeting", directory: "/p" },
      [
        {
          info: {
            id: MessageID.ascending(),
            sessionID,
            role: "assistant",
            agent: "understand",
            mode: "understand",
            parentID: MessageID.ascending(),
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.modelID,
            providerID: model.providerID,
            time: { created: 0 },
          },
          parts: [tool(sessionID, MessageID.ascending(), "checkpoint", completed(checkpoint))],
        },
      ],
      ["README.md", "src/greet.ts"],
    )

    // Steps from or to the user have nothing to check; greet.ts really imports text.ts; nothing links greet.ts and log.ts.
    expect(result.checkpoints[0].flow?.map((step) => step.confirmed)).toEqual([undefined, true, false, undefined])
    expect(result.project).toEqual(["README.md", "src/greet.ts"])
  })

  const user = (sessionID: SessionID): SessionV1.WithParts => ({
    info: { id: MessageID.ascending(), sessionID, role: "user", time: { created: 0 }, agent: "understand", model },
    parts: [],
  })
  const assistant = (sessionID: SessionID, parts: ((messageID: MessageID) => SessionV1.Part)[]) => {
    const id = MessageID.ascending()
    return {
      info: {
        id,
        sessionID,
        role: "assistant" as const,
        parentID: MessageID.ascending(),
        agent: "understand",
        mode: "understand",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: 0 },
      },
      parts: parts.map((part) => part(id)),
    }
  }
  const sessionID = SessionID.make("ses_map")

  test("puts the agent's note next to its file and lists notes about files that did not change", () => {
    const result = CheckpointMap.data(
      { id: sessionID, title: "Greeting", directory: "/p" },
      [
        user(sessionID),
        assistant(sessionID, [(messageID) => tool(sessionID, messageID, "checkpoint", completed(checkpoint))]),
      ],
      [],
    )

    expect(result.checkpoints[0].files.map((file) => [file.file, file.note?.purpose])).toEqual([
      ["src/greet.ts", "Holds greet()."],
    ])
    expect(result.checkpoints[0].unmatched).toEqual([checkpoint.notes[1]])
  })

  test("labels each block of a file's diff with the functions it falls in, and keeps the files that may be affected", () => {
    const entry = {
      ...checkpoint,
      files: [
        {
          file: "src/greet.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          hunks: [],
          patch: patch(
            "src/greet.ts",
            "@@ -1,3 +1,3 @@",
            " export function greet() {",
            "-  return 'hi'",
            "+  return 'hello'",
            " }",
          ),
          symbols: [{ name: "greet", kind: "function" as const, change: "changed" as const, start: 1, end: 3 }],
        },
      ],
      affected: [
        { file: "src/main.ts", uses: ["src/greet.ts"], names: ["greet"], lines: [{ line: 2, text: "greet()" }] },
      ],
    }

    const result = CheckpointMap.data(
      { id: sessionID, title: "Greeting", directory: "/p" },
      [
        user(sessionID),
        assistant(sessionID, [(messageID) => tool(sessionID, messageID, "checkpoint", completed(entry))]),
      ],
      [],
    )

    expect(result.checkpoints[0].files[0].symbols).toEqual(entry.files[0].symbols)
    expect(result.checkpoints[0].files[0].blocks.map((block) => block.symbols)).toEqual([[0]])
    expect(result.checkpoints[0].affected).toEqual(entry.affected)
  })

  test("shows the changes made since the last checkpoint, so the map updates while the agent works", () => {
    const edit = completed({
      filediff: {
        file: "/p/src/cart.ts",
        patch: patch("src/cart.ts", "@@ -1 +1 @@", "-a", "+b"),
        additions: 1,
        deletions: 1,
      },
    })

    const result = CheckpointMap.data(
      { id: sessionID, title: "Greeting", directory: "/p" },
      [
        user(sessionID),
        assistant(sessionID, [
          (messageID) => tool(sessionID, messageID, "checkpoint", completed(checkpoint)),
          (messageID) => tool(sessionID, messageID, "edit", edit),
        ]),
      ],
      [],
    )

    expect(result.unreviewed.map((file) => [file.file, file.additions, file.deletions])).toEqual([
      ["src/cart.ts", 1, 1],
    ])
  })
})

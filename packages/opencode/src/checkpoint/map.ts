import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Context, Effect, Layer, Option, Schema, Scope } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Agent } from "@/agent/agent"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { LLM } from "@/session/llm"
import type { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Checkpoint } from "."
import { CheckpointExplain } from "./explain"
import { CheckpointFeedback } from "./feedback"
import { CheckpointLinks } from "./links"
import { CheckpointSymbols } from "./symbols"
import PAGE from "./map.html.txt"

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" }
// The project tree on the map lists at most this many files, and is listed again at most every few seconds.
const MAX_FILES = 3000
const LIST_AGE = 5000
// Requests from the page are small JSON objects.
const MAX_BODY = 16_384
// The user waits for an explanation, so a slow answer is given up on.
const EXPLAIN_WAIT = "45 seconds"

// What the page sends to have the model explain a changed file, or one change in it.
const Explain = Schema.Struct({
  number: Schema.Finite,
  revision: Schema.Finite,
  file: Schema.String,
  // The change's position in the file's chunks; without it, the whole file.
  chunk: Schema.optional(Schema.Finite),
  question: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
})
type Explain = typeof Explain.Type

// What the page sends to ask the agent to revert one change, or to change it as the user says.
const Send = Schema.Struct({
  number: Schema.Finite,
  revision: Schema.Finite,
  file: Schema.String,
  chunk: Schema.Finite,
  action: Schema.Literals(["revert", "change"]),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
})
type Send = typeof Send.Type

// What the server answers a request from the page: a status and a JSON body.
type Outcome = { status: number; body: Record<string, unknown> }

// How a request from the page reaches the agent when no checkpoint is waiting: the session prompt, which
// prompt_async uses too.
export type Prompt = (input: SessionPrompt.PromptInput) => Effect.Effect<unknown>
// The page only talks to this server, and it inserts everything it shows as text.
const PAGE_HEADERS = {
  ...HEADERS,
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
}

export interface Interface {
  // The private link to one session's map page. The first call starts the map server for this project. With `prompt`,
  // the page's requests can reach the session's agent as new messages; the checkpoint tool passes the session's own.
  readonly url: (sessionID: SessionID, prompt?: Prompt) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CheckpointMap") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const ripgrep = yield* Ripgrep.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const question = yield* Question.Service
    const listed = new Map<string, { at: number; files: string[] }>()
    const prompts = new Map<SessionID, Prompt>()
    // Explanations by checkpoint, file, change, and question, so asking again shows the same answer without asking the
    // model again. Failed answers are not kept.
    const explained = new Map<string, Promise<Outcome>>()
    // Every file of the project, for the tree on the map. The page asks again every 1.5 seconds, so the list is reused briefly.
    const project = Effect.fn("CheckpointMap.project")(function* () {
      const instance = yield* InstanceState.context
      // Checkpoint paths are relative to the git worktree; without git they are relative to the project folder.
      const root = instance.worktree === "/" ? instance.directory : instance.worktree
      const now = yield* Clock.currentTimeMillis
      const cached = listed.get(root)
      if (cached && now - cached.at < LIST_AGE) return cached.files
      const files = yield* ripgrep.glob({ cwd: root, pattern: "**/*", limit: MAX_FILES }).pipe(
        Effect.map((entries) => entries.map((entry) => entry.path.replaceAll("\\", "/")).sort()),
        Effect.orElseSucceed(() => []),
      )
      listed.set(root, { at: now, files })
      return files
    })
    const load = Effect.fn("CheckpointMap.load")(function* (sessionID: SessionID) {
      const session = yield* sessions.get(sessionID)
      return data(session, yield* sessions.messages({ sessionID }), yield* project())
    })
    // The model that made a checkpoint explains one of its files, or one change in it, from the facts alone.
    const explain = Effect.fn("CheckpointMap.explain")(
      function* (sessionID: SessionID, body: Explain) {
        const messages = yield* sessions.messages({ sessionID })
        const found = Checkpoint.locate(messages, body.number, body.revision)
        const file = found?.entry.files.find((item) => item.file === body.file)
        const made = found?.message
        if (!found || !file || made?.role !== "assistant") return refuse(404, "That file is not in this checkpoint.")
        if (body.chunk !== undefined && !Checkpoint.chunks(file.patch ?? "")[body.chunk])
          return refuse(404, "That change is not in this file.")
        const user = messages.find((message) => message.info.id === made.parentID)?.info
        const agent = yield* agents.get(made.agent)
        if (user?.role !== "user" || !agent) return refuse(404, "This checkpoint has no model to ask.")
        const answer = yield* CheckpointExplain.ask(llm, {
          model: yield* provider.getModel(made.providerID, made.modelID),
          agent,
          user,
          sessionID,
          request: CheckpointExplain.request({
            title: found.entry.title,
            file,
            chunk: body.chunk,
            importers: importers(found.entry, file.file),
            question: body.question,
          }),
        })
        if (!answer) return refuse(502, "The model gave no answer. Try again.")
        return { status: 200, body: { answer } }
      },
      Effect.timeout(EXPLAIN_WAIT),
      Effect.catchCause((cause) =>
        Effect.logWarning("explain failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.as(refuse(502, "The model did not answer. Try again.")),
        ),
      ),
    )
    // A request about one change goes to the agent. When a checkpoint waits for the user, it is their answer, which the
    // checkpoint tool reads as a revision request, as if typed in the terminal. Otherwise it is a new message in the
    // session. The page never edits files itself.
    const send = Effect.fn("CheckpointMap.send")(
      function* (sessionID: SessionID, body: Send, scope: Scope.Scope) {
        const messages = yield* sessions.messages({ sessionID })
        const found = Checkpoint.locate(messages, body.number, body.revision)
        const file = found?.entry.files.find((item) => item.file === body.file)
        if (!found || !file || !Checkpoint.chunks(file.patch ?? "")[body.chunk])
          return refuse(404, "That change is not in this checkpoint.")
        const text = CheckpointFeedback.message({ ...body, checkpoint: found.entry, file })
        if (!text) return refuse(400, "Say what should change.")
        const open = Checkpoint.waiting(messages)
        const asked = open
          ? (yield* question.list()).find((item) => item.sessionID === sessionID && item.tool?.callID === open.part.callID)
          : undefined
        if (asked) {
          yield* question.reply({ requestID: asked.id, answers: [[text]] })
          return { status: 200, body: { via: "revision", sent: text } }
        }
        const prompt = prompts.get(sessionID)
        const user = messages.findLast((message) => message.info.role === "user")?.info
        if (!prompt || user?.role !== "user")
          return refuse(503, "The map cannot reach this session's agent. Type the request in the terminal instead.")
        // The session's own agent and model, so the message does not switch it to another mode.
        yield* prompt({
          sessionID,
          agent: user.agent,
          model: { providerID: user.model.providerID, modelID: user.model.modelID },
          variant: user.model.variant,
          parts: [{ type: "text", text }],
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("message from the map failed", { cause: Cause.pretty(cause) })),
          Effect.forkIn(scope, { startImmediately: true }),
        )
        return { status: 200, body: { via: "message", sent: text } }
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("send failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.as(refuse(500, "OpenCode could not pass the request on. Try again.")),
        ),
      ),
    )
    const remember = (sessionID: SessionID, body: Explain, ask: () => Promise<Outcome>) => {
      const key = JSON.stringify([sessionID, body.number, body.revision, body.file, body.chunk, body.question?.trim()])
      const known = explained.get(key)
      if (known) return known
      const asked = ask()
      explained.set(key, asked)
      void asked.then(
        (outcome) => outcome.status === 200 || explained.delete(key),
        () => explained.delete(key),
      )
      return asked
    }
    const state = yield* InstanceState.make(
      Effect.fn("CheckpointMap.state")(function* () {
        const bridge = yield* EffectBridge.make()
        // Messages sent to the agent from the page run in the project's scope, as prompt_async runs them in the server's.
        const scope = yield* Scope.Scope
        // A random secret in every link, so other programs on this computer cannot read the session.
        // It is short so the link fits on one line of the terminal, where it can be clicked.
        const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              maxRequestBodySize: MAX_BODY,
              fetch: (request, server) =>
                respond(request, {
                  secret,
                  origin: `http://127.0.0.1:${server.port}`,
                  load: (sessionID) => bridge.promise(load(sessionID).pipe(Effect.option)),
                  explain: (sessionID, body) =>
                    remember(sessionID, body, () => bridge.promise(explain(sessionID, body))),
                  send: (sessionID, body) => bridge.promise(send(sessionID, body, scope)),
                }),
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        return `http://127.0.0.1:${server.port}/${secret}`
      }),
    )

    return Service.of({
      url: Effect.fn("CheckpointMap.url")(function* (sessionID, prompt) {
        if (prompt) prompts.set(sessionID, prompt)
        return `${yield* InstanceState.get(state)}/${sessionID}`
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Ripgrep.node, Agent.node, Provider.node, LLM.node, Question.node],
})

// What the map page shows for one session.
export function data(
  session: { id: string; title: string; directory: string },
  messages: SessionV1.WithParts[],
  project: readonly string[],
) {
  const checkpoints = Checkpoint.history(messages)
  const agent = messages.findLast((message) => message.info.role === "assistant")?.info.agent
  return {
    session: { id: session.id, title: session.title },
    checkpoints: checkpoints.map((entry) => ({
      ...entry,
      // Each arrow of the flowchart, checked against the imports OpenCode found between the two files.
      flow: entry.flow?.map((step) => ({ ...step, confirmed: confirmed(step, entry.links ?? []) })),
      files: entry.files.map((file) => ({
        ...view(file),
        note: entry.notes?.find((item) => CheckpointLinks.same(item.file, file.file)),
      })),
      // Notes about files without changes in this checkpoint: claims the diff does not back up.
      unmatched: (entry.notes ?? []).filter(
        (item) => !entry.files.some((file) => CheckpointLinks.same(item.file, file.file)),
      ),
    })),
    // Changes made after the last checkpoint, from the edit tools, so the map updates while the agent works.
    unreviewed:
      checkpoints.at(-1)?.status === "waiting" || !agent
        ? []
        : Checkpoint.edited(messages, agent).map((file) =>
            view({ ...file, file: path.relative(session.directory, file.file) }),
          ),
    stats: Checkpoint.stats(messages),
    project,
  }
}

// The user is not a file, so steps from or to the user have nothing to check; neither do steps within one file.
function confirmed(step: Checkpoint.Transition, links: readonly Checkpoint.Link[]) {
  const same = CheckpointLinks.same
  if (CheckpointLinks.user(step.from) || CheckpointLinks.user(step.to) || same(step.from, step.to)) return undefined
  return links.some(
    (link) =>
      (same(step.from, link.from) && same(step.to, link.to)) || (same(step.from, link.to) && same(step.to, link.from)),
  )
}

async function respond(
  request: Request,
  input: {
    secret: string
    // The map server's own origin: the only page that may send requests that act.
    origin: string
    load: (sessionID: SessionID) => Promise<Option.Option<ReturnType<typeof data>>>
    explain: (sessionID: SessionID, body: Explain) => Promise<Outcome>
    send: (sessionID: SessionID, body: Send) => Promise<Outcome>
  },
) {
  const [key, id, kind] = new URL(request.url).pathname.split("/").slice(1)
  const sessionID = Option.getOrUndefined(Schema.decodeUnknownOption(SessionID)(id))
  if (key !== input.secret || !sessionID) return missing()
  if (request.method === "POST" && kind === "explain")
    return write(request, input.origin, (text) => {
      const body = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Explain))(text))
      return body ? input.explain(sessionID, body) : Promise.resolve(refuse(400, "The map sent an unknown request."))
    })
  if (request.method === "POST" && kind === "send")
    return write(request, input.origin, (text) => {
      const body = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Send))(text))
      return body ? input.send(sessionID, body) : Promise.resolve(refuse(400, "The map sent an unknown request."))
    })
  if (request.method !== "GET") return missing()
  if (kind === undefined) return new Response(PAGE, { headers: PAGE_HEADERS })
  if (kind !== "data" && kind !== "stats") return missing()
  const found = await input.load(sessionID)
  if (Option.isNone(found)) return missing()
  if (kind === "data") return Response.json(found.value, { headers: HEADERS })
  return Response.json(
    { session: found.value.session, ...found.value.stats },
    { headers: { ...HEADERS, "content-disposition": `attachment; filename="understand-${sessionID}.json"` } },
  )
}

// A request that acts comes only from the map page itself: from the map server's own origin, as JSON, and small.
// Other requests are refused before their body is read.
async function write(request: Request, origin: string, act: (text: string) => Promise<Outcome>) {
  if (request.headers.get("origin") !== origin) return reply(refuse(403, "Only the map page can send this."))
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return reply(refuse(415, "Send JSON."))
  if (Number(request.headers.get("content-length")) > MAX_BODY) return reply(refuse(413, "The request is too large."))
  const text = await request.text()
  if (text.length > MAX_BODY) return reply(refuse(413, "The request is too large."))
  return reply(await act(text))
}

function reply(outcome: Outcome) {
  return Response.json(outcome.body, { status: outcome.status, headers: HEADERS })
}

function refuse(status: number, error: string): Outcome {
  return { status, body: { error } }
}

function missing() {
  return new Response("Not found", { status: 404, headers: HEADERS })
}

// The files that import a file: changed files whose imports point at it, and unchanged files that may be affected.
function importers(entry: Pick<Checkpoint.Info, "links" | "affected">, file: string) {
  return [
    ...new Set([
      ...(entry.links ?? []).filter((link) => link.to === file).map((link) => link.from),
      ...(entry.affected ?? []).filter((item) => item.uses.includes(file)).map((item) => item.file),
    ]),
  ]
}

function view(file: Checkpoint.File) {
  const symbols = file.symbols ?? []
  return {
    file: file.file,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    symbols,
    // Each separate change of the diff, with the lines it changed and the functions and classes it falls in, as
    // positions in `symbols`.
    blocks: Checkpoint.chunks(file.patch ?? "").map((block) => ({
      ...block,
      span: Checkpoint.span(block.lines),
      symbols: CheckpointSymbols.within(block, symbols),
    })),
  }
}

export * as CheckpointMap from "./map"

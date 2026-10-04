import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Checkpoint } from "."
import { CheckpointLinks } from "./links"
import { CheckpointSymbols } from "./symbols"
import PAGE from "./map.html.txt"

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" }
// The project tree on the map lists at most this many files, and is listed again at most every few seconds.
const MAX_FILES = 3000
const LIST_AGE = 5000
// The page only talks to this server, and it inserts everything it shows as text.
const PAGE_HEADERS = {
  ...HEADERS,
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
}

export interface Interface {
  // The private link to one session's map page. The first call starts the map server for this project.
  readonly url: (sessionID: SessionID) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CheckpointMap") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const ripgrep = yield* Ripgrep.Service
    const listed = new Map<string, { at: number; files: string[] }>()
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
    const state = yield* InstanceState.make(
      Effect.fn("CheckpointMap.state")(function* () {
        const bridge = yield* EffectBridge.make()
        // A random secret in every link, so other programs on this computer cannot read the session.
        // It is short so the link fits on one line of the terminal, where it can be clicked.
        const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch: (request) =>
                respond(request, secret, (sessionID) => bridge.promise(load(sessionID).pipe(Effect.option))),
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        return `http://127.0.0.1:${server.port}/${secret}`
      }),
    )

    return Service.of({
      url: Effect.fn("CheckpointMap.url")(function* (sessionID) {
        return `${yield* InstanceState.get(state)}/${sessionID}`
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Session.node, Ripgrep.node] })

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
      // Each arrow of the agent's state machine, checked against the imports OpenCode found between the two files.
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
  secret: string,
  load: (sessionID: SessionID) => Promise<Option.Option<ReturnType<typeof data>>>,
) {
  const [key, id, kind] = new URL(request.url).pathname.split("/").slice(1)
  const sessionID = Option.getOrUndefined(Schema.decodeUnknownOption(SessionID)(id))
  if (request.method !== "GET" || key !== secret || !sessionID) return missing()
  if (kind === undefined) return new Response(PAGE, { headers: PAGE_HEADERS })
  if (kind !== "data" && kind !== "stats") return missing()
  const found = await load(sessionID)
  if (Option.isNone(found)) return missing()
  if (kind === "data") return Response.json(found.value, { headers: HEADERS })
  return Response.json(
    { session: found.value.session, ...found.value.stats },
    { headers: { ...HEADERS, "content-disposition": `attachment; filename="understand-${sessionID}.json"` } },
  )
}

function missing() {
  return new Response("Not found", { status: 404, headers: HEADERS })
}

function view(file: Checkpoint.File) {
  const symbols = file.symbols ?? []
  return {
    file: file.file,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    symbols,
    // Each block of the diff with the functions and classes it falls in, as positions in `symbols`.
    blocks: Checkpoint.blocks(file.patch ?? "").map((block) => ({
      ...block,
      symbols: CheckpointSymbols.within(block, symbols),
    })),
  }
}

export * as CheckpointMap from "./map"

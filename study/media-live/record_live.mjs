// Records a silent demo of steering the understand agent from the map. It is a real run: a fresh copy of
// study/fixture, OpenCode in a hidden tmux session (never recorded), and the map page driven like a user would,
// with a visible cursor, readable typing and captions. Only the map page is recorded.
// Writes raw.webm, events.json (seconds from the start of the video), waits.txt and screenshots/ to the output dir.
// Usage: node study/media-live/record_live.mjs [output dir]
// Needs OPENAI_API_KEY in the environment, tmux, bun, and Playwright with Chromium (PLAYWRIGHT_MODULE can point at
// its index.mjs). MODEL picks the model (default openai/gpt-5-mini). A step that does not happen ends the run with an
// error, so a failed run is repeated from the start, never patched.

import path from "node:path"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const STUDY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const REPO = path.resolve(STUDY, "..")
const OUT = path.resolve(process.argv[2] ?? path.join(STUDY, "media-live"))
const RUN = process.env.RUN_DIR ?? "/tmp/map-live-run"
const MODEL = process.env.MODEL ?? "openai/gpt-5-mini"
const TASK =
  "Add a year filter to the library service: GET /books accepts ?from=YEAR and ?to=YEAR and only returns books " +
  "published in that range, both years included. Do not write or run tests, and do not start the server; I will try " +
  "everything myself afterwards."
const ASK = "Also add GET /genres that lists every genre once"
const REVISE = "Sort the genres by name"
const VIEW = { width: 1440, height: 900 }
const LINK = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/ses_\w+/
const MINUTE = 60_000

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true })
const log = (text) => console.log(new Date().toTimeString().slice(0, 8), text)
const tmux = (...args) => execFileSync("tmux", ["-L", "maplive", ...args], { encoding: "utf8" })
const screen = () => tmux("capture-pane", "-p", "-J", "-t", "live")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await sleep(500)
  }
  throw new Error("timed out waiting for " + what)
}

// ---- A real OpenCode run, up to its first checkpoint ----
fs.rmSync(RUN, { recursive: true, force: true })
fs.cpSync(path.join(STUDY, "fixture"), RUN, { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: RUN })
execFileSync("git", ["add", "-A"], { cwd: RUN })
execFileSync("git", ["-c", "user.name=study", "-c", "user.email=study@localhost", "commit", "-qm", "fixture"], { cwd: RUN })
try {
  tmux("kill-server")
} catch {}
tmux("new-session", "-d", "-s", "live", "-x", "220", "-y", "60", "-c", REPO, "-e", "OPENCODE_CONFIG_CONTENT=" + JSON.stringify({ model: MODEL }), "bun dev " + RUN)

let browser
try {
  await until(() => /tab agents/.test(screen()), 2 * MINUTE, "OpenCode to start")
  for (let tries = 0; !/Understand ·/.test(screen()) && tries < 5; tries++) {
    tmux("send-keys", "-t", "live", "Tab")
    await sleep(800)
  }
  const footer = screen().split("\n").find((line) => /Understand ·/.test(line))
  if (!footer) throw new Error("could not switch to the understand agent")
  log("agent: " + footer.replace(/[┃╹]/g, "").trim().replace(/\s{2,}.*/, ""))
  tmux("send-keys", "-t", "live", "-l", TASK)
  await sleep(500)
  tmux("send-keys", "-t", "live", "Enter")
  log("task sent, waiting for checkpoint 1")
  const link = (await until(() => /Continue the work/.test(screen()) && screen().match(LINK), 15 * MINUTE, "checkpoint 1"))[0]
  const data = async () => (await fetch(link + "/data", { cache: "no-store" })).json()
  const waiting = (all) => all.checkpoints.find((entry) => entry.status === "waiting")
  log("checkpoint 1 is waiting")

  // ---- The recording ----
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: VIEW, recordVideo: { dir: OUT, size: VIEW } })
  const page = await context.newPage()
  const start = Date.now()
  const events = []
  const mark = (event, text = "") => {
    events.push({ t: Number(((Date.now() - start) / 1000).toFixed(2)), event, text })
    log(event + (text ? ": " + text : ""))
  }
  const waits = []
  const wait = async (what, check, ms) => {
    mark("waiting-start", what)
    const began = Date.now()
    const value = await until(check, ms, what)
    waits.push(what + " " + ((Date.now() - began) / 1000).toFixed(1) + " s")
    mark("waiting-end", what)
    return value
  }
  const shot = (name) => page.screenshot({ path: path.join(OUT, "screenshots", name) })

  const caption = async (text) => {
    await page.evaluate((text) => {
      let box = document.getElementById("__caption")
      if (!box) {
        box = document.createElement("div")
        box.id = "__caption"
        box.style.cssText =
          "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;max-width:80%;" +
          "background:rgba(20,20,18,.88);color:#fff;font:600 20px/1.35 system-ui,-apple-system,sans-serif;" +
          "padding:10px 18px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.25);transition:opacity .4s;opacity:0"
        document.body.append(box)
      }
      if (text) box.textContent = text
      box.style.opacity = text ? "1" : "0"
    }, text)
    mark("caption", text)
    // The caption shows a moment before the action it describes.
    await page.waitForTimeout(text ? 1300 : 500)
  }

  // A visible cursor: a dot that glides to an element before the click lands there.
  const point = async (target) => {
    await target.waitFor({ state: "visible", timeout: 15_000 })
    const inView = await target.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return rect.top >= 70 && rect.bottom <= innerHeight - 90
    })
    if (!inView) {
      await target.evaluate((node) => node.scrollIntoView({ behavior: "smooth", block: "center" }))
      await page.waitForTimeout(900)
    }
    const box = await target.boundingBox()
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.evaluate((at) => {
      let dot = document.getElementById("__cursor")
      if (!dot) {
        dot = document.createElement("div")
        dot.id = "__cursor"
        dot.style.cssText =
          "position:fixed;left:720px;top:450px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;" +
          "background:rgba(214,64,46,.9);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.4);z-index:100000;" +
          "pointer-events:none;transition:left .6s ease,top .6s ease,transform .15s ease"
        document.body.append(dot)
      }
      dot.style.left = at.x + "px"
      dot.style.top = at.y + "px"
    }, at)
    await page.waitForTimeout(750)
    return at
  }
  const click = async (target, label) => {
    const at = await point(target)
    await page.evaluate(() => {
      const dot = document.getElementById("__cursor")
      dot.style.transform = "scale(0.65)"
      setTimeout(() => (dot.style.transform = ""), 180)
    })
    await page.mouse.click(at.x, at.y)
    mark("click", label)
    await page.waitForTimeout(700)
  }
  const type = async (text) => {
    await click(page.locator("#chat-text"), "message box")
    await page.locator("#chat-text").pressSequentially(text, { delay: 40 })
    await page.waitForTimeout(700)
  }
  const heading = async (text) => {
    await page.locator("h2", { hasText: text }).first().evaluate((node) => {
      window.scrollTo({ top: node.getBoundingClientRect().top + window.scrollY - 70, behavior: "smooth" })
    })
    await page.waitForTimeout(1000)
  }
  const top = async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }))
    await page.waitForTimeout(900)
  }
  // The page shows a checkpoint once its title is the heading and its answer bar is there.
  const shown = (entry) =>
    until(async () => (await page.locator(".hero h1").first().textContent().catch(() => "")) === entry.title && (await page.locator(".hero .decide").count()) > 0, 30_000, "the map to show " + entry.title)
  const approve = async () => {
    await click(page.locator(".hero .decide button.primary", { hasText: "Approve" }), "Approve")
    await until(async () => !waiting(await data()), 30_000, "the approval")
  }

  await page.goto(link)
  const first = waiting(await data())
  await shown(first)
  mark("checkpoint", `Checkpoint ${first.number}: ${first.title}`)

  // 1. The checkpoint waits on the map.
  await caption("Checkpoint 1 is waiting. You can answer on the map, not only in the terminal.")
  await page.waitForTimeout(3500)

  // 2. A changed box opens the side panel with that file's diff: the file with the most added lines.
  await caption("Click a box: where the file is and what changed.")
  await heading("How it works")
  const ids = await page.locator(".machine .node").evaluateAll((nodes) => nodes.map((node) => node.dataset.id))
  const file = [...first.files].sort((a, b) => b.additions - a.additions).find((item) => ids.includes(item.file))
  if (!file) throw new Error("no changed file has a box in the flowchart")
  await click(page.locator(`.machine .node[data-id="${file.file}"]`), "box " + file.file)
  await page.locator(".panel").waitFor({ timeout: 10_000 })
  await page.waitForTimeout(3500)

  // 3. Explain one change in place.
  await caption("Explain one change in place.")
  await click(page.locator(".panel .where-row button.tool").filter({ hasText: /^Explain$/ }).first(), "Explain")
  await wait("the model's explanation", () => page.locator(".panel .answer .said, .panel .answer .failed").count(), 3 * MINUTE)
  if (await page.locator(".panel .answer .failed").count()) throw new Error("the explanation failed")
  await page.locator(".panel .answer .said").first().evaluate((node) => node.scrollIntoView({ behavior: "smooth", block: "center" }))
  await page.waitForTimeout(6000)
  await shot("01-panel-explain.png")

  // 4. Approve from the map.
  await caption("Approve from the map.")
  await top()
  await approve()
  await page.waitForTimeout(2500)

  // 5. Ask for more in the chat.
  await caption("Ask for more, in plain words.")
  await click(page.locator("#chat-open"), "Ask the agent")
  await type(ASK)
  await click(page.locator("#chat-send"), "Send")
  mark("send", ASK)
  await until(() => page.locator("#chat-note").filter({ hasText: /^Sent/ }).count(), 15_000, "the message to be sent")
  await page.waitForTimeout(2500)
  await shot("02-chat-open.png")

  // 6. The boxes of the files the agent is editing pulse "changing now".
  await caption("The map updates while the agent edits.")
  await click(page.locator("#chat-close"), "close the chat")
  await heading("How it works")
  await wait("the agent to start editing", async () => {
    if (await page.locator(".machine .node.live").count()) return true
    if (waiting(await data())) throw new Error("checkpoint 2 came before any box was marked changing now")
  }, 5 * MINUTE)
  await page.waitForTimeout(5000)
  const second = await wait("checkpoint 2", async () => {
    const entry = waiting(await data())
    return entry && entry.number === 2 && entry.revision === 1 && entry
  }, 10 * MINUTE)
  if (!/genre/i.test(JSON.stringify([second.title, second.impact, second.files]))) throw new Error("checkpoint 2 is not about the genres: " + second.title)
  await shown(second)
  mark("checkpoint", `Checkpoint 2: ${second.title}`)

  // 7. Checkpoint 2 with its new flowchart.
  await caption("Checkpoint 2: the new flow, drawn again.")
  await page.waitForTimeout(1500)
  await heading("How it works")
  await page.waitForTimeout(4000)
  await shot("03-checkpoint2-flow.png")

  // 8. A change request while checkpoint 2 waits comes back as revision 2.
  await caption("Ask for a change: it comes back as a revision.")
  await click(page.locator("#chat-open"), "Ask the agent")
  await type(REVISE)
  await click(page.locator("#chat-send"), "Send")
  mark("send", REVISE)
  await until(() => page.locator("#chat-note").filter({ hasText: /^Sent as your answer/ }).count(), 15_000, "the revision request to be sent")
  await page.waitForTimeout(2500)
  await click(page.locator("#chat-close"), "close the chat")
  const revision = await wait("revision 2", async () => {
    const entry = waiting(await data())
    return entry && entry.number === 2 && entry.revision === 2 && entry
  }, 10 * MINUTE)
  await shown(revision)
  mark("checkpoint", `Checkpoint 2, revision 2: ${revision.title}`)
  const sorting = /\.sort\(|localeCompare/
  const sorted = revision.files.find((item) => item.blocks.some((block) => sorting.test(JSON.stringify(block))))
  if (!sorted) throw new Error("revision 2 has no sorting change")
  await heading("How it works")
  const box = page.locator(`.machine .node[data-id="${sorted.file}"]`)
  if (!(await box.count())) throw new Error("the flowchart of revision 2 has no box for " + sorted.file)
  await click(box, "box " + sorted.file)
  await page.locator(".panel").waitFor({ timeout: 10_000 })
  await point(page.locator(".panel tr").filter({ hasText: sorting }).first())
  await page.waitForTimeout(5000)
  await shot("04-revision2-sorting.png")

  // 9. Approve, and the caption fades out.
  await caption("")
  await top()
  await approve()
  await page.waitForTimeout(2000)

  const video = page.video()
  await context.close()
  fs.renameSync(await video.path(), path.join(OUT, "raw.webm"))
  fs.writeFileSync(path.join(OUT, "events.json"), JSON.stringify(events, null, 2) + "\n")
  fs.writeFileSync(path.join(OUT, "waits.txt"), `Model: ${MODEL}. Waits: ${waits.join(", ")}.\n`)
  log("done: " + fs.readdirSync(OUT).join(", "))
} catch (error) {
  // What the terminal showed when the step failed, to see why; it is never part of the recording.
  try {
    fs.writeFileSync(path.join(OUT, "failed-terminal.txt"), screen())
  } catch {}
  throw error
} finally {
  await browser?.close()
  try {
    tmux("kill-server")
  } catch {}
}

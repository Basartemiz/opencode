// Screenshots and a silent screen recording of the survey pages, with short captions drawn on the page.
// Usage: node study/media/record_map.mjs <dir with A.html and B.html> <output dir>
// Needs Playwright (PLAYWRIGHT_MODULE can point at its index.mjs) and Chromium (CHROMIUM_PATH, optional).

import path from "node:path"
import fs from "node:fs"

const [, , pagesDir, outDir] = process.argv
if (!pagesDir || !outDir) {
  console.error("usage: node record_map.mjs <pages dir> <output dir>")
  process.exit(1)
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const VIEW = { width: 1440, height: 900 }
fs.mkdirSync(path.join(outDir, "screenshots"), { recursive: true })
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const url = (name) => "file://" + path.resolve(pagesDir, name)

async function caption(page, text) {
  await page.evaluate((text) => {
    let box = document.getElementById("__caption")
    if (!box) {
      box = document.createElement("div")
      box.id = "__caption"
      box.style.cssText =
        "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;max-width:80%;" +
        "background:rgba(20,20,18,.88);color:#fff;font:600 20px/1.35 system-ui,-apple-system,sans-serif;" +
        "padding:10px 18px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.25);transition:opacity .25s"
      document.body.append(box)
    }
    box.textContent = text
    box.style.opacity = text ? "1" : "0"
  }, text)
}

async function glide(page, locator) {
  const target = page.locator(locator).first()
  if ((await target.count()) === 0) return false
  await target.evaluate((node) => node.scrollIntoView({ behavior: "smooth", block: "start" }))
  await page.waitForTimeout(900)
  return true
}

async function heading(page, text) {
  const target = page.locator("h2", { hasText: text }).first()
  if ((await target.count()) === 0) return false
  await target.evaluate((node) => {
    const top = node.getBoundingClientRect().top + window.scrollY - 70
    window.scrollTo({ top, behavior: "smooth" })
  })
  await page.waitForTimeout(1000)
  return true
}

// Rows of files the agent changed (the tree also lists unchanged files).
const CHANGED_ROW = { selector: "button.row:not(.folder)", hasText: /\b(changed|new)\b/i }

async function click(page, selector, index = 0) {
  const target = (typeof selector === "string" ? page.locator(selector) : page.locator(selector.selector).filter({ hasText: selector.hasText })).nth(index)
  if ((await target.count()) === 0) return false
  await target.scrollIntoViewIfNeeded()
  await target.hover()
  await page.waitForTimeout(350)
  await target.click()
  await page.waitForTimeout(900)
  return true
}

const shot = (page, name) => page.screenshot({ path: path.join(outDir, "screenshots", name) })

// ---- Screenshots ----
{
  const page = await browser.newPage({ viewport: VIEW })
  await page.goto(url("A.html"))
  await page.waitForTimeout(800)
  await shot(page, "01-today-final-diff.png")
  await page.goto(url("B.html"))
  await page.waitForTimeout(1500)
  await page.locator(".study-task").evaluate((node) => node.remove())
  await page.waitForTimeout(300)
  await click(page, "button.pill", 0)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(500)
  await shot(page, "02-map-checkpoint-overview.png")
  // The flow screenshot uses a checkpoint where the map flags a problem, if there is one.
  const count = await page.locator("button.pill").count()
  for (let index = 0; index < count; index++) {
    await click(page, "button.pill", index)
    if ((await page.locator("button.node", { hasText: /missing/i }).count()) > 0) break
  }
  if (await heading(page, "How it works")) await shot(page, "03-map-flow-checked-against-imports.png")
  if (await heading(page, "May be affected")) await shot(page, "03b-map-may-be-affected.png")
  await click(page, "button.pill", 0)
  if (await heading(page, "The project")) {
    await click(page, CHANGED_ROW, 1)
    await heading(page, "The project")
    await shot(page, "04-map-project-tree-and-diff.png")
  }
  // Both sections sit at the bottom of the page, so one screenshot shows them.
  if (await heading(page, "What the agent did")) await shot(page, "05-map-steps-decision-and-session.png")
  await page.close()
}

// ---- Recording ----
{
  const context = await browser.newContext({ viewport: VIEW, recordVideo: { dir: outDir, size: VIEW } })
  const page = await context.newPage()
  await page.goto(url("B.html"))
  await page.waitForTimeout(1200)
  await page.locator(".study-task").evaluate((node) => node.remove())
  await caption(page, "The understand map: one page per checkpoint, opened from the terminal")
  await page.waitForTimeout(3500)

  // Walk the checkpoints in order. Checkpoints with a flagged problem (a dashed arrow or a missing file)
  // and the first one get the full tour; the rest get the overview and the flow.
  const pills = await page.locator("button.pill").count()
  const labels = await page.locator("button.pill").allTextContents()
  for (let index = 0; index < pills; index++) {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }))
    await page.waitForTimeout(700)
    await click(page, "button.pill", index)
    await caption(page, `Checkpoint ${index + 1} of ${pills}: ${labels[index].replace(/^\d+(r\d+)?/, "").replace(/(Approved|Revision asked|Stopped)$/, "").trim()}`)
    await page.waitForTimeout(2200)
    const missing = page.locator("button.node", { hasText: /missing/i })
    const flagged = (await missing.count()) > 0
    const full = index === 0 || flagged
    if (full && (await heading(page, "The big picture"))) {
      await caption(page, "The agent's explanation, labelled as its own words")
      await page.waitForTimeout(2500)
    }
    if (await heading(page, "How it works")) {
      if (flagged) {
        await caption(page, "The agent says it added a route file, but that file does not exist: the map marks it as missing")
        await missing.first().hover()
        await page.waitForTimeout(5500)
      } else {
        await caption(page, "How the program moves through the change; arrows are checked against real imports")
        await page.waitForTimeout(full ? 3500 : 2500)
      }
    }
    if (full && (await heading(page, "May be affected"))) {
      await caption(page, "Files that were not changed but import a changed file")
      await page.waitForTimeout(3000)
    }
    if (full && (await heading(page, "The project"))) {
      await click(page, CHANGED_ROW, 0)
      await heading(page, "The project")
      await caption(page, "The agent's note for each file, next to the real diff")
      await page.waitForTimeout(3500)
    }
    if (index === 0 && (await heading(page, "What the agent did"))) {
      await caption(page, "The steps the agent took, and the user's decision")
      await page.waitForTimeout(2800)
    }
  }
  if (await heading(page, "This session")) {
    await caption(page, "The whole session at a glance")
    await page.waitForTimeout(3000)
  }
  await caption(page, "")
  await page.waitForTimeout(600)
  const video = page.video()
  await context.close()
  const recorded = await video.path()
  fs.renameSync(recorded, path.join(outDir, "map.webm"))
}

await browser.close()
console.log("done:", fs.readdirSync(outDir).join(", "), "|", fs.readdirSync(path.join(outDir, "screenshots")).join(", "))

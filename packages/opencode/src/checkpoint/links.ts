import path from "path"
import { Effect, Option } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { Ripgrep } from "@opencode-ai/core/ripgrep"
import type { Checkpoint } from "."

// Which project files a changed file uses, read from its import lines. This is a fact the map's diagram
// can show next to the agent's explanation. Packages such as "react" are left out: only local files count.

const SCRIPTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".astro"])
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".css", ".vue", ".svelte"]
// import ... from "x", export ... from "x", import "x", import("x"), require("x")
const SCRIPT_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g
// from .cart import total, from . import cart, import shop.tax
const PYTHON_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([\w \t,]+)/gm
const PYTHON_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm
const HTML_LINK = /\b(?:src|href)\s*=\s*["']([^"']+)["']/g
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/g
const EXTERNAL = /^(?:[a-z][\w+.-]*:|\/\/|#)/i
const USER = /^(?:user|you)$/i
// Files that can import another file. A search finds the ones that name a changed file; reading them confirms it.
const READERS = "*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,vue,svelte,astro,py,html,htm,css,scss,less}"
const MAX_MATCHES = 2000
const MAX_READERS = 200
const MAX_LINES = 4

// For each local import of `file`, the project paths it may point to, best guess first.
export function candidates(file: string, content: string): string[][] {
  const directory = path.posix.dirname(file)
  const extension = path.posix.extname(file).toLowerCase()
  const lists = (() => {
    if (SCRIPTS.has(extension))
      return [...content.matchAll(SCRIPT_IMPORT)]
        .map((match) => match[1])
        .filter((specifier) => specifier.startsWith("."))
        .map((specifier) => script(path.posix.join(directory, specifier)))
    if (extension === ".py") return python(directory, content)
    if (extension === ".html" || extension === ".htm")
      return [...content.matchAll(HTML_LINK)]
        .map((match) => match[1].split(/[?#]/)[0])
        .filter((link) => link && !EXTERNAL.test(link))
        .map((link) => [link.startsWith("/") ? link.slice(1) : path.posix.join(directory, link)])
    if (extension === ".css" || extension === ".scss" || extension === ".less")
      return [...content.matchAll(CSS_IMPORT)]
        .map((match) => match[1])
        .filter((link) => !EXTERNAL.test(link))
        .map((link) => [path.posix.join(directory, link)])
    return []
  })()
  return lists
    .map((options) => options.map((option) => path.posix.normalize(option)).filter(inside))
    .filter((options, index, all) => options.length && all.findIndex((other) => other[0] === options[0]) === index)
}

// Agents write paths in different ways, such as "./src/a.ts" or just "a.ts".
export function same(left: string, right: string) {
  const a = clean(left)
  const b = clean(right)
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

// The agent's flow starts with the user, who is not a file.
export function user(name: string) {
  return USER.test(name.trim())
}

// The links from each file to the project files it uses, keeping the first candidate that exists.
export const find = Effect.fn("CheckpointLinks.find")(function* (
  fs: FSUtil.Interface,
  directory: string,
  files: readonly string[],
) {
  const found = yield* Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        const content = yield* fs
          .readFileStringSafe(path.join(directory, file))
          .pipe(Effect.orElseSucceed(() => undefined))
        const targets = yield* Effect.forEach(candidates(file, content ?? ""), (options) =>
          Effect.findFirst(options, (option) => fs.isFile(path.join(directory, option))),
        )
        return targets.flatMap((target) =>
          Option.isSome(target) && target.value !== file ? [{ from: file, to: target.value }] : [],
        )
      }),
    { concurrency: 4 },
  )
  return found
    .flat()
    .filter((link, index, all) => all.findIndex((other) => other.from === link.from && other.to === link.to) === index)
})

// The project files that import a changed file but were not changed themselves: code the change may break.
export const affected = Effect.fn("CheckpointLinks.affected")(function* (
  fs: FSUtil.Interface,
  ripgrep: Ripgrep.Interface,
  directory: string,
  files: readonly Pick<Checkpoint.File, "file" | "status" | "symbols">[],
) {
  // Nothing in the project can have used a file that did not exist before.
  const targets = files.filter((file) => file.status !== "added")
  if (!targets.length) return []
  const names = [...new Set(targets.map((file) => escape(stem(file.file))))]
  const matches = yield* ripgrep
    .grep({
      cwd: directory,
      pattern: `\\b(?:import|require|from|src|href)\\b.*(?:${names.join("|")})`,
      include: READERS,
      limit: MAX_MATCHES,
    })
    .pipe(Effect.orElseSucceed(() => []))
  const readers = [...new Set(matches.map((match) => match.entry.path.replaceAll("\\", "/")))]
    .filter((file) => !files.some((changed) => changed.file === file))
    .slice(0, MAX_READERS)
  const found = yield* Effect.forEach(
    readers,
    (file) =>
      fs.readFileStringSafe(path.join(directory, file)).pipe(
        Effect.map((content) => (content ? uses(file, content, targets) : [])),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 8 },
  )
  return found.flat().sort((a, b) => a.file.localeCompare(b.file))
})

function script(target: string) {
  // TypeScript projects import "./greet.js" for greet.ts.
  const typed = target.match(/\.(m|c)?jsx?$/) ? [target.replace(/\.(m|c)?js(x?)$/, ".$1ts$2")] : []
  return [
    target,
    ...typed,
    ...EXTENSIONS.map((extension) => target + extension),
    ...EXTENSIONS.slice(0, 4).map((extension) => `${target}/index${extension}`),
  ]
}

function python(directory: string, content: string) {
  const from = [...content.matchAll(PYTHON_FROM)].map((match) => {
    const dots = match[1].length
    const module = match[2].replaceAll(".", "/")
    const names = match[3]
      .split(",")
      .map((name) => name.trim().split(/\s+/)[0])
      .filter(Boolean)
    // One dot is the file's own folder, each further dot one folder up; no dots means the project root.
    const roots = dots ? [path.posix.join(directory, ...Array(dots - 1).fill(".."))] : ["", directory]
    return roots.flatMap((root) => [
      ...names.map((name) => path.posix.join(root, module, `${name}.py`)),
      ...(module ? [path.posix.join(root, `${module}.py`), path.posix.join(root, module, "__init__.py")] : []),
    ])
  })
  const plain = [...content.matchAll(PYTHON_IMPORT)].flatMap((match) =>
    match[1].split(",").map((name) => {
      const module = name.trim().replaceAll(".", "/")
      return ["", directory].flatMap((root) => [
        path.posix.join(root, `${module}.py`),
        path.posix.join(root, module, "__init__.py"),
      ])
    }),
  )
  return [...from, ...plain]
}

// What one file uses of the changed files: the ones it imports, the changed names it mentions, and where.
function uses(
  file: string,
  content: string,
  targets: readonly Pick<Checkpoint.File, "file" | "symbols">[],
): Checkpoint.Affected[] {
  const imports = candidates(file, content)
  const used = targets.filter((target) => imports.some((options) => options.includes(target.file)))
  if (!used.length) return []
  const names = [
    ...new Set(
      used.flatMap((target) =>
        (target.symbols ?? []).flatMap((symbol) => (symbol.change === "added" ? [] : [symbol.name])),
      ),
    ),
  ].filter((name) => word(name).test(content))
  // Where it uses what changed, or where it imports the changed file when it names nothing that changed.
  const marks = (names.length ? names : used.map((target) => stem(target.file))).map(word)
  const lines = content
    .split("\n")
    .flatMap((text, index) =>
      marks.some((mark) => mark.test(text)) ? [{ line: index + 1, text: text.trim().slice(0, 200) }] : [],
    )
    .slice(0, MAX_LINES)
  return [{ file, uses: used.map((target) => target.file), names, lines }]
}

// The name other files import a file by: "cart" for src/cart.js, "utils" for src/utils/index.ts, "styles.css" for a stylesheet.
function stem(file: string) {
  const parsed = path.posix.parse(file)
  if (!SCRIPTS.has(parsed.ext) && parsed.ext !== ".py") return parsed.base
  if (parsed.name === "index" || parsed.name === "__init__") return path.posix.basename(parsed.dir) || parsed.name
  return parsed.name
}

function word(name: string) {
  return new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`)
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function clean(file: string) {
  return path.posix.normalize(file.trim().replaceAll("\\", "/")).replace(/^\.\//, "")
}

function inside(file: string) {
  return file !== "." && !file.startsWith("../") && file !== ".." && !path.posix.isAbsolute(file)
}

export * as CheckpointLinks from "./links"

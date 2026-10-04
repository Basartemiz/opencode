import path from "path"
import { pathToFileURL } from "url"
import { Effect, Option, Schema } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { LSP } from "@/lsp/lsp"
import { Checkpoint } from "."

// Which functions, classes, and methods a change touched, so the map can lead from a file to the lines that changed
// in each of its functions. A language server knows a file's outline best, but OpenCode only runs one when the config
// enables it, so without one the outline is read from the file's text, for JavaScript, TypeScript, and Python.

type Kind = Checkpoint.Symbol["kind"]
// A named part of a file and its lines, before we know whether the change touched it.
type Declared = { name: string; kind: Kind; parent?: string; start: number; end: number }
type Block = ReturnType<typeof Checkpoint.blocks>[number]
type Spot = { line: number; kind: "add" | "del" }
type Source = { code: string[]; depth: number[] }

const SERVER_WAIT = "3 seconds"
const SCRIPTS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".astro",
  ".html",
  ".htm",
])
// Starts each line that begins inside a comment or string, which can neither declare anything nor end a declaration.
const INSIDE = "\u0000"
// Comments and strings, whose brackets and keywords are not code.
const SCRIPT_TEXT =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|\$\{[^}]*\}|[^\\`])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g
const PYTHON_TEXT = /"""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g
const FUNCTION = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const CLASS = /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/
const TYPE = /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|(?:const\s+)?enum)\s+([A-Za-z_$][\w$]*)/
const VALUE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=(?!=)\s*(.*)$/
// The value of a declaration that makes it a function: an arrow function or a function expression.
const LAMBDA = /^(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/
const METHOD =
  /^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*\(.*\{\s*$/
const PROPERTY =
  /^\s*(?:(?:public|private|protected|static|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/
const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "function",
  "else",
  "do",
  "try",
  "new",
  "await",
  "typeof",
  "void",
  "yield",
  "extends",
  "implements",
])
const PYTHON_DEF = /^(\s*)(?:async\s+)?def\s+(\w+)/
const PYTHON_CLASS = /^(\s*)class\s+(\w+)/
const PYTHON_VALUE = /^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/
// Language server symbol kinds, from the LSP specification.
const KINDS: Record<number, Kind> = {
  5: "class",
  6: "method",
  9: "method",
  10: "type",
  11: "type",
  12: "function",
  13: "variable",
  14: "variable",
  23: "class",
}

const Position = Schema.Struct({ line: Schema.Finite })
const Range = Schema.Struct({ start: Position, end: Position })
// One entry of a language server's outline: a document symbol with its children, or a flat symbol information.
const Outlined = Schema.Struct({
  name: Schema.String,
  kind: Schema.Finite,
  range: Schema.optional(Range),
  location: Schema.optional(Schema.Struct({ range: Range })),
  containerName: Schema.optional(Schema.String),
  children: Schema.optional(Schema.Array(Schema.Unknown)),
})

// For each changed file, the parts of it the change touched.
export const find = Effect.fn("CheckpointSymbols.find")(function* (
  fs: FSUtil.Interface,
  lsp: LSP.Interface,
  directory: string,
  files: readonly Pick<Checkpoint.File, "file" | "status" | "patch">[],
) {
  return yield* Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        if (file.status === "deleted") return touched(file, [])
        const target = path.join(directory, file.file)
        const content = yield* fs.readFileStringSafe(target).pipe(Effect.orElseSucceed(() => undefined))
        if (content === undefined) return []
        const read = scan(file.file, content)
        const served = yield* server(lsp, target)
        if (!served.length) return touched(file, read)
        // The TypeScript server calls a function stored in a constant a constant; the file's text shows it is a function.
        return touched(
          file,
          served.map((item) =>
            item.kind === "variable" &&
            read.some((other) => other.kind === "function" && other.name === item.name && other.start === item.start)
              ? { ...item, kind: "function" as const }
              : item,
          ),
        )
      }),
    { concurrency: 4 },
  )
})

// The declared parts of a file that its change touched, and the parts it removed. When a change touches a part
// inside another, such as a method in a class, the inner part is named, unless the outer one is new as a whole.
export function touched(
  file: Pick<Checkpoint.File, "file" | "status" | "patch">,
  declared: readonly Declared[],
): Checkpoint.Symbol[] {
  const blocks = Checkpoint.blocks(file.patch ?? "")
  // What the removed lines declared, with their lines in the old file: parts the change rewrote or removed.
  const before = blocks.flatMap((block) => {
    const lines = block.lines.filter((line) => line.kind === "del")
    return scan(file.file, lines.map((line) => line.text).join("\n")).map((item) => ({
      ...item,
      start: lines[item.start - 1]?.old ?? 0,
      end: lines[item.end - 1]?.old ?? 0,
    }))
  })
  const spots = blocks.flatMap(positions)
  const added = new Set(spots.flatMap((spot) => (spot.kind === "add" ? [spot.line] : [])))
  // New when every line of it is new and the removed lines did not declare it, which would make it rewritten.
  const whole = (item: Declared) =>
    !before.some((other) => other.name === item.name) &&
    Array.from({ length: item.end - item.start + 1 }, (_, offset) => item.start + offset).every((line) =>
      added.has(line),
    )
  const removed = before.filter(
    (item) => item.kind !== "variable" && !declared.some((other) => other.name === item.name),
  )
  const hit = declared.filter((item) => spots.some((spot) => holds(item, spot)))
  return [
    ...hit
      .filter((item) => {
        if (hit.some((other) => other !== item && contains(other, item) && whole(other))) return false
        const inner = hit.filter((other) => other !== item && contains(item, other))
        return (
          !inner.length ||
          whole(item) ||
          spots.some((spot) => holds(item, spot) && !inner.some((other) => holds(other, spot)))
        )
      })
      .map((item) => ({ ...item, change: whole(item) ? ("added" as const) : ("changed" as const) })),
    ...removed
      .filter((item) => !removed.some((other) => other !== item && contains(other, item)))
      .map((item) => ({ ...item, change: "removed" as const })),
  ]
}

// Which of a file's touched parts a block of its diff falls in, as positions in `symbols`.
export function within(block: Block, symbols: readonly Checkpoint.Symbol[]) {
  const spots = positions(block)
  const old = block.lines.flatMap((line) => (line.kind === "del" && line.old !== undefined ? [line.old] : []))
  return symbols.flatMap((symbol, index) => {
    if (symbol.change === "removed")
      return old.some((line) => symbol.start <= line && line <= symbol.end) ? [index] : []
    return spots.some((spot) => holds(symbol, spot)) ? [index] : []
  })
}

// Reads the declared parts of a file from its text, for files no language server outlines.
export function scan(file: string, content: string): Declared[] {
  const extension = path.extname(file).toLowerCase()
  if (extension === ".py") return nest(python(read(content, PYTHON_TEXT)))
  if (SCRIPTS.has(extension)) return nest(script(read(content, SCRIPT_TEXT)))
  return []
}

// A language server's outline as declared parts. Local variables inside functions are left out, and so are
// anonymous functions, which servers name after where they are used, such as "items.map() callback".
export function outline(results: readonly unknown[], parent?: string): Declared[] {
  return results.flatMap((result) => {
    const item = Option.getOrUndefined(Schema.decodeUnknownOption(Outlined)(result))
    if (!item) return []
    const range = item.range ?? item.location?.range
    const kind = KINDS[item.kind]
    const owner = parent ?? (item.containerName || undefined)
    const own =
      range && kind && !/\s/.test(item.name) && !(kind === "variable" && owner)
        ? [
            {
              name: item.name,
              kind,
              ...(owner ? { parent: owner } : {}),
              start: range.start.line + 1,
              end: range.end.line + 1,
            },
          ]
        : []
    return [...own, ...outline(item.children ?? [], own.length ? item.name : owner)]
  })
}

// The language server's outline of a file, when one runs for it and answers in time.
const server = Effect.fnUntraced(function* (lsp: LSP.Interface, file: string) {
  if (!(yield* lsp.hasClients(file))) return []
  const results = yield* lsp.touchFile(file).pipe(
    Effect.andThen(lsp.documentSymbol(pathToFileURL(file).href)),
    Effect.timeout(SERVER_WAIT),
    Effect.orElseSucceed(() => []),
  )
  // Two servers can outline the same file.
  return outline(results).filter(
    (item, index, all) => all.findIndex((other) => other.name === item.name && other.start === item.start) === index,
  )
})

// Where each changed line of a block sits in the new file. A removed line sits at the line that now follows it.
function positions(block: Block) {
  return block.lines.reduce<{ next: number; spots: Spot[] }>(
    (result, line) => {
      const at = line.new ?? result.next
      if (line.kind === "same") return { ...result, next: at + 1 }
      if (line.kind === "add") return { next: at + 1, spots: [...result.spots, { line: at, kind: "add" }] }
      return { ...result, spots: [...result.spots, { line: result.next, kind: "del" }] }
    },
    // A block that only removes lines is numbered from the line before the removal.
    { next: block.after.lines ? block.after.start : block.after.start + 1, spots: [] },
  ).spots
}

function holds(item: Pick<Declared, "start" | "end">, spot: Spot) {
  // A removed line just before a part's first line is outside it.
  if (spot.kind === "del") return item.start < spot.line && spot.line <= item.end
  return item.start <= spot.line && spot.line <= item.end
}

function contains(outer: Declared, inner: Declared) {
  return (
    outer.start <= inner.start && inner.end <= outer.end && (outer.start !== inner.start || outer.end !== inner.end)
  )
}

// The file's lines with comments and strings blanked out, and the bracket depth at the start of each line.
function read(content: string, text: RegExp): Source {
  const code = content
    .replace(text, (match) => match.replace(/[^\n]/g, " ").replaceAll("\n", "\n" + INSIDE))
    .split("\n")
  const depth = code.reduce(
    (all, line) => {
      all.push(all[all.length - 1] + (line.match(/[([{]/g)?.length ?? 0) - (line.match(/[)\]}]/g)?.length ?? 0))
      return all
    },
    [0],
  )
  return { code, depth }
}

// JavaScript and TypeScript: functions at any depth, values at the top, and the members of each class.
function script(source: Source): Declared[] {
  const top = source.code.flatMap((line, index) => {
    const found = declaration(line, source.depth[index])
    return found && !KEYWORDS.has(found.name)
      ? [{ ...found, start: index + 1, end: close(source, index) + 1, depth: source.depth[index] }]
      : []
  })
  const classes = top.filter((item) => item.kind === "class")
  const members = source.code.flatMap((line, index) => {
    const owner = classes.some(
      (item) => item.start <= index && index < item.end && source.depth[index] === item.depth + 1,
    )
    const name = owner ? (line.match(METHOD)?.[1] ?? line.match(PROPERTY)?.[1]) : undefined
    return name && !KEYWORDS.has(name)
      ? [{ name, kind: "method" as const, start: index + 1, end: close(source, index) + 1 }]
      : []
  })
  return [...top.map((item) => ({ name: item.name, kind: item.kind, start: item.start, end: item.end })), ...members]
}

function declaration(line: string, depth: number): { name: string; kind: Kind } | undefined {
  const named = line.match(FUNCTION)
  if (named) return { name: named[1], kind: "function" }
  const type = line.match(CLASS)
  if (type) return { name: type[1], kind: "class" }
  const alias = line.match(TYPE)
  if (alias) return { name: alias[1], kind: "type" }
  const value = line.match(VALUE)
  if (value && LAMBDA.test(value[2])) return { name: value[1], kind: "function" }
  if (value && depth === 0) return { name: value[1], kind: "variable" }
  return undefined
}

// The last line of what starts on line `index`: where its brackets close and no string or comment runs on.
function close(source: Source, index: number) {
  const found = source.code.findIndex(
    (_, line) =>
      line >= index && source.depth[line + 1] <= source.depth[index] && !source.code[line + 1]?.startsWith(INSIDE),
  )
  return found === -1 ? source.code.length - 1 : found
}

// Python: functions and classes end where the indentation goes back to theirs; decorators belong to them.
function python(source: Source): Declared[] {
  return source.code.flatMap<Declared>((line, index) => {
    const def = line.match(PYTHON_DEF) ?? line.match(PYTHON_CLASS)
    if (def) {
      const indent = def[1].length
      return [
        {
          name: def[2],
          kind: PYTHON_DEF.test(line) ? ("function" as const) : ("class" as const),
          start: decorated(source.code, index, indent) + 1,
          end: block(source, index, indent) + 1,
        },
      ]
    }
    const value = source.depth[index] === 0 ? line.match(PYTHON_VALUE) : undefined
    return value ? [{ name: value[1], kind: "variable" as const, start: index + 1, end: close(source, index) + 1 }] : []
  })
}

function decorated(code: string[], index: number, indent: number): number {
  const above = code[index - 1]
  if (above === undefined || !above.trimStart().startsWith("@") || indentation(above) !== indent) return index
  return decorated(code, index - 1, indent)
}

// The last line of a Python block: the last code line before the next one at the same or a lower indentation.
function block(source: Source, index: number, indent: number) {
  const code = (line: string) => line.replace(INSIDE, "").trim() !== ""
  const next = source.code.findIndex(
    (line, position) =>
      position > index &&
      code(line) &&
      !line.startsWith(INSIDE) &&
      source.depth[position] === 0 &&
      indentation(line) <= indent,
  )
  const last = source.code.findLastIndex(
    (line, position) => position > index && position < (next === -1 ? source.code.length : next) && code(line),
  )
  return last === -1 ? index : last
}

function indentation(line: string) {
  return line.length - line.trimStart().length
}

// Gives each part the innermost class or function it sits in; a function inside a class is a method.
function nest(items: Declared[]): Declared[] {
  const sorted = [...items].sort((a, b) => a.start - b.start)
  return sorted.map((item) => {
    const parent = sorted.findLast(
      (other) =>
        other !== item &&
        (other.kind === "class" || other.kind === "function" || other.kind === "method") &&
        other.start <= item.start &&
        item.end <= other.end &&
        (other.start !== item.start || other.end !== item.end),
    )
    if (!parent) return item
    return {
      ...item,
      kind: parent.kind === "class" && item.kind === "function" ? "method" : item.kind,
      parent: parent.name,
    }
  })
}

export * as CheckpointSymbols from "./symbols"

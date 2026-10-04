import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Checkpoint } from "../../src/checkpoint"
import { CheckpointSymbols } from "../../src/checkpoint/symbols"
import type { LSP } from "../../src/lsp/lsp"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

const patch = (file: string, ...body: string[]) => [`Index: ${file}`, `--- ${file}`, `+++ ${file}`, ...body].join("\n")

describe("CheckpointSymbols.scan", () => {
  test("reads the functions, classes, methods, and top-level values of a script with their lines", () => {
    const content = [
      'import { tax } from "./tax.js"',
      "",
      "export const PRICES = {",
      "  apple: 1,",
      "}",
      "",
      "export function total(items) {",
      "  return items.reduce((sum, item) => {",
      "    return sum + PRICES[item]",
      "  }, 0)",
      "}",
      "",
      "const discount = async (code) => {",
      "  return code === 'SAVE10' ? 0.1 : 0",
      "}",
      "",
      "export class Cart {",
      "  add(item) {",
      "    if (item) {",
      "      this.items.push(item)",
      "    }",
      "  }",
      "  static empty = () => new Cart()",
      "}",
    ].join("\n")

    expect(CheckpointSymbols.scan("src/cart.js", content)).toEqual([
      { name: "PRICES", kind: "variable", start: 3, end: 5 },
      { name: "total", kind: "function", start: 7, end: 11 },
      { name: "discount", kind: "function", start: 13, end: 15 },
      { name: "Cart", kind: "class", start: 17, end: 24 },
      { name: "add", kind: "method", parent: "Cart", start: 18, end: 22 },
      { name: "empty", kind: "method", parent: "Cart", start: 23, end: 23 },
    ])
  })

  test("ignores declarations inside comments and strings", () => {
    const content = [
      "// function old() {",
      "/* class Hidden {",
      "} */",
      'const text = "function fake() {"',
      "const html = `",
      "  <p>{</p>",
      "`",
      "function real() {",
      "  return 1",
      "}",
    ].join("\n")

    expect(CheckpointSymbols.scan("page.ts", content)).toEqual([
      { name: "text", kind: "variable", start: 4, end: 4 },
      { name: "html", kind: "variable", start: 5, end: 7 },
      { name: "real", kind: "function", start: 8, end: 10 },
    ])
  })

  test("reads Python functions, classes, and methods by their indentation", () => {
    const content = [
      "import os",
      "",
      "TAX = 0.2",
      "",
      "@cache",
      "def total(items):",
      '    """Adds up the prices.',
      "",
      'Notes at the left edge."""',
      "    return sum(items) * (1 + TAX)",
      "",
      "class Cart:",
      "    def add(self, item):",
      "        self.items.append(item)",
      "",
      "    def clear(self):",
      "        self.items = []",
      "",
      "print(total([1]))",
    ].join("\n")

    expect(CheckpointSymbols.scan("shop/cart.py", content)).toEqual([
      { name: "TAX", kind: "variable", start: 3, end: 3 },
      { name: "total", kind: "function", start: 5, end: 10 },
      { name: "Cart", kind: "class", start: 12, end: 17 },
      { name: "add", kind: "method", parent: "Cart", start: 13, end: 14 },
      { name: "clear", kind: "method", parent: "Cart", start: 16, end: 17 },
    ])
  })

  test("reads nothing from files it does not understand", () => {
    expect(CheckpointSymbols.scan("notes.md", "function total() {\n}")).toEqual([])
  })
})

describe("CheckpointSymbols.outline", () => {
  test("reads the language server's outline, nested or flat, and leaves local variables out", () => {
    const range = (start: number, end: number) => ({
      start: { line: start, character: 0 },
      end: { line: end, character: 1 },
    })
    const nested = [
      {
        name: "Cart",
        kind: 5,
        range: range(0, 9),
        selectionRange: range(0, 0),
        children: [
          {
            name: "total",
            kind: 6,
            range: range(1, 3),
            selectionRange: range(1, 1),
            children: [{ name: "sum", kind: 13, range: range(2, 2), selectionRange: range(2, 2) }],
          },
        ],
      },
      { name: "TAX", kind: 14, range: range(11, 11), selectionRange: range(11, 11) },
    ]
    const flat = [
      { name: "greet", kind: 12, location: { uri: "file:///p/a.ts", range: range(4, 6) } },
      // TypeScript names anonymous functions after where they are used; they are not parts anyone declared.
      {
        name: "items.map() callback",
        kind: 12,
        containerName: "greet",
        location: { uri: "file:///p/a.ts", range: range(5, 5) },
      },
    ]

    expect(CheckpointSymbols.outline(nested)).toEqual([
      { name: "Cart", kind: "class", start: 1, end: 10 },
      { name: "total", kind: "method", parent: "Cart", start: 2, end: 4 },
      { name: "TAX", kind: "variable", start: 12, end: 12 },
    ])
    expect(CheckpointSymbols.outline(flat)).toEqual([{ name: "greet", kind: "function", start: 5, end: 7 }])
  })
})

describe("CheckpointSymbols.touched", () => {
  const cart = [
    "export function total(items) {",
    "  const sum = items.reduce((a, b) => a + b, 0)",
    "  return sum * 0.9",
    "}",
    "",
    "export function applyCode(code) {",
    "  return code === 'SAVE10'",
    "}",
  ].join("\n")
  const changes = patch(
    "src/cart.js",
    "@@ -1,4 +1,4 @@",
    " export function total(items) {",
    "   const sum = items.reduce((a, b) => a + b, 0)",
    "-  return sum",
    "+  return sum * 0.9",
    " }",
    "@@ -6,3 +6,3 @@",
    "-export function oldTotal(items) {",
    "-  return 0",
    "-}",
    "+export function applyCode(code) {",
    "+  return code === 'SAVE10'",
    "+}",
  )

  test("marks the functions a change touched as changed or new, and the ones it deleted as removed", () => {
    const file = { file: "src/cart.js", status: "modified" as const, patch: changes }

    expect(CheckpointSymbols.touched(file, CheckpointSymbols.scan(file.file, cart))).toEqual([
      { name: "total", kind: "function", change: "changed", start: 1, end: 4 },
      { name: "applyCode", kind: "function", change: "added", start: 6, end: 8 },
      { name: "oldTotal", kind: "function", change: "removed", start: 6, end: 8 },
    ])
  })

  test("names the method that changed with its class, and the class when one of its own lines changed", () => {
    const content = [
      "class Cart extends Base {",
      "  constructor() {",
      "    super()",
      "  }",
      "  total() {",
      "    return 1",
      "  }",
      "}",
    ].join("\n")
    const declared = CheckpointSymbols.scan("cart.ts", content)
    const method = patch("cart.ts", "@@ -5,3 +5,3 @@", "   total() {", "-    return 0", "+    return 1", "   }")
    const own = patch("cart.ts", "@@ -1,2 +1,2 @@", "-class Cart {", "+class Cart extends Base {", "   constructor() {")

    expect(CheckpointSymbols.touched({ file: "cart.ts", status: "modified", patch: method }, declared)).toEqual([
      { name: "total", kind: "method", parent: "Cart", change: "changed", start: 5, end: 7 },
    ])
    expect(CheckpointSymbols.touched({ file: "cart.ts", status: "modified", patch: own }, declared)).toEqual([
      { name: "Cart", kind: "class", change: "changed", start: 1, end: 8 },
    ])
  })

  test("lists the parts of a new file as new, without the methods inside a new class", () => {
    const lines = [
      "export class Cart {",
      "  add(item) {",
      "    this.items.push(item)",
      "  }",
      "}",
      "export const empty = () => new Cart()",
    ]
    const file = {
      file: "cart.ts",
      status: "added" as const,
      patch: patch("cart.ts", "@@ -0,0 +1,6 @@", ...lines.map((line) => "+" + line)),
    }

    expect(CheckpointSymbols.touched(file, CheckpointSymbols.scan(file.file, lines.join("\n")))).toEqual([
      { name: "Cart", kind: "class", change: "added", start: 1, end: 5 },
      { name: "empty", kind: "function", change: "added", start: 6, end: 6 },
    ])
  })

  test("finds no function when the change is outside them", () => {
    const content = 'import { a } from "./a.js"\n\nexport function f() {\n  return a\n}'
    const file = {
      file: "b.ts",
      status: "modified" as const,
      patch: patch("b.ts", "@@ -1 +1 @@", '-import { a } from "./a"', '+import { a } from "./a.js"'),
    }

    expect(CheckpointSymbols.touched(file, CheckpointSymbols.scan(file.file, content))).toEqual([])
  })

  test("tells which parts each block of the diff falls in", () => {
    const file = { file: "src/cart.js", status: "modified" as const, patch: changes }
    const symbols = CheckpointSymbols.touched(file, CheckpointSymbols.scan(file.file, cart))

    expect(Checkpoint.blocks(changes).map((block) => CheckpointSymbols.within(block, symbols))).toEqual([[0], [1, 2]])
  })
})

describe("CheckpointSymbols.find", () => {
  it.instance("uses the language server's outline, and the file's text to tell which constants hold functions", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const content = [
        "export const TAX = 0.08",
        "",
        "export const discount = (code: string) => {",
        "  return code === 'SAVE10' ? 0.1 : 0",
        "}",
      ].join("\n")
      yield* Effect.promise(() => Bun.write(path.join(instance.directory, "cart.ts"), content))
      const at = (start: number, end: number) => ({
        uri: "file:///cart.ts",
        range: { start: { line: start, character: 0 }, end: { line: end, character: 1 } },
      })
      // A language server's answer, as typescript-language-server gives it: a function stored in a constant is a constant.
      const lsp = {
        hasClients: () => Effect.succeed(true),
        touchFile: () => Effect.void,
        documentSymbol: () =>
          Effect.succeed([
            { name: "TAX", kind: 14, location: at(0, 0) },
            { name: "discount", kind: 14, location: at(2, 4) },
          ]),
      } as unknown as LSP.Interface
      const patch = [
        "Index: cart.ts",
        "--- cart.ts",
        "+++ cart.ts",
        "@@ -1,4 +1,4 @@",
        "-export const TAX = 0.2",
        "+export const TAX = 0.08",
        " ",
        " export const discount = (code: string) => {",
        "-  return 0",
        "+  return code === 'SAVE10' ? 0.1 : 0",
      ].join("\n")

      expect(
        yield* CheckpointSymbols.find(fs, lsp, instance.directory, [{ file: "cart.ts", status: "modified", patch }]),
      ).toEqual([
        [
          { name: "TAX", kind: "variable", change: "changed", start: 1, end: 1 },
          { name: "discount", kind: "function", change: "changed", start: 3, end: 5 },
        ],
      ])
    }),
  )
})

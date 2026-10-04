import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { CheckpointLinks } from "../../src/checkpoint/links"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Ripgrep.node])))

const first = (file: string, content: string) => CheckpointLinks.candidates(file, content).map((options) => options[0])

describe("CheckpointLinks.candidates", () => {
  test("reads the local imports of a script and leaves packages out", () => {
    const content = [
      'import { total } from "./cart.js"',
      "import React from 'react'",
      'export { receipt } from "../shared/receipt"',
      'const tax = require("./tax")',
      'const lazy = await import("./lazy")',
      'import "./styles.css"',
    ].join("\n")

    expect(first("src/checkout.js", content)).toEqual([
      "src/cart.js",
      "shared/receipt",
      "src/tax",
      "src/lazy",
      "src/styles.css",
    ])
  })

  test("tries the usual file extensions and index files for an import without one", () => {
    const [options] = CheckpointLinks.candidates("src/app.ts", 'import { greet } from "./greet"')

    expect(options).toContain("src/greet.ts")
    expect(options).toContain("src/greet.js")
    expect(options).toContain("src/greet/index.ts")
  })

  test("finds the TypeScript file behind a .js import", () => {
    const [options] = CheckpointLinks.candidates("src/app.ts", 'import { greet } from "./greet.js"')

    expect(options).toContain("src/greet.ts")
  })

  test("reads Python imports, relative and absolute", () => {
    const content = ["from .cart import total", "from ..shared import tools", "import shop.tax", "import os"].join("\n")

    const options = CheckpointLinks.candidates("shop/checkout.py", content)

    expect(options[0]).toContain("shop/cart.py")
    expect(options[1]).toContain("shared/tools.py")
    expect(options[2]).toContain("shop/tax.py")
    expect(options[3]).toContain("os.py")
  })

  test("reads the scripts, styles, and pages an HTML file links to", () => {
    const content = [
      '<link rel="stylesheet" href="styles.css">',
      '<script src="./js/app.js?v=2"></script>',
      '<a href="about.html#team">About</a>',
      '<a href="https://example.com">Out</a>',
      '<a href="#top">Top</a>',
    ].join("\n")

    expect(first("site/index.html", content)).toEqual(["site/styles.css", "site/js/app.js", "site/about.html"])
  })

  test("reads CSS imports", () => {
    expect(first("styles/main.css", '@import "base.css";\n@import url(./theme.css);')).toEqual([
      "styles/base.css",
      "styles/theme.css",
    ])
  })

  test("ignores imports that point outside the project and files it cannot read", () => {
    expect(CheckpointLinks.candidates("app.js", 'import x from "../outside"')).toEqual([])
    expect(CheckpointLinks.candidates("notes.txt", 'import x from "./y"')).toEqual([])
  })
})

describe("CheckpointLinks.affected", () => {
  it.instance("finds the unchanged files that import a changed file, and where they use what changed", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const ripgrep = yield* Ripgrep.Service
      const files = {
        "src/cart.js": "export function total(items) {\n  return items.length * 2\n}\n",
        "src/checkout.js": 'import { total } from "./cart.js"\n\nexport const pay = (items) => total(items)\n',
        "src/receipt.js": 'import { format } from "./cart"\n',
        "src/cartoon.js": 'import { draw } from "./cartoon-lib.js"\n',
        "index.html": '<script src="src/cart.js"></script>\n',
      }
      yield* Effect.forEach(Object.entries(files), ([file, content]) =>
        Effect.promise(() => Bun.write(path.join(instance.directory, file), content)),
      )

      const result = yield* CheckpointLinks.affected(fs, ripgrep, instance.directory, [
        {
          file: "src/cart.js",
          status: "modified",
          symbols: [
            { name: "total", kind: "function", change: "changed", start: 1, end: 3 },
            { name: "oldTotal", kind: "function", change: "removed", start: 5, end: 7 },
          ],
        },
      ])

      expect(result).toEqual([
        {
          file: "index.html",
          uses: ["src/cart.js"],
          names: [],
          lines: [{ line: 1, text: '<script src="src/cart.js"></script>' }],
        },
        {
          file: "src/checkout.js",
          uses: ["src/cart.js"],
          names: ["total"],
          lines: [
            { line: 1, text: 'import { total } from "./cart.js"' },
            { line: 3, text: "export const pay = (items) => total(items)" },
          ],
        },
        {
          file: "src/receipt.js",
          uses: ["src/cart.js"],
          names: [],
          lines: [{ line: 1, text: 'import { format } from "./cart"' }],
        },
      ])
    }),
  )

  it.instance("looks for nothing when the checkpoint only added files", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const ripgrep = yield* Ripgrep.Service

      expect(
        yield* CheckpointLinks.affected(fs, ripgrep, instance.directory, [{ file: "new.js", status: "added" }]),
      ).toEqual([])
    }),
  )
})

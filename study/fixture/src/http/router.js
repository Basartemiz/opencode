// A tiny router: match method + path pattern like "/books/:id", parse JSON bodies, turn errors into responses.

import { toResponse } from "../utils/errors.js"

export function createRouter() {
  const routes = []

  function add(method, pattern, handler) {
    const keys = []
    const regex = new RegExp(
      "^" +
        pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
          keys.push(key)
          return "([^/]+)"
        }) +
        "/?$",
    )
    routes.push({ method, regex, keys, handler })
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost")
    const route = routes.find((r) => r.method === req.method && r.regex.test(url.pathname))
    if (!route) return send(res, 404, { error: "not_found", message: "no such route" })
    const match = url.pathname.match(route.regex)
    const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]))
    try {
      const body = await readJson(req)
      const result = await route.handler({ params, query: Object.fromEntries(url.searchParams), body })
      send(res, result?.status ?? 200, result?.body ?? result)
    } catch (error) {
      const { status, body } = toResponse(error)
      if (status === 500) console.error(error)
      send(res, status, body)
    }
  }

  return { get: (p, h) => add("GET", p, h), post: (p, h) => add("POST", p, h), delete: (p, h) => add("DELETE", p, h), handle }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.method === "GET" || req.method === "DELETE") return resolve({})
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }))
      }
    })
    req.on("error", reject)
  })
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

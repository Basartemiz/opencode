import http from "node:http"
import { createRouter } from "./router.js"
import { bookRoutes } from "./routes/books.js"
import { memberRoutes } from "./routes/members.js"
import { loanRoutes } from "./routes/loans.js"
import { sendReminders } from "../services/loans.js"
import { flush } from "../services/notifications.js"

export function createServer() {
  const router = createRouter()
  bookRoutes(router)
  memberRoutes(router)
  loanRoutes(router)
  router.get("/health", () => ({ ok: true }))
  return http.createServer((req, res) => router.handle(req, res))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000)
  createServer().listen(port, () => console.log(`shelf listening on http://localhost:${port}`))
  setInterval(flush, 60 * 1000)
  setInterval(sendReminders, 24 * 60 * 60 * 1000)
}

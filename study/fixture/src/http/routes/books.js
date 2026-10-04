import { addBook, getBook, retireBook, search, availableCopies } from "../../services/catalog.js"
import { publicBook } from "../../models/book.js"
import { optionalInt } from "../../utils/validate.js"

export function bookRoutes(router) {
  router.get("/books", ({ query }) =>
    search({
      q: query.q,
      genre: query.genre,
      available: query.available === undefined ? undefined : query.available === "true",
      page: optionalInt(query.page, "page", { min: 1 }) ?? 1,
    }),
  )

  router.get("/books/:id", ({ params }) => {
    const book = getBook(params.id)
    return publicBook(book, { available: availableCopies(book.id) > 0 })
  })

  router.post("/books", ({ body }) => ({ status: 201, body: publicBook(addBook(body)) }))

  router.delete("/books/:id", ({ params }) => {
    retireBook(params.id)
    return { status: 204, body: null }
  })
}

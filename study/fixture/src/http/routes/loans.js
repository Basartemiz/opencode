import { borrow, giveBack, renew, overdue, getLoan } from "../../services/loans.js"
import { publicLoan } from "../../models/loan.js"
import { requireId } from "../../utils/validate.js"

export function loanRoutes(router) {
  router.post("/loans", ({ body }) => {
    const loan = borrow({ bookId: requireId(body.bookId, "bookId"), memberId: requireId(body.memberId, "memberId") })
    return { status: 201, body: publicLoan(loan) }
  })

  router.get("/loans/overdue", () => overdue().map((loan) => ({ ...publicLoan(loan), daysLate: loan.daysLate })))

  router.get("/loans/:id", ({ params }) => publicLoan(getLoan(params.id)))

  router.post("/loans/:id/return", ({ params }) => publicLoan(giveBack({ loanId: params.id })))

  router.post("/loans/:id/renew", ({ params }) => publicLoan(renew({ loanId: params.id })))
}

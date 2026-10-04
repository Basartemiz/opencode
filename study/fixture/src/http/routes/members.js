import { addMember, getMember, listMembers, pay } from "../../services/members.js"
import { activeLoans } from "../../services/loans.js"
import { publicMember } from "../../models/member.js"
import { publicLoan } from "../../models/loan.js"
import { AppError } from "../../utils/errors.js"

export function memberRoutes(router) {
  router.get("/members", () => listMembers().map(publicMember))

  router.get("/members/:id", ({ params }) => {
    const member = getMember(params.id)
    return { ...publicMember(member), loans: activeLoans(member.id).map(publicLoan) }
  })

  router.post("/members", ({ body }) => ({ status: 201, body: publicMember(addMember(body)) }))

  router.post("/members/:id/payments", ({ params, body }) => {
    const amount = Number(body.amount)
    if (!(amount > 0)) throw new AppError("amount must be a positive number")
    return publicMember(pay(params.id, amount))
  })
}

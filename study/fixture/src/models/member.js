import { requireString, requireEmail } from "../utils/validate.js"
import { iso, now } from "../utils/dates.js"

export function newMember(input, id) {
  return {
    id,
    name: requireString(input.name, "name", { max: 80 }),
    email: requireEmail(input.email),
    joined: iso(now()),
    balance: 0,
    active: true,
  }
}

export function publicMember(member) {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    joined: member.joined,
    balance: Math.round(member.balance * 100) / 100,
  }
}

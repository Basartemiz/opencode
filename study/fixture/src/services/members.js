// Members: sign-up, lookup and balances.

import * as store from "../db/store.js"
import { newMember } from "../models/member.js"
import { ConflictError, NotFoundError } from "../utils/errors.js"
import { BLOCKING_BALANCE } from "../config.js"

export function getMember(id) {
  const member = store.get("members", id)
  if (!member || !member.active) throw new NotFoundError("member", id)
  return member
}

export function addMember(input) {
  const member = newMember(input, store.nextId("member"))
  if (store.where("members", (m) => m.email === member.email).length > 0) {
    throw new ConflictError(`a member with email ${member.email} already exists`)
  }
  return store.insert("members", member)
}

export function listMembers() {
  return store.where("members", (member) => member.active)
}

export function charge(memberId, amount) {
  const member = getMember(memberId)
  return store.update("members", memberId, { balance: member.balance + amount })
}

export function pay(memberId, amount) {
  const member = getMember(memberId)
  const paid = Math.min(amount, member.balance)
  store.insert("payments", {
    id: store.nextId("pay"),
    memberId,
    amount: paid,
    at: new Date().toISOString(),
  })
  return store.update("members", memberId, { balance: member.balance - paid })
}

export function isBlocked(member) {
  return member.balance > BLOCKING_BALANCE
}

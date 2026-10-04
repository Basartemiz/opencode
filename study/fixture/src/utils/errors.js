// Errors that carry an HTTP status, so routes can turn them into responses.

export class AppError extends Error {
  constructor(message, status = 400, code = "bad_request") {
    super(message)
    this.name = "AppError"
    this.status = status
    this.code = code
  }
}

export class NotFoundError extends AppError {
  constructor(what, id) {
    super(`${what} ${id} not found`, 404, "not_found")
  }
}

export class ConflictError extends AppError {
  constructor(message) {
    super(message, 409, "conflict")
  }
}

export class ForbiddenError extends AppError {
  constructor(message) {
    super(message, 403, "forbidden")
  }
}

export function toResponse(error) {
  if (error instanceof AppError) {
    return { status: error.status, body: { error: error.code, message: error.message } }
  }
  return { status: 500, body: { error: "internal", message: "Something went wrong" } }
}

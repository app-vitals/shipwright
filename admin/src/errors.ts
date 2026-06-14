/**
 * agent/src/errors.ts
 * Typed HTTP error classes for use across agent service handlers.
 * Handlers throw these; error middleware maps them to HTTP responses.
 */

// ─── Base class ───────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ─── HTTP error subclasses ────────────────────────────────────────────────────

export class NotFoundError extends ApiError {
  constructor(message = "Not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends ApiError {
  constructor(message = "Conflict") {
    super(409, message);
    this.name = "ConflictError";
  }
}

export class BadRequestError extends ApiError {
  constructor(message = "Bad request") {
    super(400, message);
    this.name = "BadRequestError";
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class UnprocessableEntityError extends ApiError {
  constructor(message = "Unprocessable entity") {
    super(422, message);
    this.name = "UnprocessableEntityError";
  }
}

export class BadGatewayError extends ApiError {
  constructor(message = "Bad gateway") {
    super(502, message);
    this.name = "BadGatewayError";
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

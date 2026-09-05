/**
 * task-store/src/errors.ts
 * Typed HTTP error classes for the task-store service.
 * Handlers throw these; the app's error handler maps them to HTTP responses.
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

  /**
   * Alias for `statusCode` so `@sentry/hono`'s `defaultShouldHandleError`
   * (which reads `error.status`, not `error.statusCode`) correctly recognizes
   * already-handled 3xx/4xx responses and skips its own independent capture.
   */
  get status(): number {
    return this.statusCode;
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

export class UnauthorizedError extends ApiError {
  constructor(message = "Unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class PayloadTooLargeError extends ApiError {
  constructor(message = "Payload too large") {
    super(413, message);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * metrics/src/lib/errors.ts
 * Typed HTTP error classes for use across all service handlers.
 */

import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import type { Context } from "hono";
import type { AuthEnv } from "./api-auth.ts";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

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

/**
 * Shared onError factory for all metrics Hono apps. `sentryClient` is optional
 * and undefined means Sentry is not initialized (SENTRY_DSN unset) — the
 * capture calls are simply skipped. Production wiring in server.ts passes the
 * real `Sentry` from `@sentry/bun` only when SENTRY_DSN is set.
 */
export function makeOnError(
  servicePrefix: string,
  sentryClient?: ErrorCapturingClient,
) {
  return (err: Error, c: Context<AuthEnv>) => {
    if (err.message.includes("Malformed JSON")) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (err instanceof ApiError) {
      if (err.statusCode >= 500) {
        console.error(`[${servicePrefix}] error:`, err);
        sentryClient?.captureException(err);
      }
      return c.json(
        { error: err.message },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502,
      );
    }
    console.error(`[${servicePrefix}] unhandled error:`, err);
    sentryClient?.captureException(err);
    return c.json({ error: err.message }, 500);
  };
}

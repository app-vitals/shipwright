/**
 * task-store/src/errors.unit.test.ts
 *
 * Locks in the `status` getter alias on `ApiError` (obs-sentry-status-mismatch).
 *
 * `@sentry/hono`'s `sentry()` middleware (mounted in app.ts whenever SENTRY_DSN
 * is set) independently captures any error left on `context.error` after the
 * route's own `onError` has already run, gated only by `defaultShouldHandleError`:
 *
 *   const status = error.status;
 *   return !(typeof status === "number" && status >= 300 && status < 500);
 *
 * `ApiError` exposed its HTTP status only as `statusCode`, so `error.status`
 * was always `undefined` — `defaultShouldHandleError` always returned `true`,
 * and every ApiError (including ones app.ts's own onError deliberately does
 * NOT report — see app.sentry.smoke.test.ts) got captured and alerted anyway.
 *
 * This test asserts `status === statusCode` for the base class and
 * representative subclasses so that contract can't silently regress.
 */

import { describe, expect, it } from "bun:test";
import {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./errors.ts";

describe("ApiError.status alias (Sentry defaultShouldHandleError contract)", () => {
  it("exposes status equal to statusCode on the base class", () => {
    const err = new ApiError(418, "I'm a teapot");
    expect(err.status).toBe(err.statusCode);
    expect(err.status).toBe(418);
  });

  it.each([
    ["NotFoundError", new NotFoundError(), 404],
    ["ConflictError", new ConflictError(), 409],
    ["BadRequestError", new BadRequestError(), 400],
    ["ForbiddenError", new ForbiddenError(), 403],
  ] as const)("exposes status equal to statusCode on %s", (_name, err, expectedStatus) => {
    expect(err.status).toBe(err.statusCode);
    expect(err.status).toBe(expectedStatus);
  });
});

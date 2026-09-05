/**
 * lib/errors.test.ts
 * Unit tests for typed HTTP error classes and makeOnError factory.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { callerLabel } from "@shipwright/lib/request-context";
import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import {
  ApiError,
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
  makeOnError,
} from "./errors.ts";

describe("ApiError", () => {
  it("sets statusCode and message", () => {
    const err = new ApiError(422, "Unprocessable");
    expect(err.statusCode).toBe(422);
    expect(err.message).toBe("Unprocessable");
    expect(err.name).toBe("ApiError");
  });

  it("is instanceof Error", () => {
    expect(new ApiError(500, "x") instanceof Error).toBe(true);
  });
});

describe("NotFoundError", () => {
  it("has statusCode 404", () => {
    expect(new NotFoundError().statusCode).toBe(404);
  });

  it("uses default message", () => {
    expect(new NotFoundError().message).toBe("Not found");
  });

  it("accepts custom message", () => {
    expect(new NotFoundError("User not found").message).toBe("User not found");
  });

  it("is instanceof ApiError", () => {
    expect(new NotFoundError() instanceof ApiError).toBe(true);
  });
});

describe("ConflictError", () => {
  it("has statusCode 409", () => {
    expect(new ConflictError().statusCode).toBe(409);
  });

  it("is instanceof ApiError", () => {
    expect(new ConflictError() instanceof ApiError).toBe(true);
  });
});

describe("BadRequestError", () => {
  it("has statusCode 400", () => {
    expect(new BadRequestError().statusCode).toBe(400);
  });

  it("is instanceof ApiError", () => {
    expect(new BadRequestError() instanceof ApiError).toBe(true);
  });
});

describe("ForbiddenError", () => {
  it("has statusCode 403", () => {
    expect(new ForbiddenError().statusCode).toBe(403);
  });

  it("is instanceof ApiError", () => {
    expect(new ForbiddenError() instanceof ApiError).toBe(true);
  });
});

describe("BadGatewayError", () => {
  it("has statusCode 502", () => {
    expect(new BadGatewayError().statusCode).toBe(502);
  });

  it("is instanceof ApiError", () => {
    expect(new BadGatewayError() instanceof ApiError).toBe(true);
  });
});

/**
 * Locks in the `status` getter alias on `ApiError` (obs-sentry-status-mismatch).
 *
 * `@sentry/hono`'s `sentry()` middleware (mounted in api.ts whenever SENTRY_DSN
 * is set) independently captures any error left on `context.error` after the
 * route's own `onError` has already run, gated only by `defaultShouldHandleError`:
 *
 *   const status = error.status;
 *   return !(typeof status === "number" && status >= 300 && status < 500);
 *
 * `ApiError` exposed its HTTP status only as `statusCode`, so `error.status`
 * was always `undefined` — `defaultShouldHandleError` always returned `true`,
 * and every ApiError (including ones `makeOnError` deliberately does NOT report
 * because of its 5xx-only gate) got captured and alerted anyway.
 *
 * This test asserts `status === statusCode` for the base class and
 * representative subclasses so that contract can't silently regress.
 */
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
    ["UnprocessableEntityError", new UnprocessableEntityError(), 422],
    ["BadGatewayError", new BadGatewayError(), 502],
  ] as const)(
    "exposes status equal to statusCode on %s",
    (_name, err, expectedStatus) => {
      expect(err.status).toBe(err.statusCode);
      expect(err.status).toBe(expectedStatus);
    },
  );
});

describe("makeOnError", () => {
  function makeCtx(opts?: { caller?: { name: string; scope: string } }) {
    const calls: Array<{ body: unknown; status: number }> = [];
    const ctx = {
      json: (body: unknown, status: number) => {
        calls.push({ body, status });
        return { body, status };
      },
      get: (key: string) => (key === "caller" ? opts?.caller : undefined),
    };
    return { ctx, calls };
  }

  /** Fake ErrorCapturingClient — records calls without touching real Sentry. */
  function makeFakeSentryClient() {
    const captured: unknown[] = [];
    const client: ErrorCapturingClient = {
      captureException: (err: unknown) => {
        captured.push(err);
      },
    };
    return { client, captured };
  }

  it("returns 400 for Malformed JSON", () => {
    const handler = makeOnError("test");
    const { ctx, calls } = makeCtx();
    handler(
      new Error("Malformed JSON in body"),
      ctx as Parameters<ReturnType<typeof makeOnError>>[1],
    );
    expect(calls[0]?.status).toBe(400);
    expect(calls[0]?.body).toEqual({ error: "Invalid JSON body" });
  });

  it("returns ApiError statusCode for typed errors", () => {
    const handler = makeOnError("test");
    const { ctx, calls } = makeCtx();
    handler(
      new NotFoundError("Widget not found"),
      ctx as Parameters<ReturnType<typeof makeOnError>>[1],
    );
    expect(calls[0]?.status).toBe(404);
    expect(calls[0]?.body).toEqual({ error: "Widget not found" });
  });

  it("returns 409 for ConflictError", () => {
    const handler = makeOnError("test");
    const { ctx, calls } = makeCtx();
    handler(
      new ConflictError("Already exists"),
      ctx as Parameters<ReturnType<typeof makeOnError>>[1],
    );
    expect(calls[0]?.status).toBe(409);
  });

  it("returns 502 for BadGatewayError", () => {
    const handler = makeOnError("test");
    const { ctx, calls } = makeCtx();
    handler(
      new BadGatewayError("Upstream failed"),
      ctx as Parameters<ReturnType<typeof makeOnError>>[1],
    );
    expect(calls[0]?.status).toBe(502);
  });

  it("returns 500 for unknown errors", () => {
    const handler = makeOnError("test");
    const { ctx, calls } = makeCtx();
    handler(
      new Error("Something unexpected"),
      ctx as Parameters<ReturnType<typeof makeOnError>>[1],
    );
    expect(calls[0]?.status).toBe(500);
    expect(calls[0]?.body).toEqual({ error: "Something unexpected" });
  });

  describe("Sentry capture", () => {
    it("calls captureException for a 5xx ApiError when a sentryClient is injected", () => {
      const { client, captured } = makeFakeSentryClient();
      const handler = makeOnError("test", client);
      const { ctx } = makeCtx();
      const err = new BadGatewayError("Upstream failed");
      handler(err, ctx as Parameters<ReturnType<typeof makeOnError>>[1]);
      expect(captured).toEqual([err]);
    });

    it("calls captureException for unhandled errors when a sentryClient is injected", () => {
      const { client, captured } = makeFakeSentryClient();
      const handler = makeOnError("test", client);
      const { ctx } = makeCtx();
      const err = new Error("Something unexpected");
      handler(err, ctx as Parameters<ReturnType<typeof makeOnError>>[1]);
      expect(captured).toEqual([err]);
    });

    it("does not call captureException for a non-5xx ApiError (e.g. 404)", () => {
      const { client, captured } = makeFakeSentryClient();
      const handler = makeOnError("test", client);
      const { ctx } = makeCtx();
      handler(
        new NotFoundError("Widget not found"),
        ctx as Parameters<ReturnType<typeof makeOnError>>[1],
      );
      expect(captured).toEqual([]);
    });

    it("does not call captureException for Malformed JSON", () => {
      const { client, captured } = makeFakeSentryClient();
      const handler = makeOnError("test", client);
      const { ctx } = makeCtx();
      handler(
        new Error("Malformed JSON in body"),
        ctx as Parameters<ReturnType<typeof makeOnError>>[1],
      );
      expect(captured).toEqual([]);
    });

    it("does not throw and skips capture when no sentryClient is injected", () => {
      const handler = makeOnError("test");
      const { ctx, calls } = makeCtx();
      const err = new BadGatewayError("Upstream failed");
      expect(() =>
        handler(err, ctx as Parameters<ReturnType<typeof makeOnError>>[1]),
      ).not.toThrow();
      expect(calls[0]?.status).toBe(502);
    });
  });

  describe("caller label logging", () => {
    it("includes the resolved caller label in the unhandled-error log line", () => {
      const consoleErrorSpy = spyOn(console, "error").mockImplementation(
        () => {},
      );
      try {
        const caller = { name: "agent-42", scope: "agent-42" };
        const handler = makeOnError("test");
        const { ctx } = makeCtx({ caller });
        handler(
          new Error("Something unexpected"),
          ctx as Parameters<ReturnType<typeof makeOnError>>[1],
        );
        expect(consoleErrorSpy).toHaveBeenCalled();
        const loggedArgs = consoleErrorSpy.mock.calls.flat().join(" ");
        expect(loggedArgs).toContain(callerLabel(caller));
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });
});

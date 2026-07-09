/**
 * lib/errors.test.ts
 * Unit tests for typed HTTP error classes and makeOnError factory.
 */

import { describe, expect, it } from "bun:test";
import { callerLabel } from "@shipwright/lib/request-context";
import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import {
  ApiError,
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
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

describe("makeOnError", () => {
  function makeCtx(caller?: { name: string; scope: string }) {
    const calls: Array<{ body: unknown; status: number }> = [];
    const ctx = {
      json: (body: unknown, status: number) => {
        calls.push({ body, status });
        return { body, status };
      },
      get: (key: string) => {
        if (key === "caller") return caller;
        return undefined;
      },
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

  describe("caller label in unhandled-error log line", () => {
    it("includes the resolved caller label when a caller is injected via context", () => {
      const originalError = console.error;
      const logCalls: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        logCalls.push(args);
      };
      try {
        const handler = makeOnError("test");
        const caller = { name: "bodhi", scope: "client-xyz" };
        const { ctx } = makeCtx(caller);
        const err = new Error("Something unexpected");
        handler(err, ctx as Parameters<ReturnType<typeof makeOnError>>[1]);
        const logged = logCalls.flat().join(" ");
        expect(logged).toContain(callerLabel(caller));
      } finally {
        console.error = originalError;
      }
    });

    it("logs 'anonymous' when no caller is present on the context", () => {
      const originalError = console.error;
      const logCalls: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        logCalls.push(args);
      };
      try {
        const handler = makeOnError("test");
        const { ctx } = makeCtx();
        const err = new Error("Something unexpected");
        handler(err, ctx as Parameters<ReturnType<typeof makeOnError>>[1]);
        const logged = logCalls.flat().join(" ");
        expect(logged).toContain(callerLabel(undefined));
      } finally {
        console.error = originalError;
      }
    });
  });
});

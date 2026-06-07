/**
 * lib/errors.test.ts
 * Unit tests for typed HTTP error classes and makeOnError factory.
 */

import { describe, expect, it } from "bun:test";
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
  function makeCtx() {
    const calls: Array<{ body: unknown; status: number }> = [];
    const ctx = {
      json: (body: unknown, status: number) => {
        calls.push({ body, status });
        return { body, status };
      },
    };
    return { ctx, calls };
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
});

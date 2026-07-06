/**
 * task-store/src/app.sentry.smoke.test.ts
 *
 * Smoke tests for the onError hook's Sentry wiring (SEN-1.2).
 *
 * Asserts:
 *   - an unhandled (non-ApiError) error triggers sentryClient.captureException
 *     when a fake sentryClient is injected via TaskStoreDeps
 *   - ApiError instances (expected, typed errors mapped to real HTTP status
 *     codes) do NOT trigger captureException
 *   - with no sentryClient dep (undefined — Sentry not initialized), onError
 *     does not throw and behaves exactly as before
 */

import { describe, expect, it } from "bun:test";
import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import { createTaskStoreApp } from "./app.ts";
import { NotFoundError } from "./errors.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

const VALID_TOKEN = "valid-token";

function fakeTokenService(): TokenServiceLike {
  return {
    async create(label?: string) {
      return {
        token: {
          id: "tok-1",
          token: "hash",
          label: label ?? null,
          agentId: null,
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw",
      };
    },
    async validate(raw: string) {
      return raw === VALID_TOKEN ? { id: "tok-1", agentId: null } : null;
    },
    async revoke() {
      return null;
    },
    async list() {
      return [];
    },
    async update() {
      return null;
    },
  };
}

function fakeErrorCapturingClient(): ErrorCapturingClient & {
  capturedErrors: unknown[];
} {
  const capturedErrors: unknown[] = [];
  return {
    captureException: (err: unknown) => {
      capturedErrors.push(err);
    },
    capturedErrors,
  };
}

/** A task service whose single method throws an unhandled, non-ApiError error. */
function throwingTaskService(): TaskServiceLike {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error("boom: unexpected failure");
        };
      },
    },
  ) as TaskServiceLike;
}

/** A task service whose single method throws a typed ApiError (NotFoundError). */
function apiErrorTaskService(): TaskServiceLike {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new NotFoundError("task not found");
        };
      },
    },
  ) as TaskServiceLike;
}

describe("onError — Sentry capture wiring", () => {
  it("calls sentryClient.captureException for an unhandled (non-ApiError) error", async () => {
    const sentryClient = fakeErrorCapturingClient();
    const app = createTaskStoreApp({
      taskService: throwingTaskService(),
      tokenService: fakeTokenService(),
      sentryClient,
    });

    const res = await app.request("/tasks/abc", {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(500);
    expect(sentryClient.capturedErrors.length).toBe(1);
    expect((sentryClient.capturedErrors[0] as Error).message).toBe(
      "boom: unexpected failure",
    );
  });

  it("does NOT call sentryClient.captureException for a typed ApiError", async () => {
    const sentryClient = fakeErrorCapturingClient();
    const app = createTaskStoreApp({
      taskService: apiErrorTaskService(),
      tokenService: fakeTokenService(),
      sentryClient,
    });

    const res = await app.request("/tasks/abc", {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(404);
    expect(sentryClient.capturedErrors.length).toBe(0);
  });

  it("does not throw when sentryClient is undefined (Sentry not initialized)", async () => {
    const app = createTaskStoreApp({
      taskService: throwingTaskService(),
      tokenService: fakeTokenService(),
    });

    const res = await app.request("/tasks/abc", {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(500);
  });
});

/**
 * task-store/src/app.pool-observability.smoke.test.ts
 *
 * Smoke tests for pool observability in onError: a pool-timeout error carries
 * pg_pool context + route/server_name tags; other errors are captured unchanged.
 */

import { describe, expect, it, spyOn } from "bun:test";
import type { PoolLike } from "@shipwright/lib/pool-observability";
import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import { createTaskStoreApp } from "./app.ts";
import type { SessionServiceLike } from "./session-service.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

const TOKEN = "valid-token";

const sessionService = {} as SessionServiceLike;
const tokenService = {
  async validate(raw: string) {
    return raw === TOKEN ? { id: "tok-1", agentId: null } : null;
  },
} as unknown as TokenServiceLike;

function throwing(err: unknown): TaskServiceLike {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw err;
        };
      },
    },
  ) as TaskServiceLike;
}

const pool: PoolLike = {
  totalCount: 10,
  idleCount: 0,
  waitingCount: 4,
  options: { max: 10 },
};

function recordingClient() {
  const captured: unknown[] = [];
  const tags: Record<string, string> = {};
  const contexts: Record<string, unknown> = {};
  const client: ErrorCapturingClient = {
    captureException: (e) => {
      captured.push(e);
    },
    withScope: async (cb) =>
      cb({
        setTag: (k, v) => {
          tags[k] = v;
        },
        setContext: (k, v) => {
          contexts[k] = v;
        },
      }),
  };
  return { client, captured, tags, contexts };
}

async function hit(err: unknown, rec: ReturnType<typeof recordingClient>) {
  const app = createTaskStoreApp({
    taskService: throwing(err),
    tokenService,
    sessionService,
    sentryClient: rec.client,
    pool,
  });
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    return await app.request("/tasks/abc", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  } finally {
    spy.mockRestore();
  }
}

describe("onError — pool observability", () => {
  it("attaches pool stats and route/server_name tags for a simulated P2028", async () => {
    const rec = recordingClient();
    const err = Object.assign(new Error("Unable to start a transaction"), {
      code: "P2028",
    });
    const res = await hit(err, rec);

    expect(res.status).toBe(500);
    expect(rec.captured).toEqual([err]);
    expect(rec.contexts.pg_pool).toMatchObject({
      total: 10,
      idle: 0,
      waiting: 4,
      max: 10,
    });
    expect((rec.contexts.pg_pool as { route: string }).route).toContain(
      "GET /tasks/",
    );
    expect(rec.tags.route).toContain("GET /tasks/");
    expect(rec.tags.server_name).toBeTruthy();
  });

  it("captures other errors without pool context or tags", async () => {
    const rec = recordingClient();
    const err = new Error("boom: unexpected failure");
    await hit(err, rec);

    expect(rec.captured).toEqual([err]);
    expect(rec.contexts).toEqual({});
    expect(rec.tags).toEqual({});
  });
});

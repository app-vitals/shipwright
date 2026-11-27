/**
 * task-store/src/list-cursor.smoke.test.ts
 *
 * HTTP-contract smoke tests (TPG-1.2) for ?cursor / nextCursor on every
 * limit-taking list route except GET /tasks (see tasks.cursor.smoke.test.ts):
 * sessions, PRs, PR events, task events, verification-checks,
 * coverage-snapshots and system-cron triggers. Each route must forward
 * ?cursor to its service and return `nextCursor` (never omitted; null when the
 * service omits it) beside its unchanged array key.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { CoverageSnapshotServiceLike } from "./coverage-snapshot-service.ts";
import type { PullRequestServiceLike } from "./pull-request-service.ts";
import type { RepoCronRunServiceLike } from "./repo-cron-run-service.ts";
import type { SessionServiceLike } from "./session-service.ts";
import type { SystemCronServiceLike } from "./system-cron-service.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";
import type { VerificationCheckServiceLike } from "./verification-check-service.ts";

const ADMIN = { Authorization: "Bearer admin-token" };

function tokenService(): TokenServiceLike {
  return {
    async create() {
      throw new Error("not implemented");
    },
    async validate(raw: string) {
      return raw === "admin-token" ? { id: "tok-1", agentId: null } : null;
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

type Captured = unknown[];

/** A service double whose every method throws except the overrides. */
function stub<T extends object>(overrides: Partial<Record<keyof T, unknown>>) {
  return new Proxy(overrides as T, {
    get(target, prop) {
      if (prop in target)
        return (target as Record<string | symbol, unknown>)[prop];
      return async () => {
        throw new Error(`not implemented: ${String(prop)}`);
      };
    },
  });
}

interface Setup {
  /** Path (relative) and the array key the response must keep. */
  path: string;
  key: string;
  /** Build an app whose list method records its args and returns `cursorOut`. */
  build: (
    calls: Captured,
    cursorOut: string | null | undefined,
  ) => ReturnType<typeof createTaskStoreApp>;
  /** Index into the captured args where the `cursor` was forwarded. */
  readCursor: (calls: Captured) => unknown;
}

function app(deps: Partial<Parameters<typeof createTaskStoreApp>[0]>) {
  return createTaskStoreApp({
    taskService: stub<TaskServiceLike>({}),
    tokenService: tokenService(),
    sessionService: stub<SessionServiceLike>({}),
    ...deps,
  });
}

const SETUPS: Record<string, Setup> = {
  "GET /sessions": {
    path: "/sessions",
    key: "sessions",
    build: (calls, nextCursor) =>
      app({
        sessionService: stub<SessionServiceLike>({
          async list(filters: unknown) {
            calls.push(filters);
            return { sessions: [], total: 0, limit: 50, nextCursor };
          },
        }),
      }),
    readCursor: (calls) => (calls[0] as { cursor?: string }).cursor,
  },
  "GET /prs": {
    path: "/prs",
    key: "prs",
    build: (calls, nextCursor) =>
      app({
        pullRequestService: stub<PullRequestServiceLike>({
          async list(filters: unknown) {
            calls.push(filters);
            return { prs: [], total: 0, limit: 50, nextCursor };
          },
        }),
      }),
    readCursor: (calls) => (calls[0] as { cursor?: string }).cursor,
  },
  "GET /prs/:id/events": {
    path: "/prs/pr-1/events",
    key: "events",
    build: (calls, nextCursor) =>
      app({
        pullRequestService: stub<PullRequestServiceLike>({
          async get(id: string) {
            return { id, repo: "org/repo", accountId: "default" };
          },
          async getEvents(_id: string, opts: unknown) {
            calls.push(opts);
            return { events: [], total: 0, nextCursor };
          },
        }),
      }),
    readCursor: (calls) => (calls[0] as { cursor?: string }).cursor,
  },
  "GET /tasks/:id/events": {
    path: "/tasks/t-1/events",
    key: "events",
    build: (calls, nextCursor) =>
      app({
        taskService: stub<TaskServiceLike>({
          async get(id: string) {
            return {
              id,
              repo: null,
              assignee: null,
              accountId: "default",
              blockedBy: [],
            };
          },
          async getEvents(_id: string, opts: unknown) {
            calls.push(opts);
            return { events: [], total: 0, nextCursor };
          },
        }),
      }),
    readCursor: (calls) => (calls[0] as { cursor?: string }).cursor,
  },
  "GET /verification-checks": {
    path: "/verification-checks?taskId=t-1",
    key: "checks",
    build: (calls, nextCursor) =>
      app({
        verificationCheckService: stub<VerificationCheckServiceLike>({
          async listForTask(_id: string, opts: unknown) {
            calls.push(opts);
            return { checks: [], total: 0, nextCursor };
          },
        }),
      }),
    readCursor: (calls) => (calls[0] as { cursor?: string }).cursor,
  },
  "GET /coverage-snapshots": {
    path: "/coverage-snapshots",
    key: "snapshots",
    build: (calls, nextCursor) =>
      app({
        coverageSnapshotService: stub<CoverageSnapshotServiceLike>({
          async list(opts: unknown) {
            calls.push(opts);
            return { snapshots: [], total: 0, nextCursor };
          },
        }),
      }),
    readCursor: (calls) => (calls[0] as { cursor?: string }).cursor,
  },
  "GET /cron-runs": {
    path: "/cron-runs",
    key: "runs",
    build: (calls, nextCursor) =>
      app({
        repoCronRunService: stub<RepoCronRunServiceLike>({
          async list(opts: unknown) {
            calls.push(opts);
            return { runs: [], total: 0, nextCursor };
          },
        }),
      }),
    readCursor: (calls) => (calls[0] as { cursor?: string }).cursor,
  },
  "GET /system-crons/:id/triggers": {
    path: "/system-crons/c-1/triggers",
    key: "triggers",
    build: (calls, nextCursor) =>
      app({
        systemCronService: stub<SystemCronServiceLike>({
          async recentTriggers(
            _id: string,
            _limit: number,
            _acct: string | null,
            cursor?: string,
          ) {
            calls.push({ cursor });
            return { triggers: [], nextCursor };
          },
        }),
      }),
    readCursor: (calls) => (calls[0] as { cursor?: string }).cursor,
  },
};

function withQuery(path: string, q: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${q}`;
}

describe("cursor / nextCursor on list routes (smoke)", () => {
  for (const [name, s] of Object.entries(SETUPS)) {
    describe(name, () => {
      it("returns the service's nextCursor beside the unchanged array key", async () => {
        const res = await s
          .build([], "abc_-123")
          .request(s.path, { headers: ADMIN });
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(Array.isArray(body[s.key])).toBe(true);
        expect(body.nextCursor).toBe("abc_-123");
      });

      it("coerces a missing nextCursor to null (never omitted)", async () => {
        const res = await s
          .build([], undefined)
          .request(s.path, { headers: ADMIN });
        const body = (await res.json()) as Record<string, unknown>;
        expect("nextCursor" in body).toBe(true);
        expect(body.nextCursor).toBeNull();
      });

      it("forwards ?cursor to the service", async () => {
        const calls: Captured = [];
        const res = await s
          .build(calls, null)
          .request(withQuery(s.path, "cursor=opaque"), { headers: ADMIN });
        expect(res.status).toBe(200);
        expect(s.readCursor(calls)).toBe("opaque");
      });
    });
  }
});

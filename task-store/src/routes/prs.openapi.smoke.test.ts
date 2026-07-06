/**
 * task-store/src/routes/prs.openapi.smoke.test.ts
 *
 * Verifies that prs.ts has been migrated to OpenAPIHono.
 * The key assertion: createPrsRoutes must return an OpenAPIHono instance.
 *
 * All behavioural correctness is covered by prs.smoke.test.ts — this file
 * focuses on the structural migration contract.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "bun:test";
import { NotFoundError } from "../errors.ts";
import type { PullRequest } from "../index.ts";
import type {
  PullRequestListFilters,
  PullRequestListResult,
  PullRequestServiceLike,
} from "../pull-request-service.ts";
import { createPrsRoutes } from "./prs.ts";

// ─── Minimal fake PR service ──────────────────────────────────────────────────

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "pr-1",
    repo: "org/repo",
    prNumber: 42,
    taskId: null,
    staged: false,
    state: "open",
    reviewState: "pending",
    commitSha: null,
    patchCycles: 0,
    reviewCycles: 0,
    agentId: null,
    reviewedAt: null,
    patchedAt: null,
    mergedAt: null,
    claimedBy: null,
    claimedAt: null,
    heartbeatAt: null,
    phase: null,
    readyForReviewAt: null,
    readyForPatchAt: null,
    readyForDeployAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PullRequest;
}

function fakePrService(
  opts: {
    store?: Map<string, PullRequest>;
    claimResult?: { status: 200 | 201; record: PullRequest } | Error;
  } = {},
): PullRequestServiceLike {
  const store = opts.store ?? new Map<string, PullRequest>();

  return {
    async list(filters?: PullRequestListFilters): Promise<PullRequestListResult> {
      const prs = Array.from(store.values());
      return { prs, total: prs.length, limit: 50, offset: 0 };
    },

    async get(id: string): Promise<PullRequest | null> {
      return store.get(id) ?? null;
    },

    async update(id: string, data: Partial<PullRequest>): Promise<PullRequest> {
      const existing = store.get(id);
      if (!existing) throw new NotFoundError("pr not found");
      const updated = { ...existing, ...data, updatedAt: new Date() } as PullRequest;
      store.set(id, updated);
      return updated;
    },

    async claim(
      repo: string,
      prNumber: number,
      commitSha: string,
      claimedBy: string,
      taskId?: string,
    ): Promise<{ status: 200 | 201; record: PullRequest }> {
      if (opts.claimResult !== undefined) {
        if (opts.claimResult instanceof Error) throw opts.claimResult;
        return opts.claimResult;
      }
      const record = makePr({ id: `pr-${repo}-${prNumber}`, repo, prNumber, commitSha, claimedBy });
      store.set(record.id, record);
      return { status: 201, record };
    },

    async heartbeat(id: string): Promise<PullRequest> {
      const pr = store.get(id) ?? makePr({ id });
      const updated = { ...pr, heartbeatAt: new Date().toISOString(), updatedAt: new Date() } as PullRequest;
      store.set(id, updated);
      return updated;
    },

    async complete(id: string): Promise<PullRequest> {
      const existing = store.get(id);
      if (!existing) throw new NotFoundError("pr not found");
      const updated = { ...existing, reviewState: "posted" as const, reviewedAt: new Date().toISOString(), updatedAt: new Date() } as PullRequest;
      store.set(id, updated);
      return updated;
    },

    async patch(id: string): Promise<PullRequest> {
      const existing = store.get(id);
      if (!existing) throw new NotFoundError("pr not found");
      const updated = { ...existing, patchCycles: existing.patchCycles + 1, reviewState: "pending" as const, updatedAt: new Date() } as PullRequest;
      store.set(id, updated);
      return updated;
    },

    async release(id: string): Promise<PullRequest> {
      const existing = store.get(id);
      if (!existing) throw new NotFoundError("pr not found");
      const updated = { ...existing, reviewState: "pending" as const, claimedBy: null, claimedAt: null, heartbeatAt: null, updatedAt: new Date() } as PullRequest;
      store.set(id, updated);
      return updated;
    },

    async claimNext(
      _agentId: string,
      _maxConcurrent: number,
      _repos?: string[],
    ): Promise<{ pr: PullRequest; phase: "review" | "patch" | "deploy" } | null> {
      return null;
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createPrsRoutes — OpenAPIHono migration (TSM-1.3)", () => {
  it("returns an OpenAPIHono instance (not plain Hono)", () => {
    const app = createPrsRoutes(fakePrService());
    expect(app).toBeInstanceOf(OpenAPIHono);
  });

  it("GET / responds to list requests (route registered correctly)", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1" }));
    const app = createPrsRoutes(fakePrService({ store }));
    // The sub-app is mounted at /prs by app.ts; direct call uses '/'
    const res = await app.request("/");
    // Without auth middleware the status could be 200 (routes/handlers work)
    expect([200, 401]).toContain(res.status);
  });

  it("GET /:id responds to single-record requests", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1" }));
    const app = createPrsRoutes(fakePrService({ store }));
    const res = await app.request("/pr-1");
    expect([200, 401]).toContain(res.status);
  });

  it("POST /claim route is registered", async () => {
    const app = createPrsRoutes(fakePrService());
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 1, commitSha: "abc", claimedBy: "agent-1" }),
    });
    // Not 404 — route exists
    expect(res.status).not.toBe(404);
  });

  it("POST /claim-next route is registered", async () => {
    const app = createPrsRoutes(fakePrService());
    const res = await app.request("/claim-next", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });
    expect(res.status).not.toBe(404);
  });

  it("PATCH /:id route is registered", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1" }));
    const app = createPrsRoutes(fakePrService({ store }));
    const res = await app.request("/pr-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staged: true }),
    });
    expect(res.status).not.toBe(404);
  });

  it("POST /:id/heartbeat route is registered", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1" }));
    const app = createPrsRoutes(fakePrService({ store }));
    const res = await app.request("/pr-1/heartbeat", { method: "POST" });
    expect(res.status).not.toBe(404);
  });

  it("POST /:id/complete route is registered", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1" }));
    const app = createPrsRoutes(fakePrService({ store }));
    const res = await app.request("/pr-1/complete", { method: "POST" });
    expect(res.status).not.toBe(404);
  });

  it("POST /:id/patch route is registered", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1" }));
    const app = createPrsRoutes(fakePrService({ store }));
    const res = await app.request("/pr-1/patch", { method: "POST" });
    expect(res.status).not.toBe(404);
  });

  it("POST /:id/release route is registered", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1" }));
    const app = createPrsRoutes(fakePrService({ store }));
    const res = await app.request("/pr-1/release", { method: "POST" });
    expect(res.status).not.toBe(404);
  });
});

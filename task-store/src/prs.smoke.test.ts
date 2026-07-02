/**
 * task-store/src/prs.smoke.test.ts
 *
 * Smoke tests for the /prs routes via in-process app.request().
 * No real DB — PullRequestService is injected as an in-memory fake.
 *
 * Covers:
 *   - POST /prs/claim → 201 new record
 *   - POST /prs/claim → 409 same commitSha, reviewState !== pending
 *   - POST /prs/claim → 200 reset when commitSha differs (new review cycle)
 *   - POST /prs/:id/complete → reviewState=posted, reviewedAt set
 *   - POST /prs/:id/patch → patchCycles incremented, reviewState=pending
 *   - Agent token scope rejection → 400 on claim with out-of-scope repo
 *   - GET /prs?taskId=X and GET /prs?reviewState=posted filters
 *   - PATCH /prs/:id → update fields
 *   - GET /prs/:id → 404 when missing
 *   - POST /prs/:id/heartbeat → updates heartbeatAt
 *   - POST /prs/:id/release → clears claim, reviewState=pending
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import type { PullRequest } from "./index.ts";
import type {
  PullRequestListFilters,
  PullRequestListResult,
  PullRequestServiceLike,
} from "./pull-request-service.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_TOKEN = "valid-token";
const AGENT_TOKEN = "agent-token";
const ADMIN_REPO = "app-vitals/shipwright";
const SCOPED_REPO = "acme-inc/backend-api";

// ─── Fake builders ────────────────────────────────────────────────────────────

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "pr-1",
    repo: ADMIN_REPO,
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

/** Admin token service (agentId: null). */
function fakeAdminTokenService(): TokenServiceLike {
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

/** Agent token service — agentId: "agent-1", scoped repos provided via scopeResolver. */
function fakeAgentTokenService(): TokenServiceLike {
  return {
    async create(label?: string) {
      return {
        token: {
          id: "tok-2",
          token: "hash",
          label: label ?? null,
          agentId: "agent-1",
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw",
      };
    },
    async validate(raw: string) {
      return raw === AGENT_TOKEN ? { id: "tok-2", agentId: "agent-1" } : null;
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

function makeScopeResolver(
  repos: string[],
): (agentId: string) => Promise<string[]> {
  return async (agentId: string) => (agentId === "agent-1" ? repos : []);
}

/** Minimal in-memory PullRequestServiceLike fake. */
function fakePrService(
  opts: {
    store?: Map<string, PullRequest>;
    claimResult?: { status: 200 | 201; record: PullRequest } | Error;
    getResult?: PullRequest | null;
    listResult?: PullRequest[];
  } = {},
): PullRequestServiceLike {
  const store = opts.store ?? new Map<string, PullRequest>();

  return {
    async list(
      filters?: PullRequestListFilters,
    ): Promise<PullRequestListResult> {
      let prs = Array.from(store.values());
      if (opts.listResult !== undefined) prs = opts.listResult;
      if (filters?.taskId) prs = prs.filter((p) => p.taskId === filters.taskId);
      if (filters?.reviewState)
        prs = prs.filter((p) => p.reviewState === filters.reviewState);
      if (filters?.repo) prs = prs.filter((p) => p.repo === filters.repo);
      if (filters?.staged !== undefined)
        prs = prs.filter((p) => p.staged === filters.staged);
      return {
        prs,
        total: prs.length,
        limit: filters?.limit ?? 50,
        offset: filters?.offset ?? 0,
      };
    },

    async get(id: string): Promise<PullRequest | null> {
      if ("getResult" in opts) return opts.getResult ?? null;
      return store.get(id) ?? null;
    },

    async update(id: string, data: Partial<PullRequest>): Promise<PullRequest> {
      const existing = store.get(id);
      if (!existing) throw new NotFoundError("pr not found");
      const updated = {
        ...existing,
        ...data,
        updatedAt: new Date(),
      } as PullRequest;
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
      // Simple fake: create new
      const record = makePr({
        id: `pr-${repo}-${prNumber}`,
        repo,
        prNumber,
        commitSha,
        claimedBy,
        taskId: taskId ?? null,
        reviewState: "in_progress",
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      });
      store.set(record.id, record);
      return { status: 201, record };
    },

    async heartbeat(id: string): Promise<PullRequest> {
      const existing = store.get(id) ?? makePr({ id });
      const updated = {
        ...existing,
        heartbeatAt: new Date().toISOString(),
        updatedAt: new Date(),
      } as PullRequest;
      store.set(id, updated);
      return updated;
    },

    async complete(id: string): Promise<PullRequest> {
      const existing = store.get(id);
      if (!existing) throw new NotFoundError("pr not found");
      const updated = {
        ...existing,
        reviewCycles: (existing.reviewCycles ?? 0) + 1,
        reviewState: "posted" as const,
        reviewedAt: new Date().toISOString(),
        updatedAt: new Date(),
      } as PullRequest;
      store.set(id, updated);
      return updated;
    },

    async patch(id: string): Promise<PullRequest> {
      const existing = store.get(id);
      if (!existing) throw new NotFoundError("pr not found");
      const updated = {
        ...existing,
        patchCycles: existing.patchCycles + 1,
        patchedAt: new Date().toISOString(),
        reviewState: "pending" as const,
        updatedAt: new Date(),
      } as PullRequest;
      store.set(id, updated);
      return updated;
    },

    async release(id: string): Promise<PullRequest> {
      const existing = store.get(id);
      if (!existing) throw new NotFoundError("pr not found");
      const updated = {
        ...existing,
        reviewState: "pending" as const,
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        updatedAt: new Date(),
      } as PullRequest;
      store.set(id, updated);
      return updated;
    },
  };
}

/** Minimal TaskServiceLike fake for app construction. */
function fakeTaskService(): TaskServiceLike {
  return {
    async list() {
      return { tasks: [], total: 0, limit: 50, offset: 0 };
    },
    async listReady() {
      return [];
    },
    async listBlocked() {
      return [];
    },
    async get() {
      return null;
    },
    async create(data) {
      return data as never;
    },
    async update(_id, data) {
      return data as never;
    },
    async remove() {
      return;
    },
    async claim(_id, _claimedBy) {
      return {} as never;
    },
    async heartbeat(_id) {
      return {} as never;
    },
    async complete(_id) {
      return {} as never;
    },
    async fail(_id) {
      return {} as never;
    },
    async release(_id) {
      return {} as never;
    },
    async bulk() {
      return { inserted: 0, updated: 0 };
    },
    async distinct() {
      return { sessions: [], repos: [] };
    },
  };
}

function makeApp(
  deps: {
    prService?: PullRequestServiceLike;
    tokenService?: TokenServiceLike;
    scopeResolver?: (agentId: string) => Promise<string[]>;
  } = {},
) {
  return createTaskStoreApp({
    taskService: fakeTaskService(),
    tokenService: deps.tokenService ?? fakeAdminTokenService(),
    pullRequestService: deps.prService ?? fakePrService(),
    scopeResolver: deps.scopeResolver,
  });
}

function adminAuth(): Record<string, string> {
  return { Authorization: `Bearer ${VALID_TOKEN}` };
}

function agentAuth(): Record<string, string> {
  return { Authorization: `Bearer ${AGENT_TOKEN}` };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/prs routes (smoke)", () => {
  // ─── POST /prs/claim ──────────────────────────────────────────────────────

  it("POST /prs/claim creates new record (201) when no record exists", async () => {
    const app = makeApp();
    const res = await app.request("/prs/claim", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        repo: ADMIN_REPO,
        prNumber: 42,
        commitSha: "abc123",
        claimedBy: "agent-1",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PullRequest;
    expect(body.repo).toBe(ADMIN_REPO);
    expect(body.prNumber).toBe(42);
    expect(body.reviewState).toBe("in_progress");
  });

  it("POST /prs/claim returns 409 when same commitSha and reviewState !== pending", async () => {
    const app = makeApp({
      prService: fakePrService({
        claimResult: new ConflictError("already claimed with same commitSha"),
      }),
    });
    const res = await app.request("/prs/claim", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        repo: ADMIN_REPO,
        prNumber: 42,
        commitSha: "abc123",
        claimedBy: "agent-1",
      }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /prs/claim returns 200 and resets when commitSha differs (new review cycle)", async () => {
    const updatedPr = makePr({
      commitSha: "new-sha",
      reviewState: "in_progress",
      claimedBy: "agent-1",
    });
    const app = makeApp({
      prService: fakePrService({
        claimResult: { status: 200, record: updatedPr },
      }),
    });
    const res = await app.request("/prs/claim", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        repo: ADMIN_REPO,
        prNumber: 42,
        commitSha: "new-sha",
        claimedBy: "agent-1",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.commitSha).toBe("new-sha");
  });

  it("POST /prs/claim returns 400 when repo is missing", async () => {
    const app = makeApp();
    const res = await app.request("/prs/claim", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        prNumber: 42,
        commitSha: "abc123",
        claimedBy: "agent-1",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /prs/claim returns 400 when repo is not in org/repo format", async () => {
    const app = makeApp();
    const res = await app.request("/prs/claim", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        repo: "not-org-repo",
        prNumber: 42,
        commitSha: "abc123",
        claimedBy: "agent-1",
      }),
    });
    expect(res.status).toBe(400);
  });

  // ─── Agent token scope rejection ──────────────────────────────────────────

  it("POST /prs/claim returns 400 for agent token when repo is out of scope", async () => {
    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      scopeResolver: makeScopeResolver([SCOPED_REPO]),
    });
    const res = await app.request("/prs/claim", {
      method: "POST",
      headers: { ...agentAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        repo: "other-org/other-repo",
        prNumber: 1,
        commitSha: "abc",
        claimedBy: "agent-1",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /prs/claim succeeds for agent token when repo is in scope", async () => {
    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      scopeResolver: makeScopeResolver([SCOPED_REPO]),
    });
    const res = await app.request("/prs/claim", {
      method: "POST",
      headers: { ...agentAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        repo: SCOPED_REPO,
        prNumber: 1,
        commitSha: "abc",
        claimedBy: "agent-1",
      }),
    });
    expect(res.status).toBe(201);
  });

  // ─── POST /prs/:id/complete ───────────────────────────────────────────────

  it("POST /prs/:id/complete sets reviewState=posted and reviewedAt", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1", reviewState: "in_progress" }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs/pr-1/complete", {
      method: "POST",
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.reviewState).toBe("posted");
    expect(body.reviewedAt).toBeTruthy();
  });

  it("POST /prs/:id/complete returns 404 when pr not found", async () => {
    const app = makeApp({
      prService: fakePrService({ store: new Map() }),
    });
    const res = await app.request("/prs/missing/complete", {
      method: "POST",
      headers: adminAuth(),
    });
    expect(res.status).toBe(404);
  });

  // ─── POST /prs/:id/patch ──────────────────────────────────────────────────

  it("POST /prs/:id/patch increments patchCycles and sets reviewState=pending", async () => {
    const store = new Map<string, PullRequest>();
    store.set(
      "pr-1",
      makePr({ id: "pr-1", patchCycles: 2, reviewState: "posted" }),
    );
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs/pr-1/patch", {
      method: "POST",
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.patchCycles).toBe(3);
    expect(body.reviewState).toBe("pending");
    expect(body.patchedAt).toBeTruthy();
  });

  // ─── POST /prs/:id/heartbeat ──────────────────────────────────────────────

  it("POST /prs/:id/heartbeat returns 200 and updates heartbeatAt", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1", reviewState: "in_progress" }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs/pr-1/heartbeat", {
      method: "POST",
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.heartbeatAt).toBeTruthy();
  });

  // ─── POST /prs/:id/release ────────────────────────────────────────────────

  it("POST /prs/:id/release clears claim fields and sets reviewState=pending", async () => {
    const store = new Map<string, PullRequest>();
    store.set(
      "pr-1",
      makePr({
        id: "pr-1",
        reviewState: "in_progress",
        claimedBy: "agent-1",
        claimedAt: "2024-01-01T00:00:00.000Z",
        heartbeatAt: "2024-01-01T00:00:00.000Z",
      }),
    );
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs/pr-1/release", {
      method: "POST",
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.reviewState).toBe("pending");
    expect(body.claimedBy).toBeNull();
    expect(body.claimedAt).toBeNull();
    expect(body.heartbeatAt).toBeNull();
  });

  // ─── GET /prs (list filters) ──────────────────────────────────────────────

  it("GET /prs?taskId=X returns linked records", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1", taskId: "task-42" }));
    store.set("pr-2", makePr({ id: "pr-2", taskId: "task-99" }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs?taskId=task-42", {
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequestListResult;
    expect(body.prs).toHaveLength(1);
    expect(body.prs[0].taskId).toBe("task-42");
  });

  it("GET /prs?reviewState=posted returns filtered set", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1", reviewState: "posted" }));
    store.set("pr-2", makePr({ id: "pr-2", reviewState: "pending" }));
    store.set("pr-3", makePr({ id: "pr-3", reviewState: "posted" }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs?reviewState=posted", {
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequestListResult;
    expect(body.prs).toHaveLength(2);
    expect(body.prs.every((p: PullRequest) => p.reviewState === "posted")).toBe(
      true,
    );
  });

  it("GET /prs?staged=true returns staged records only", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1", staged: true }));
    store.set("pr-2", makePr({ id: "pr-2", staged: false }));
    store.set("pr-3", makePr({ id: "pr-3", staged: true }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs?staged=true", {
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequestListResult;
    expect(body.prs).toHaveLength(2);
    expect(body.prs.every((p: PullRequest) => p.staged === true)).toBe(true);
  });

  it("GET /prs?staged=false returns unstaged records only", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1", staged: true }));
    store.set("pr-2", makePr({ id: "pr-2", staged: false }));
    store.set("pr-3", makePr({ id: "pr-3", staged: false }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs?staged=false", {
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequestListResult;
    expect(body.prs).toHaveLength(2);
    expect(body.prs.every((p: PullRequest) => p.staged === false)).toBe(true);
  });

  // ─── GET /prs/:id ─────────────────────────────────────────────────────────

  it("GET /prs/:id returns 200 with the record", async () => {
    const app = makeApp({
      prService: fakePrService({ getResult: makePr({ id: "pr-1" }) }),
    });
    const res = await app.request("/prs/pr-1", { headers: adminAuth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.id).toBe("pr-1");
  });

  it("GET /prs/:id returns 404 when missing", async () => {
    const app = makeApp({
      prService: fakePrService({ getResult: null }),
    });
    const res = await app.request("/prs/missing", { headers: adminAuth() });
    expect(res.status).toBe(404);
  });

  // ─── PATCH /prs/:id ───────────────────────────────────────────────────────

  it("PATCH /prs/:id updates fields and returns 200", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1" }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs/pr-1", {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ staged: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.staged).toBe(true);
  });

  it("PATCH /prs/:id updates state field", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1", state: "open" }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs/pr-1", {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ state: "merged" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.state).toBe("merged");
  });

  it("PATCH /prs/:id updates mergedAt field", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1" }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const mergedAtTime = "2024-01-15T10:30:00Z";
    const res = await app.request("/prs/pr-1", {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ mergedAt: mergedAtTime }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.mergedAt).toBe(mergedAtTime);
  });

  it("PATCH /prs/:id updates reviewState field", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1", reviewState: "pending" }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs/pr-1", {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ reviewState: "approved" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.reviewState).toBe("approved");
  });

  it("PATCH /prs/:id can update state, mergedAt, and reviewState together", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1" }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const mergedAtTime = "2024-01-15T10:30:00Z";
    const res = await app.request("/prs/pr-1", {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        state: "merged",
        mergedAt: mergedAtTime,
        reviewState: "approved",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.state).toBe("merged");
    expect(body.mergedAt).toBe(mergedAtTime);
    expect(body.reviewState).toBe("approved");
  });

  // ─── Auth ─────────────────────────────────────────────────────────────────

  it("GET /prs returns 401 without auth", async () => {
    const app = makeApp();
    const res = await app.request("/prs");
    expect(res.status).toBe(401);
  });

  it("PATCH /prs/:id with reviewState=approved updates reviewState", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1", reviewState: "in_progress" }));
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs/pr-1", {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ reviewState: "approved" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.reviewState).toBe("approved");
  });

  it("PATCH /prs/:id returns 400 for agent token with out-of-scope repo", async () => {
    const store = new Map<string, PullRequest>();
    store.set("pr-1", makePr({ id: "pr-1", repo: "other-org/other-repo" }));
    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      scopeResolver: makeScopeResolver([SCOPED_REPO]),
      prService: fakePrService({ store }),
    });

    const res = await app.request("/prs/pr-1", {
      method: "PATCH",
      headers: { ...agentAuth(), "content-type": "application/json" },
      body: JSON.stringify({ staged: true }),
    });
    expect(res.status).toBe(400);
  });

  // ─── reviewCycles ─────────────────────────────────────────────────────────

  it("POST /prs/:id/complete increments reviewCycles to 1 on first call", async () => {
    const store = new Map<string, PullRequest>();
    store.set(
      "pr-1",
      makePr({ id: "pr-1", reviewState: "in_progress", reviewCycles: 0 }),
    );
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs/pr-1/complete", {
      method: "POST",
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.reviewCycles).toBe(1);
    expect(body.reviewState).toBe("posted");
  });

  it("POST /prs/:id/complete increments reviewCycles to 2 on second call", async () => {
    const store = new Map<string, PullRequest>();
    // Start with reviewCycles=1 (already reviewed once)
    store.set(
      "pr-1",
      makePr({ id: "pr-1", reviewState: "in_progress", reviewCycles: 1 }),
    );
    const app = makeApp({ prService: fakePrService({ store }) });

    const res = await app.request("/prs/pr-1/complete", {
      method: "POST",
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PullRequest;
    expect(body.reviewCycles).toBe(2);
  });
});

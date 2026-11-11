/**
 * admin/src/coding/admin-ui-public-tasks.smoke.test.ts
 * Smoke tests for the coding extension's public read-only task board (admin-ui-coding.ts),
 * composed with the platform admin UI as startAdmin() does. Relocated from
 * admin-ui.smoke.test.ts (AEP-3.2).
 *
 * Uses app.request() — no real server, no real DB.
 */

import { describe, expect, it } from "bun:test";
import {
  createCodingTestApp,
  makeCodingMockDeps,
} from "./admin-ui-coding.fixtures.ts";

// ─── Public task board ────────────────────────────────────────────────────────

describe("admin UI — public task board", () => {
  const PUBLIC_REPO = "app-vitals/shipwright";

  const MOCK_PUBLIC_TASKS = [
    {
      id: "pub-task-1",
      title: "Public task alpha",
      status: "pending",
      session: "sess-pub",
      repo: PUBLIC_REPO,
      assignee: null,
      claimedBy: null,
    },
    {
      id: "pub-task-2",
      title: "Public task beta",
      status: "in_progress",
      session: "sess-pub",
      repo: PUBLIC_REPO,
      assignee: null,
      claimedBy: "agent-pub",
    },
  ];

  it("GET /public/tasks returns 200 without any auth header or cookie", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return {
            tasks: MOCK_PUBLIC_TASKS,
            total: MOCK_PUBLIC_TASKS.length,
            limit: 50,
            offset: 0,
          };
        },
      }),
    );
    // No Cookie, no Authorization header — must still return 200
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
  });

  it("GET /public/tasks passes SHIPWRIGHT_ADMIN_PUBLIC_REPO as repo filter param", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/public/tasks");
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("repo")).toBe(PUBLIC_REPO);
  });

  it("GET /public/tasks?source=entropy-fix forwards source to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/public/tasks?source=entropy-fix");
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("source")).toBe("entropy-fix");
  });

  it("GET /public/tasks with no source param forwards no source to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/public/tasks");
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].has("source")).toBe(false);
  });

  it("GET /public/tasks?source=entropy-fix returns only matching rows and round-trips the filter value", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async (params) => {
          // Simulate the task-store applying the source filter server-side.
          const all = [
            {
              id: "pub-task-src-1",
              title: "Entropy sourced task",
              status: "pending",
              session: "sess-pub",
              repo: PUBLIC_REPO,
              assignee: null,
              claimedBy: null,
              source: "entropy-fix",
            },
            {
              id: "pub-task-src-2",
              title: "Manually filed task",
              status: "pending",
              session: "sess-pub",
              repo: PUBLIC_REPO,
              assignee: null,
              claimedBy: null,
              source: "manual",
            },
          ];
          const source = params.get("source");
          const tasks = source ? all.filter((t) => t.source === source) : all;
          return { tasks, total: tasks.length, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/public/tasks?source=entropy-fix");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Entropy sourced task");
    expect(html).not.toContain("Manually filed task");
  });

  it("GET /public/tasks requests sort=desc from the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/public/tasks");
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("sort")).toBe("desc");
  });

  it("GET /public/tasks renders task rows but NO create/edit/release controls", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async () => ({
          tasks: MOCK_PUBLIC_TASKS,
          total: MOCK_PUBLIC_TASKS.length,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Task rows are present
    expect(html).toContain("Public task alpha");
    expect(html).toContain("Public task beta");
    // No create/edit/status-change controls
    expect(html).not.toContain("Release");
    expect(html).not.toContain("/admin/");
    expect(html).not.toContain("admin_session");
  });

  it("GET /public/tasks does not leak /admin/ links for claimed or blocked tasks", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async () => ({
          tasks: [
            {
              id: "pub-task-3",
              title: "Public task gamma",
              status: "blocked",
              session: "sess-pub",
              repo: PUBLIC_REPO,
              assignee: null,
              claimedBy: "agent-pub",
              blockedBy: [
                { type: "dependency", id: "pub-task-1", status: "pending" },
              ],
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Public task gamma");
    expect(html).toContain("Blocked:");
    expect(html).toContain("agent-pub");
    expect(html).not.toContain("/admin/");
  });

  it("GET /public/tasks never includes the joined PR fields, even for a task with repo+pr set and fetchTaskStorePrs wired (AXR-1.2)", async () => {
    let fetchTaskStorePrsCalled = false;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async () => ({
          tasks: [
            {
              id: "pub-task-4",
              title: "Public task delta",
              status: "in_progress",
              session: "sess-pub",
              repo: PUBLIC_REPO,
              pr: 300,
              assignee: null,
              claimedBy: "agent-pub",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        fetchTaskStorePrs: async () => {
          fetchTaskStorePrsCalled = true;
          return {
            prs: [
              {
                id: "pr-pub-1",
                repo: PUBLIC_REPO,
                prNumber: 300,
                staged: false,
                state: "open",
                reviewState: "pending",
                patchCycles: 0,
                reviewCycles: 0,
                blocked: true,
                blockedReason: "Waiting on CI",
                claimedBy: "agent-pub",
                claimedAt: "2026-01-01T00:00:00.000Z",
                heartbeatAt: "2026-01-01T00:05:00.000Z",
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          };
        },
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Public task delta");
    // The public route never calls the PR-join fetcher and never renders the
    // joined fields — this is the read-only board, join data stays admin-only.
    expect(fetchTaskStorePrsCalled).toBe(false);
    expect(html).not.toContain("data-pr-blocked");
    expect(html).not.toContain("data-pr-blocked-reason");
    expect(html).not.toContain("data-pr-claimed-by");
    expect(html).not.toContain("data-pr-claimed-at");
    expect(html).not.toContain("data-pr-heartbeat-at");
    expect(html).not.toContain("Waiting on CI");
  });

  it("GET /public/tasks renders 200 even when no publicRepo configured (degraded mode)", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        // publicRepo absent — degraded mode, no task store call
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
  });

  it("POST /public/tasks returns 404 or 405 (mutation routes absent)", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({ publicRepo: PUBLIC_REPO }),
    );
    const res = await app.request("/public/tasks", { method: "POST" });
    expect([404, 405]).toContain(res.status);
  });

  it("PUT /public/tasks/pub-task-1 returns 404 or 405", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({ publicRepo: PUBLIC_REPO }),
    );
    const res = await app.request("/public/tasks/pub-task-1", {
      method: "PUT",
    });
    expect([404, 405]).toContain(res.status);
  });

  it("DELETE /public/tasks/pub-task-1 returns 404 or 405", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({ publicRepo: PUBLIC_REPO }),
    );
    const res = await app.request("/public/tasks/pub-task-1", {
      method: "DELETE",
    });
    expect([404, 405]).toContain(res.status);
  });

  it("GET /public/tasks suppresses pagination even when total > 50", async () => {
    // When the public board has more than 50 tasks, pagination links must NOT
    // appear — makePageUrl hardcodes /admin/tasks, which is auth-walled.
    const manyTasks = Array.from({ length: 50 }, (_, i) => ({
      id: `pub-task-${i}`,
      title: `Public task ${i}`,
      status: "pending",
      session: "sess-pub",
      repo: PUBLIC_REPO,
      assignee: null,
      claimedBy: null,
    }));
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async () => ({
          tasks: manyTasks,
          total: 500, // >50 — would trigger pagination in admin mode
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
    const body = await res.text();
    // No pagination links should point to the auth-walled admin route
    expect(body).not.toContain("/admin/tasks");
    expect(body).not.toContain("Next →");
    expect(body).not.toContain("← Prev");
  });

  it("GET /public/tasks with pr set and repo null never renders github.com//pull/ in body", async () => {
    // Regression guard: a task with pr set but repo null must not produce a
    // broken href containing github.com//pull/ in the public task board.
    const dirtyTask = {
      id: "pub-dirty-1",
      title: "Dirty PR task",
      status: "pending",
      session: null,
      repo: null, // repo is null — the bug would produce github.com//pull/5
      pr: 5,
      assignee: null,
      claimedBy: null,
    };
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async () => ({
          tasks: [dirtyTask],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("github.com//pull/");
  });
});

/**
 * admin/src/coding/admin-ui-prs.smoke.test.ts
 * Smoke tests for the coding extension's PRs routes (admin-ui-coding.ts),
 * composed with the platform admin UI as startAdmin() does. Relocated from
 * admin-ui.smoke.test.ts (AEP-3.2).
 *
 * Uses app.request() — no real server, no real DB.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
  AGENT_ID,
  makeSessionCookie,
  SESSION_SECRET,
} from "@app-vitals/agent-admin/admin-ui.fixtures";
import { sign } from "hono/jwt";
import {
  createCodingTestApp,
  makeCodingMockDeps,
} from "./admin-ui-coding.fixtures.ts";
import type { PrListItem } from "./admin-ui-work-item-pages.ts";

// ─── PRs page ─────────────────────────────────────────────────────────────────

describe("admin UI — PRs page", () => {
  let cookie: string;
  let nonAdminCookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
    nonAdminCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      "member@example.com",
      false,
    );
  });

  const MOCK_PR: PrListItem = {
    id: "pr-smoke-1",
    repo: "app-vitals/shipwright",
    prNumber: 42,
    staged: false,
    state: "open",
    reviewState: "in_review",
    patchCycles: 0,
    reviewCycles: 0,
    agentId: null,
    claimedBy: null,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
  };

  it("GET /admin/prs returns 200 with PR table data when fetchTaskStorePrs is injected", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [MOCK_PR],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("app-vitals/shipwright");
    expect(html).toContain("#42");
  });

  it("GET /admin/prs renders the 'Waiting: Blocked' badge for a blocked PR", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [{ ...MOCK_PR, blocked: true }],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Waiting: Blocked");
    expect(html).not.toContain("Waiting: HITL");
  });

  it("GET /admin/prs requests sort=desc from the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async (params) => {
          capturedParams.push(params);
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("sort")).toBe("desc");
  });

  it("GET /admin/prs?blocked=true forwards blocked=true to the task store", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedParams = params;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs?blocked=true", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams).not.toBeNull();
    expect((capturedParams as unknown as URLSearchParams).get("blocked")).toBe(
      "true",
    );
  });

  it("GET /admin/prs without blocked param does not forward a blocked param", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedParams = params;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams).not.toBeNull();
    expect(
      (capturedParams as unknown as URLSearchParams).get("blocked"),
    ).toBeNull();
  });

  it("GET /admin/prs?repo=a&repo=b&org=app-vitals forwards repeated repo and org params to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async (params) => {
          capturedParams.push(params);
          return { prs: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/prs?repo=a&repo=b&org=app-vitals", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].getAll("repo")).toEqual(["a", "b"]);
    expect(capturedParams[0].getAll("org")).toEqual(["app-vitals"]);
  });

  it("GET /admin/prs?repo=org/repo (single value) still forwards a single repo param (backward compat)", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async (params) => {
          capturedParams.push(params);
          return { prs: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/prs?repo=org%2Frepo", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].getAll("repo")).toEqual(["org/repo"]);
  });

  it("GET /admin/prs with no repo/org params forwards neither to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async (params) => {
          capturedParams.push(params);
          return { prs: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].has("repo")).toBe(false);
    expect(capturedParams[0].has("org")).toBe(false);
  });

  it("GET /admin/prs?repo=a&repo=b renders both selected repo options in the multiselect", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
        fetchDistinctTaskValues: async () => ({
          sessions: [],
          repos: ["a", "b", "c"],
          orgs: [],
        }),
      }),
    );
    const res = await app.request("/admin/prs?repo=a&repo=b", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const html = await res.text();
    expect(html).toContain('<option value="a" selected>a</option>');
    expect(html).toContain('<option value="b" selected>b</option>');
    expect(html).toContain('<option value="c">c</option>');
  });

  it("GET /admin/prs returns 200 with degraded warning banner when fetchTaskStorePrs is absent", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        // fetchTaskStorePrs intentionally absent — degraded mode
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("PR store unavailable");
  });

  it("GET /admin/prs renders all linked tasks for a PR with 2 linked tasks", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [MOCK_PR],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        fetchTaskStoreTasks: async (params: URLSearchParams) => {
          if (
            params.get("repo") === "app-vitals/shipwright" &&
            params.get("pr") === "42"
          ) {
            return {
              tasks: [
                { id: "TASK-A", title: "A", status: "done" },
                { id: "TASK-B", title: "B", status: "done" },
              ],
              total: 2,
              limit: 50,
              offset: 0,
            };
          }
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a href="/admin/tasks/TASK-A"');
    expect(html).toContain('<a href="/admin/tasks/TASK-B"');
  });

  it("GET /admin/prs renders the empty-state dash for a PR with 0 linked tasks", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [MOCK_PR],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        fetchTaskStoreTasks: async (_params: URLSearchParams) => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<a href="/admin/tasks/task-abc"');
    expect(html).toContain('<span style="color:#9ca3af">—</span>');
  });

  it("GET /admin/prs degrades linked tasks to empty when fetchTaskStoreTasks throws", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [MOCK_PR],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        fetchTaskStoreTasks: async (_params: URLSearchParams) => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<span style="color:#9ca3af">—</span>');
  });

  it("GET /admin/prs renders empty-state dash for linked tasks when fetchTaskStoreTasks is absent", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [MOCK_PR],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        // fetchTaskStoreTasks intentionally absent
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<span style="color:#9ca3af">—</span>');
  });

  it("GET /admin/prs?taskId= resolves the task's repo+pr live instead of forwarding taskId to /prs", async () => {
    let capturedPrsParams: URLSearchParams | null = null;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-abc"
            ? {
                id: "task-abc",
                title: "Some task",
                status: "done",
                repo: "app-vitals/shipwright",
                pr: 42,
              }
            : null,
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedPrsParams = params;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs?taskId=task-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Filter form still shows what the user typed
    expect(html).toContain('value="task-abc"');
    expect(capturedPrsParams).not.toBeNull();
    const capturedPrs = capturedPrsParams as unknown as URLSearchParams;
    expect(capturedPrs.get("repo")).toBe("app-vitals/shipwright");
    expect(capturedPrs.get("prNumber")).toBe("42");
    expect(capturedPrs.has("taskId")).toBe(false);
  });

  it("GET /admin/prs?taskId=&repo= with a repo filter matching the task's resolved repo still applies the task filter", async () => {
    let capturedPrsParams: URLSearchParams | null = null;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-abc"
            ? {
                id: "task-abc",
                title: "Some task",
                status: "done",
                repo: "app-vitals/shipwright",
                pr: 42,
              }
            : null,
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedPrsParams = params;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request(
      "/admin/prs?taskId=task-abc&repo=app-vitals%2Fshipwright",
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(capturedPrsParams).not.toBeNull();
    const capturedPrs = capturedPrsParams as unknown as URLSearchParams;
    expect(capturedPrs.getAll("repo")).toEqual(["app-vitals/shipwright"]);
    expect(capturedPrs.get("prNumber")).toBe("42");
  });

  it("GET /admin/prs?taskId=&repo= with a repo filter conflicting with the task's resolved repo renders empty list instead of silently overwriting the user's repo filter", async () => {
    let prsCalled = false;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-abc"
            ? {
                id: "task-abc",
                title: "Some task",
                status: "done",
                repo: "app-vitals/shipwright",
                pr: 42,
              }
            : null,
        fetchTaskStorePrs: async (_params: URLSearchParams) => {
          prsCalled = true;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request(
      "/admin/prs?taskId=task-abc&repo=some-other-org%2Fother-repo",
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(prsCalled).toBe(false);
    expect(html).toContain("No PRs found");
    // The user's own repo selection is preserved in the form, not silently dropped.
    expect(html).toContain("some-other-org/other-repo");
  });

  it("GET /admin/prs?taskId= for a task with no pr set renders empty list without an unfiltered query", async () => {
    let prsCalled = false;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-nopr"
            ? {
                id: "task-nopr",
                title: "No PR yet",
                status: "pending",
                repo: "app-vitals/shipwright",
                pr: null,
              }
            : null,
        fetchTaskStorePrs: async (_params: URLSearchParams) => {
          prsCalled = true;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs?taskId=task-nopr", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(prsCalled).toBe(false);
    expect(html).toContain("No PRs found");
  });

  it("GET /admin/prs?taskId= for an unknown task renders empty list without an unfiltered query", async () => {
    let prsCalled = false;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (_id: string) => null,
        fetchTaskStorePrs: async (_params: URLSearchParams) => {
          prsCalled = true;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs?taskId=missing-task", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(prsCalled).toBe(false);
    expect(html).toContain("No PRs found");
  });

  it("GET /admin/prs/:id returns 200 with PR detail when fetchTaskStorePrById is injected and returns a PR", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("app-vitals/shipwright");
    expect(html).toContain("42");
  });

  it("GET /admin/prs/:id renders Verification Checks section using fetchVerificationChecks(?prId=)", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
        fetchVerificationChecks: async (params: URLSearchParams) => {
          capturedParams = params;
          return {
            checks: [
              {
                id: "vc-1",
                taskId: null,
                prRecordId: "pr-smoke-1",
                repo: "app-vitals/shipwright",
                checkName: "typecheck",
                status: "ran_failed",
                reasonCategory: null,
                learnedFromCategory: null,
                durationMs: 2000,
                at: "2026-06-01T10:00:00.000Z",
                createdAt: "2026-06-01T10:00:00.000Z",
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          };
        },
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Verification Checks");
    expect(html).toContain("typecheck");
    expect(capturedParams).not.toBeNull();
    expect((capturedParams as unknown as URLSearchParams).get("prId")).toBe(
      "pr-smoke-1",
    );
    // See the task-detail equivalent: the default oldest-first 50-row page is
    // the wrong end of the history for a "most recent run" card.
    expect(
      Number((capturedParams as unknown as URLSearchParams).get("limit")),
    ).toBeGreaterThan(50);
  });

  it("GET /admin/prs/:id renders without Verification Checks section when fetchVerificationChecks is absent", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Verification Checks");
  });

  it("GET /admin/prs/:id renders without Verification Checks section when fetchVerificationChecks throws", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
        fetchVerificationChecks: async () => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Verification Checks");
  });

  it("GET /admin/prs/:id renders 'Blocked' field, not 'HITL', when the PR is blocked", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? { ...MOCK_PR, blocked: true } : null,
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Blocked");
    expect(html).not.toContain("HITL");
  });

  it("GET /admin/prs/:id renders linked task(s) via a live GET /tasks?repo=&pr= lookup instead of pr.taskId", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
        fetchTaskStoreTasks: async (params: URLSearchParams) => {
          capturedParams = params;
          return {
            tasks: [{ id: "TASK-LIVE", title: "Live", status: "done" }],
            total: 1,
            limit: 50,
            offset: 0,
          };
        },
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a href="/admin/tasks/TASK-LIVE"');
    expect(capturedParams).not.toBeNull();
    expect((capturedParams as unknown as URLSearchParams).get("repo")).toBe(
      "app-vitals/shipwright",
    );
    expect((capturedParams as unknown as URLSearchParams).get("pr")).toBe("42");
  });

  it("GET /admin/prs/:id renders no Task row when fetchTaskStoreTasks is not injected", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
        // fetchTaskStoreTasks intentionally absent
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("/admin/tasks/");
  });

  it("GET /admin/prs/:id renders no Task row when fetchTaskStoreTasks throws", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
        fetchTaskStoreTasks: async () => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("/admin/tasks/");
  });

  it("GET /admin/prs resolves claimedBy agent id to its name via AgentService", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [{ ...MOCK_PR, claimedBy: AGENT_ID }],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Test Agent");
  });

  it("GET /admin/prs/:id resolves claimedBy agent id to its name via AgentService", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? { ...MOCK_PR, claimedBy: AGENT_ID } : null,
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Test Agent");
  });

  it("GET /admin/prs unauthenticated redirects to /admin/login", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/prs", {
      headers: { "Sec-Fetch-Mode": "navigate" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/login?returnTo=${encodeURIComponent("/admin/prs")}`,
    );
  });

  it("unauthenticated non-navigation request to /admin/prs returns 401 signed_out", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/prs");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
  });

  it("GET /admin/prs returns 403 for non-admin authenticated user", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${nonAdminCookie}` },
    });
    expect(res.status).toBe(403);
  });

  // authz-missing-check (fail-open isAdmin default): getSessionUser must treat
  // a session token that omits the isAdmin claim — or sets it to any non-true
  // value — as non-admin, not as admin-by-default.
  it("GET /admin/prs returns 403 when the session token omits the isAdmin claim entirely", async () => {
    const omittedAdminClaimCookie = await sign(
      {
        userId: "google-sub-no-claim",
        email: "no-claim@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      SESSION_SECRET,
      "HS256",
    );
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${omittedAdminClaimCookie}` },
    });
    expect(res.status).toBe(403);
  });

  it("GET /admin/prs returns 403 when the session token's isAdmin claim is a non-boolean truthy value", async () => {
    const nonBooleanAdminClaimCookie = await sign(
      {
        userId: "google-sub-string-claim",
        email: "string-claim@example.com",
        isAdmin: "true",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      SESSION_SECRET,
      "HS256",
    );
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${nonBooleanAdminClaimCookie}` },
    });
    expect(res.status).toBe(403);
  });
});

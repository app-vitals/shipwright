/**
 * admin/src/coding/admin-ui-tasks.smoke.test.ts
 * Smoke tests for the coding extension's tasks routes (admin-ui-coding.ts),
 * composed with the platform admin UI as startAdmin() does. Relocated from
 * admin-ui.smoke.test.ts (AEP-3.2).
 *
 * Uses app.request() — no real server, no real DB.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
  AGENT_ID,
  makeSessionCookie,
} from "@app-vitals/agent-admin/admin-ui.fixtures";
import {
  createCodingTestApp,
  makeCodingMockDeps,
} from "./admin-ui-coding.fixtures.ts";
import type { PrListItem, TaskItem } from "./admin-ui-work-item-pages.ts";

// ─── Tasks page ───────────────────────────────────────────────────────────────

describe("admin UI — tasks page", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("GET /admin/tasks?state=in_progress&status=pr_open forwards only status to task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks?state=in_progress&status=pr_open", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].get("status")).toBe("pr_open");
    expect(capturedParams[0].has("state")).toBe(false);
  });

  it("GET /admin/tasks?state=ready forwards state to task store when no status set", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks?state=ready", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].get("state")).toBe("ready");
    expect(capturedParams[0].has("status")).toBe(false);
  });

  it("GET /admin/tasks (default board) queries each column via ?column= with a page-size limit and no state=open window (TPG-2.1)", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, nextCursor: null };
        },
      }),
    );
    await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.map((p) => p.get("column")).sort()).toEqual([
      "blocked",
      "in_progress",
      "planning",
      "queued",
    ]);
    for (const p of capturedParams) {
      expect(p.has("state")).toBe(false);
      expect(p.get("limit")).toBe("50");
      expect(p.has("cursor")).toBe(false);
    }
  });

  it("GET /admin/tasks?more_queued=… follows the cursor for that column only and Load more chains nextCursor (TPG-2.1)", async () => {
    const calls: Array<{ column: string | null; cursor: string | null }> = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          if (params.has("owner")) return { tasks: [], total: 0, limit: 1 };
          const column = params.get("column");
          const cursor = params.get("cursor");
          calls.push({ column, cursor });
          return {
            tasks: [],
            total: column === "queued" ? 120 : 0,
            limit: 50,
            nextCursor: column === "queued" ? "next2" : null,
          };
        },
      }),
    );
    const res = await app.request("/admin/tasks?more_queued=abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const html = await res.text();
    expect(calls.filter((c) => c.column === "queued")).toEqual([
      { column: "queued", cursor: null },
      { column: "queued", cursor: "abc" },
    ]);
    expect(
      calls.filter((c) => c.column !== "queued").every((c) => !c.cursor),
    ).toBe(true);
    expect(html).toContain("more_queued=abc.next2");
    expect(html).toContain(">120</span>");
    expect(html.match(/class="btn btn-secondary load-more"/g)?.length).toBe(1);
  });

  it("GET /admin/tasks?view=table with no other params forwards neither state nor status, with the standard limit=50 (TBC-2.1)", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks?view=table", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].has("state")).toBe(false);
    expect(capturedParams[0].has("status")).toBe(false);
    expect(capturedParams[0].get("limit")).toBe("50");
  });

  it("GET /admin/tasks?hitl=true forwards hitl=true to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks?hitl=true", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].get("hitl")).toBe("true");
  });

  it("GET /admin/tasks?kind=initiative forwards kind to the task store and renders Planning", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return {
            tasks: [
              {
                id: "INI-1",
                title: "An initiative",
                status: "pending",
                kind: "initiative",
              },
            ],
            total: 1,
            limit: 200,
          };
        },
      }),
    );
    const res = await app.request("/admin/tasks?kind=initiative&owner=all", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams[0].get("kind")).toBe("initiative");
    const body = await res.text();
    expect(body).toContain('data-column="planning"');
    expect(body).toContain("An initiative");
  });

  it("GET /admin/tasks?kind=bogus does not forward kind", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks?kind=bogus", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams[0].has("kind")).toBe(false);
  });

  it("GET /admin/tasks?hitl=false forwards hitl=false to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks?hitl=false", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].get("hitl")).toBe("false");
  });

  it("GET /admin/tasks with no hitl param forwards no hitl to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].has("hitl")).toBe(false);
  });

  it("GET /admin/tasks?hitl=garbage forwards no hitl to the task store (invalid values treated as no filter)", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks?hitl=garbage", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].has("hitl")).toBe(false);
  });

  it("GET /admin/tasks requests sort=desc from the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].get("sort")).toBe("desc");
  });

  it("GET /admin/tasks?source=entropy-fix forwards source to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks?source=entropy-fix", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].get("source")).toBe("entropy-fix");
  });

  it("GET /admin/tasks?repo=a&repo=b&org=app-vitals forwards repeated repo and org params to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks?repo=a&repo=b&org=app-vitals", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].getAll("repo")).toEqual(["a", "b"]);
    expect(capturedParams[0].getAll("org")).toEqual(["app-vitals"]);
  });

  it("GET /admin/tasks?repo=org/repo (single value) still forwards a single repo param (backward compat)", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks?repo=org%2Frepo", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].getAll("repo")).toEqual(["org/repo"]);
  });

  it("GET /admin/tasks with no repo/org params forwards neither to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].has("repo")).toBe(false);
    expect(capturedParams[0].has("org")).toBe(false);
  });

  it("GET /admin/tasks?repo=a&repo=b renders both selected repo options in the multiselect", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
        }),
        fetchDistinctTaskValues: async () => ({
          sessions: [],
          repos: ["a", "b", "c"],
          orgs: [],
        }),
      }),
    );
    const res = await app.request("/admin/tasks?repo=a&repo=b", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const html = await res.text();
    expect(html).toContain('<option value="a" selected>a</option>');
    expect(html).toContain('<option value="b" selected>b</option>');
    expect(html).toContain('<option value="c">c</option>');
  });

  it("GET /admin/tasks with no source param forwards no source to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          // PLU-5.2: skip the Mine-view ownership probe (owner + limit=1).
          if (!params.has("owner")) capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // TPG-2.1: the board issues one ?column= query per column.
    expect(capturedParams.length).toBe(4);
    expect(capturedParams[0].has("source")).toBe(false);
  });

  it("GET /admin/tasks?source=entropy-fix round-trips into the source filter input value", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
        }),
      }),
    );
    const res = await app.request("/admin/tasks?source=entropy-fix", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const html = await res.text();
    expect(html).toContain('name="source"');
    expect(html).toContain('value="entropy-fix"');
  });

  it("GET /admin/tasks renders tasks table with mock data", async () => {
    const mockTasks = [
      {
        id: "task-1",
        title: "Build auth module",
        status: "pending",
        session: "session-abc",
        repo: "example-org/example-repo",
        assignee: null,
        claimedBy: null,
      },
      {
        id: "task-2",
        title: "Fix login bug",
        status: "in_progress",
        session: "session-abc",
        repo: "example-org/example-repo",
        assignee: "dmcaulay",
        claimedBy: "agent-123",
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
        }),
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Build auth module");
    expect(html).toContain("Fix login bug");
    expect(html).toContain("Tasks");
  });

  it("GET /admin/tasks with no ?view= defaults to the board layout (AXR-1.3)", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
        }),
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="board"');
    expect(html).not.toContain('<table class="data-table">');
  });

  it("GET /admin/tasks?view=table renders the pre-redesign dense table (AXR-1.3)", async () => {
    const mockTasks = [
      {
        id: "task-1",
        title: "Build auth module",
        status: "pending",
        session: "session-abc",
        repo: "example-org/example-repo",
        assignee: null,
        claimedBy: null,
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
        }),
      }),
    );
    const res = await app.request("/admin/tasks?view=table", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<table class="data-table">');
    expect(html).toContain("<th>ID</th>");
    expect(html).toContain("Build auth module");
  });

  it("GET /admin/tasks includes joined PR blocked/blockedReason/claimedBy/claimedAt/heartbeatAt for a task with an open PR (AXR-1.2)", async () => {
    const mockTasks = [
      {
        id: "task-join-1",
        title: "Task with an open PR",
        status: "in_progress",
        session: "session-abc",
        repo: "org/repo",
        pr: 200,
        assignee: null,
        claimedBy: null,
      },
    ];
    const MOCK_JOINED_PR: PrListItem = {
      id: "pr-join-1",
      repo: "org/repo",
      prNumber: 200,
      staged: false,
      state: "open",
      reviewState: "pending",
      patchCycles: 0,
      reviewCycles: 0,
      blocked: true,
      blockedReason: "Waiting on CI",
      claimedBy: "agent-join",
      claimedAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:05:00.000Z",
    };
    let capturedParams: URLSearchParams | null = null;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
        }),
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedParams = params;
          return { prs: [MOCK_JOINED_PR], total: 1, limit: 50 };
        },
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-pr-blocked="true"');
    expect(html).toContain('data-pr-blocked-reason="Waiting on CI"');
    expect(html).toContain('data-pr-claimed-by="agent-join"');
    expect(html).toContain('data-pr-claimed-at="2026-01-01T00:00:00.000Z"');
    expect(html).toContain('data-pr-heartbeat-at="2026-01-01T00:05:00.000Z"');
    expect(capturedParams).not.toBeNull();
    const captured = capturedParams as unknown as URLSearchParams;
    expect(captured.get("repo")).toBe("org/repo");
    expect(captured.get("prNumber")).toBe("200");
  });

  it("GET /admin/tasks renders without PR join data when the task has no repo/pr set (AXR-1.2)", async () => {
    const mockTasks = [
      {
        id: "task-no-pr",
        title: "Task without a PR",
        status: "pending",
        session: null,
        repo: null,
        assignee: null,
        claimedBy: null,
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
        }),
        fetchTaskStorePrs: async () => {
          throw new Error("should not be called for a task with no repo/pr");
        },
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("data-pr-blocked");
  });

  it("GET /admin/tasks renders without PR join data when fetchTaskStorePrs throws (degrade, don't fail the page) (AXR-1.2)", async () => {
    const mockTasks = [
      {
        id: "task-join-err",
        title: "Task whose PR lookup fails",
        status: "in_progress",
        session: null,
        repo: "org/repo",
        pr: 201,
        assignee: null,
        claimedBy: null,
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
        }),
        fetchTaskStorePrs: async () => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Task whose PR lookup fails");
    expect(html).not.toContain("data-pr-blocked");
  });

  it("GET /admin/tasks renders degraded notice when taskStoreUrl is absent", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        // No fetchTaskStoreTasks provided — simulates missing SHIPWRIGHT_TASK_STORE_URL
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Task store unavailable");
  });

  it("GET /admin/tasks unauthenticated redirects to /admin/login", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/tasks", {
      headers: { "Sec-Fetch-Mode": "navigate" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/login?returnTo=${encodeURIComponent("/admin/tasks")}`,
    );
  });

  it("unauthenticated non-navigation request to /admin/tasks returns 401 signed_out", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/tasks");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
  });

  it("GET /admin/tasks shows Release button only for in_progress tasks", async () => {
    const mockTasks = [
      {
        id: "task-1",
        title: "Pending task",
        status: "pending",
        session: null,
        repo: null,
        assignee: null,
        claimedBy: null,
      },
      {
        id: "task-2",
        title: "In progress task",
        status: "in_progress",
        session: null,
        repo: null,
        assignee: null,
        claimedBy: "agent-123",
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
        }),
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/admin/tasks/task-2/release");
    expect(html).not.toContain("/admin/tasks/task-1/release");
  });

  // TBF-1.1: the table row's Release button must carry the current table-view
  // list URL as `from` so the redirect back to Task Detail can hand it to
  // that page's "← Tasks" link — otherwise it falls back to bare
  // /admin/tasks, which is the board (AXR-1.3), not the table view the user
  // released the task from.
  it("GET /admin/tasks?view=table row Release form carries ?from=<current table-view URL>", async () => {
    const mockTasks = [
      {
        id: "task-2",
        title: "In progress task",
        status: "in_progress",
        session: null,
        repo: null,
        assignee: null,
        claimedBy: "agent-123",
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
        }),
      }),
    );
    const res = await app.request(
      "/admin/tasks?view=table&status=in_progress&owner=all",
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const expectedFrom = encodeURIComponent(
      "/admin/tasks?status=in_progress&owner=all&view=table",
    );
    expect(html).toContain(
      `action="/admin/tasks/task-2/release?from=${expectedFrom}"`,
    );
  });

  it("GET /admin/tasks?agent= filters by agent name (case-insensitive)", async () => {
    // makeMockDeps prisma.agent.findMany returns the agent with id AGENT_ID, name "Test Agent"
    const mockTasks = [
      {
        id: "task-1",
        title: "Task for Test Agent",
        status: "pending",
        session: null,
        repo: null,
        assignee: AGENT_ID,
        claimedBy: null,
      },
      {
        id: "task-2",
        title: "Unassigned task",
        status: "pending",
        session: null,
        repo: null,
        assignee: null,
        claimedBy: null,
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
        }),
      }),
    );
    const res = await app.request("/admin/tasks?agent=test", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Task for Test Agent");
    expect(html).not.toContain("Unassigned task");
  });

  it("GET /admin/tasks with fetchDistinctTaskValues configured includes agent names in the autocomplete datalist via AgentService", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
        }),
        fetchDistinctTaskValues: async () => ({
          sessions: [],
          repos: [],
          orgs: [],
        }),
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<datalist id="agents-list">');
    expect(html).toContain('<option value="Test Agent">');
  });

  it("POST /admin/tasks/:id/release calls releaseTask and redirects to task detail when fetchTaskStoreTask is wired", async () => {
    const released: string[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
        }),
        fetchTaskStoreTask: async () => null,
        releaseTask: async (id: string) => {
          released.push(id);
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-2/release", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/tasks/task-2");
    expect(released).toEqual(["task-2"]);
  });

  it("POST /admin/tasks/:id/release redirects to task list in degraded mode (no fetchTaskStoreTask)", async () => {
    const released: string[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
        }),
        releaseTask: async (id: string) => {
          released.push(id);
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-2/release", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/tasks");
    expect(released).toEqual(["task-2"]);
  });

  it("POST /admin/tasks/:id/release redirects with ?error=release_failed when releaseTask throws", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
        }),
        releaseTask: async () => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-2/release", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks?error=release_failed",
    );
  });

  // TBF-1.1: a valid `from` on the release POST is forwarded onto the
  // redirect target so the Task Detail page's "← Tasks" link can send the
  // user back to the table view they released the task from.
  it("POST /admin/tasks/:id/release?from=<valid list URL> forwards it onto the redirect target", async () => {
    const released: string[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
        }),
        fetchTaskStoreTask: async () => null,
        releaseTask: async (id: string) => {
          released.push(id);
        },
      }),
    );
    const from = "/admin/tasks?status=in_progress&view=table";
    const res = await app.request(
      `/admin/tasks/task-2/release?from=${encodeURIComponent(from)}`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/tasks/task-2?from=${encodeURIComponent(from)}`,
    );
    expect(released).toEqual(["task-2"]);
  });

  // Reuses the same TASK_LIST_BACK_HREF_PATTERN allowlist as the Task
  // Detail page's own back-link resolver — an unlisted `from` value on the
  // release POST must not become an open redirect off the admin domain.
  it.each([
    ["https://evil.com", "absolute URL"],
    ["//evil.com", "protocol-relative URL"],
    ["javascript:alert(1)", "javascript: URI"],
    ["/admin/other", "different admin path"],
  ])(
    "POST /admin/tasks/:id/release?from=<malicious %s (%s)> is rejected, not forwarded",
    async (maliciousFrom) => {
      const released: string[] = [];
      const app = createCodingTestApp(
        makeCodingMockDeps({
          fetchTaskStoreTasks: async () => ({
            tasks: [],
            total: 0,
            limit: 50,
          }),
          fetchTaskStoreTask: async () => null,
          releaseTask: async (id: string) => {
            released.push(id);
          },
        }),
      );
      const res = await app.request(
        `/admin/tasks/task-2/release?from=${encodeURIComponent(maliciousFrom)}`,
        {
          method: "POST",
          headers: { Cookie: `admin_session=${cookie}` },
        },
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/tasks/task-2");
      expect(released).toEqual(["task-2"]);
    },
  );

  it("POST /admin/tasks/:id/release with no ?from= redirects exactly as before (no from param)", async () => {
    const released: string[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
        }),
        fetchTaskStoreTask: async () => null,
        releaseTask: async (id: string) => {
          released.push(id);
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-2/release", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/tasks/task-2");
    expect(released).toEqual(["task-2"]);
  });

  it("GET /admin/tasks/:id renders task detail page", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      description: "Do the work",
      branch: "feat/thing",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      claimedAt: "2024-01-15T10:00:00.000Z",
    };
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Build the thing");
    expect(html).toContain("Do the work");
    expect(html).toContain("feat/thing");
    expect(html).toContain("← Tasks");
    // Unknown agent ID shown as raw ID (no name resolution)
    expect(html).toContain("agent-unknown");
  });

  it("GET /admin/tasks/:id resolves agent IDs to names", async () => {
    const mockTask = {
      id: "task-43",
      title: "Task with known agent",
      status: "in_progress",
      assignee: AGENT_ID,
      claimedBy: AGENT_ID,
      session: null,
      repo: null,
    };
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-43" ? mockTask : null,
      }),
    );
    const res = await app.request("/admin/tasks/task-43", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Name resolved from the admin DB — shown as "Test Agent (agent-test-123)"
    expect(html).toContain("Test Agent");
    expect(html).toContain(AGENT_ID);
  });

  it("GET /admin/tasks/:id?from=<valid list URL> round-trips into the ← Tasks back link", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      session: null,
      repo: "org/repo",
    };
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
      }),
    );
    const from = "/admin/tasks?status=in_progress&page=2";
    const res = await app.request(
      `/admin/tasks/task-42?from=${encodeURIComponent(from)}`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<a href="${from.replace(/&/g, "&amp;")}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  it.each([
    ["https://evil.com", "absolute URL"],
    ["//evil.com", "protocol-relative URL"],
    ["javascript:alert(1)", "javascript: URI"],
    ["/admin/other", "different admin path"],
  ])(
    "GET /admin/tasks/:id?from=<malicious %s (%s)> falls back to /admin/tasks",
    async (maliciousFrom) => {
      const mockTask = {
        id: "task-42",
        title: "Build the thing",
        status: "in_progress",
        session: null,
        repo: "org/repo",
      };
      const app = createCodingTestApp(
        makeCodingMockDeps({
          fetchTaskStoreTask: async (id: string) =>
            id === "task-42" ? mockTask : null,
        }),
      );
      const res = await app.request(
        `/admin/tasks/task-42?from=${encodeURIComponent(maliciousFrom)}`,
        { headers: { Cookie: `admin_session=${cookie}` } },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(
        `<a href="/admin/tasks" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
      );
      expect(html).not.toContain(maliciousFrom);
    },
  );

  it("GET /admin/tasks/:id redirects to list when task not found", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async () => null,
      }),
    );
    const res = await app.request("/admin/tasks/missing-task", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks?error=task_not_found",
    );
  });

  it("GET /admin/tasks/:id degrades when fetchTaskStoreTask not provided", async () => {
    const app = createCodingTestApp(makeCodingMockDeps({}));
    const res = await app.request("/admin/tasks/task-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks?error=task_store_unavailable",
    );
  });

  it("GET /admin/tasks/:id renders PR section when fetchTaskStorePrs finds a PR via repo+prNumber lookup", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      description: "Do the work",
      branch: "feat/thing",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      pr: 100,
      claimedAt: "2024-01-15T10:00:00.000Z",
    };
    const MOCK_PR_ITEM: PrListItem = {
      id: "pr-test-1",
      repo: "org/repo",
      prNumber: 100,
      staged: false,
      state: "open",
      reviewState: "approved",
      patchCycles: 1,
      reviewCycles: 0,
      reviewedAt: "2026-06-20T10:00:00Z",
      patchedAt: null,
    };
    let capturedParams: URLSearchParams | null = null;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedParams = params;
          return { prs: [MOCK_PR_ITEM], total: 1, limit: 50 };
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pull Request Review");
    expect(html).toContain("#100");
    expect(capturedParams).not.toBeNull();
    const captured = capturedParams as unknown as URLSearchParams;
    expect(captured.get("repo")).toBe("org/repo");
    expect(captured.get("prNumber")).toBe("100");
    expect(captured.has("taskId")).toBe(false);
  });

  it("GET /admin/tasks/:id renders without PR section when fetchTaskStorePrs throws", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      description: "Do the work",
      branch: "feat/thing",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      pr: 100,
      claimedAt: "2024-01-15T10:00:00.000Z",
    };
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
        fetchTaskStorePrs: async (_params: URLSearchParams) => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Pull Request Review");
  });

  it("GET /admin/tasks/:id renders without PR section when fetchTaskStorePrs is absent", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      description: "Do the work",
      branch: "feat/thing",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      pr: 100,
      claimedAt: "2024-01-15T10:00:00.000Z",
    };
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Pull Request Review");
  });

  it("GET /admin/tasks/:id renders without PR section when task has no repo/pr set", async () => {
    const mockTask = {
      id: "task-43",
      title: "Build another thing",
      status: "pending",
      description: "Do more work",
      branch: null,
      assignee: null,
      claimedBy: null,
      session: null,
      repo: null,
      pr: null,
    };
    let called = false;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-43" ? mockTask : null,
        fetchTaskStorePrs: async (_params: URLSearchParams) => {
          called = true;
          return { prs: [], total: 0, limit: 50 };
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-43", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Pull Request Review");
    expect(called).toBe(false);
  });

  it("GET /admin/tasks/:id renders Verification Checks section using fetchVerificationChecks(?taskId=)", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      description: "Do the work",
      branch: "feat/thing",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      pr: null,
    };
    let capturedParams: URLSearchParams | null = null;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
        fetchVerificationChecks: async (params: URLSearchParams) => {
          capturedParams = params;
          return {
            checks: [
              {
                id: "vc-1",
                taskId: "task-42",
                prRecordId: null,
                repo: "org/repo",
                checkName: "unit",
                status: "ran_passed",
                reasonCategory: null,
                learnedFromCategory: null,
                durationMs: 1000,
                at: "2026-06-01T10:00:00.000Z",
                createdAt: "2026-06-01T10:00:00.000Z",
              },
            ],
            total: 1,
            limit: 50,
          };
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Verification Checks");
    expect(html).toContain("unit");
    expect(capturedParams).not.toBeNull();
    const captured = capturedParams as unknown as URLSearchParams;
    expect(captured.get("taskId")).toBe("task-42");
    // The task-store returns rows `at`-ascending with a default limit of 50,
    // so an unqualified request would hand the card the OLDEST page. The route
    // must ask for a window big enough to contain each checkName's latest run.
    expect(Number(captured.get("limit"))).toBeGreaterThan(50);
  });

  it("GET /admin/tasks?view=table pages by cursor: sends cursor (never offset) and renders Prev/Next with a stack", async () => {
    const seen: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params: URLSearchParams) => {
          seen.push(params);
          return {
            tasks: [],
            total: 120,
            limit: 50,
            nextCursor: params.get("cursor") === "c3" ? null : "c-next",
          };
        },
      }),
    );
    const get = async (qs: string) => {
      const res = await app.request(`/admin/tasks?view=table&owner=all${qs}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      return res.text();
    };

    // First page: no cursor upstream, Next only.
    const first = await get("");
    expect(seen.at(-1)?.has("cursor")).toBe(false);
    expect(first).toContain("cursor=c-next");
    expect(first).not.toContain("← Prev");

    // Middle page: cursor forwarded, Prev returns via stack, Next pushes it.
    const middle = await get("&cursor=c2&prev=c1");
    expect(seen.at(-1)?.get("cursor")).toBe("c2");
    expect(middle).toContain("← Prev");
    expect(middle).toContain("cursor=c1");
    expect(middle).toContain("cursor=c-next&prev=c1.c2");

    // Last page: Prev only.
    const last = await get("&cursor=c3&prev=c2");
    expect(last).toContain("← Prev");
    expect(last).not.toContain("Next →");

    for (const p of seen) expect(p.has("offset")).toBe(false);
  });

  it("GET /admin/tasks/:id pages to the newest verification checks when the history exceeds one page", async () => {
    const mockTask = {
      id: "task-99",
      title: "Long-running task",
      status: "in_progress",
      description: "Many verification runs",
      branch: "feat/long",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      pr: null,
    };
    const makeCheck = (id: string, status: string, at: string) => ({
      id,
      taskId: "task-99",
      prRecordId: null,
      repo: "org/repo",
      checkName: "unit",
      status,
      reasonCategory: null,
      learnedFromCategory: null,
      durationMs: 1000,
      at,
      createdAt: at,
    });
    const TOTAL = 250;
    const requests: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-99" ? mockTask : null,
        fetchVerificationChecks: async (params: URLSearchParams) => {
          requests.push(params);
          const limit = Number(params.get("limit"));
          // Oldest-first cursor pagination: the first page is the stale head
          // of the history and hands back a nextCursor; following it reaches
          // the last page (nextCursor null) with the most recent runs.
          const cursor = params.get("cursor");
          const checks = cursor
            ? [makeCheck("vc-new", "ran_passed", "2026-06-20T10:00:00.000Z")]
            : [makeCheck("vc-old", "ran_failed", "2026-06-01T10:00:00.000Z")];
          return {
            checks,
            total: TOTAL,
            limit,
            nextCursor: cursor ? null : "cur-2",
          };
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-99", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Two calls: the first returns a nextCursor, the second follows it to the
    // tail page. Neither sends offset (cursor paging).
    expect(requests.length).toBe(2);
    expect(requests[0].get("cursor")).toBeNull();
    expect(requests[1].get("taskId")).toBe("task-99");
    expect(requests[1].get("cursor")).toBe("cur-2");
    for (const r of requests) expect(r.get("offset")).toBeNull();
    // The rendered card reflects the newest run, not the stale first page.
    expect(html).toContain("2026-06-20T10:00:00.000Z");
    expect(html).not.toContain("2026-06-01T10:00:00.000Z");
  });

  it("GET /admin/tasks/:id renders without Verification Checks section when fetchVerificationChecks is absent", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      description: "Do the work",
      branch: "feat/thing",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      pr: null,
    };
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Verification Checks");
  });

  it("GET /admin/tasks/:id renders without Verification Checks section when fetchVerificationChecks throws", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      description: "Do the work",
      branch: "feat/thing",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      pr: null,
    };
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
        fetchVerificationChecks: async () => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Verification Checks");
  });

  it("GET /admin/tasks?view=table with no ?state= forwards no state to task-store (show all)", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params: URLSearchParams) => {
          capturedParams = params;
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    const res = await app.request("/admin/tasks?view=table", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams).not.toBeNull();
    expect(
      (capturedParams as unknown as URLSearchParams).get("state"),
    ).toBeNull();
  });

  it("GET /admin/tasks?state=blocked returns 200 and forwards state=blocked to task-store", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params: URLSearchParams) => {
          capturedParams = params;
          return { tasks: [], total: 0, limit: 50 };
        },
      }),
    );
    const res = await app.request("/admin/tasks?state=blocked", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams).not.toBeNull();
    expect((capturedParams as unknown as URLSearchParams).get("state")).toBe(
      "blocked",
    );
  });
});

// ─── INI-1.3: quick-add and promote routes ────────────────────────────────────

describe("admin UI — quick-add and promote (INI-1.3)", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  const post = (
    app: ReturnType<typeof createCodingTestApp>,
    path: string,
    fields: Record<string, string>,
  ) =>
    app.request(path, {
      method: "POST",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    });

  const emptyList = async () => ({
    tasks: [],
    total: 0,
    limit: 50,
  });

  it("POST /admin/tasks/quick-add creates a pending initiative and redirects with success", async () => {
    const created: Record<string, unknown>[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: emptyList,
        createTask: async (body: Record<string, unknown>) => {
          created.push(body);
          return { id: "new-1" };
        },
      }),
    );
    const res = await post(app, "/admin/tasks/quick-add", {
      title: "  Add risk score ",
      description: "some notes",
      repo: "app-vitals/shipwright",
      session: "risk",
      kind: "initiative",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks?success=task_created",
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      title: "Add risk score",
      description: "some notes",
      repo: "app-vitals/shipwright",
      session: "risk",
      kind: "initiative",
      status: "pending",
    });
  });

  it("POST /admin/tasks/quick-add accepts idea with only a title (repo null)", async () => {
    const created: Record<string, unknown>[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        createTask: async (body: Record<string, unknown>) => {
          created.push(body);
          return { id: "new-2" };
        },
      }),
    );
    const res = await post(app, "/admin/tasks/quick-add", {
      title: "Maybe do X",
      kind: "idea",
    });
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks?success=task_created",
    );
    expect(created[0]).toMatchObject({ kind: "idea", repo: null });
    expect(created[0]).not.toHaveProperty("session");
  });

  it("POST /admin/tasks/quick-add rejects invalid input without calling the store", async () => {
    let calls = 0;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        createTask: async () => {
          calls++;
          return {};
        },
      }),
    );
    const invalidInputs: Record<string, string>[] = [
      { title: "", kind: "idea" },
      { title: "x", kind: "dev" },
      { title: "x", kind: "prd" },
      { title: "x" },
      { title: "x", kind: "idea", repo: "not a repo" },
    ];
    for (const fields of invalidInputs) {
      const res = await post(app, "/admin/tasks/quick-add", fields);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "/admin/tasks?error=quick_add_invalid",
      );
    }
    expect(calls).toBe(0);
  });

  it("POST /admin/tasks/quick-add redirects with error when the store fails or is absent", async () => {
    const failing = createCodingTestApp(
      makeCodingMockDeps({
        createTask: async () => {
          throw new Error("boom");
        },
      }),
    );
    const res = await post(failing, "/admin/tasks/quick-add", {
      title: "x",
      kind: "idea",
    });
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks?error=quick_add_failed",
    );
    const absent = createCodingTestApp(makeCodingMockDeps({}));
    const res2 = await post(absent, "/admin/tasks/quick-add", {
      title: "x",
      kind: "idea",
    });
    expect(res2.headers.get("Location")).toBe(
      "/admin/tasks?error=task_store_unavailable",
    );
  });

  it("POST /admin/tasks/quick-add requires auth", async () => {
    const app = createCodingTestApp(makeCodingMockDeps({}));
    const res = await app.request("/admin/tasks/quick-add", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "title=x&kind=idea",
    });
    expect(res.status).not.toBe(200);
    expect(res.headers.get("Location") ?? "").not.toContain("success=");
  });

  it("POST /admin/tasks/:id/promote patches idea->initiative and redirects with success", async () => {
    const patches: { id: string; patch: Record<string, unknown> }[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) => ({
          id,
          title: "t",
          status: "pending",
          kind: "idea",
        }),
        patchTask: async (id: string, patch: Record<string, unknown>) => {
          patches.push({ id, patch });
          return {};
        },
      }),
    );
    const res = await post(app, "/admin/tasks/T-1/promote", {});
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks?success=task_promoted",
    );
    expect(patches).toEqual([{ id: "T-1", patch: { kind: "initiative" } }]);
  });

  it("POST /admin/tasks/:id/promote rejects initiative tasks", async () => {
    let patched = 0;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) => ({
          id,
          title: "t",
          status: "pending",
          kind: "initiative",
        }),
        patchTask: async () => {
          patched++;
          return {};
        },
      }),
    );
    const res = await post(app, "/admin/tasks/T-2/promote", {
      return: "/admin/tasks/T-2",
    });
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks/T-2?error=promote_invalid",
    );
    expect(patched).toBe(0);
  });

  it("POST /admin/tasks/:id/promote ignores an off-site return path", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) => ({
          id,
          title: "t",
          status: "pending",
          kind: "idea",
        }),
        patchTask: async () => ({}),
      }),
    );
    const res = await post(app, "/admin/tasks/T-1/promote", {
      return: "https://evil.example/x",
    });
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks?success=task_promoted",
    );
  });

  it("POST /admin/tasks/:id/promote is rejected for dev and prd tasks", async () => {
    let patched = 0;
    for (const kind of ["dev", "prd", undefined]) {
      const app = createCodingTestApp(
        makeCodingMockDeps({
          fetchTaskStoreTask: async (id: string) => ({
            id,
            title: "t",
            status: "pending",
            ...(kind ? { kind } : {}),
          }),
          patchTask: async () => {
            patched++;
            return {};
          },
        }),
      );
      const res = await post(app, "/admin/tasks/T-3/promote", {});
      expect(res.headers.get("Location")).toBe(
        "/admin/tasks?error=promote_invalid",
      );
    }
    expect(patched).toBe(0);
  });

  it("POST /admin/tasks/:id/promote handles missing task and store failure", async () => {
    const missing = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async () => null,
        patchTask: async () => ({}),
      }),
    );
    expect(
      (await post(missing, "/admin/tasks/nope/promote", {})).headers.get(
        "Location",
      ),
    ).toBe("/admin/tasks?error=task_not_found");
    const failing = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) => ({
          id,
          title: "t",
          status: "pending",
          kind: "idea",
        }),
        patchTask: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(
      (await post(failing, "/admin/tasks/T-1/promote", {})).headers.get(
        "Location",
      ),
    ).toBe("/admin/tasks?error=promote_failed");
  });

  it("GET /admin/tasks renders the quick-add form and success notice", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({ fetchTaskStoreTasks: emptyList }),
    );
    const res = await app.request("/admin/tasks?success=task_created", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const html = await res.text();
    expect(html).toContain("/admin/tasks/quick-add");
    expect(html).toContain("Task created.");
  });

  it("GET /admin/tasks/:id shows plan-session hint for an initiative", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: emptyList,
        fetchTaskStoreTask: async (id: string) => ({
          id,
          title: "Init",
          status: "pending",
          kind: "initiative",
        }),
      }),
    );
    const res = await app.request("/admin/tasks/T-9?success=task_promoted", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const html = await res.text();
    expect(html).toContain("/shipwright:prd");
    expect(html).toContain("/shipwright:plan-session");
    expect(html).toContain("--initiative T-9");
    expect(html).toContain("Task promoted.");
  });

  it("GET /public/tasks never renders quick-add or promote controls", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        publicRepo: "app-vitals/shipwright",
        fetchTaskStoreTasks: async () => ({
          tasks: [
            {
              id: "P-1",
              title: "Pub",
              status: "pending",
              kind: "initiative",
              repo: "app-vitals/shipwright",
              assignee: null,
              claimedBy: null,
            },
          ],
          total: 1,
          limit: 50,
        }),
      }),
    );
    const html = await (await app.request("/public/tasks")).text();
    expect(html).toContain("Pub");
    expect(html).not.toContain("quick-add");
    expect(html).not.toContain("/promote");
  });
});

// ─── PLU-5.2: owner, origin, linked-document source, Mine / All ──────────────

describe("admin UI — tasks owner, origin and Mine view (PLU-5.2)", () => {
  const ME = "admin@example.com";
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  const mk = (over: Partial<TaskItem>): TaskItem => ({
    id: "T-1",
    title: "A task",
    status: "pending",
    session: null,
    repo: null,
    assignee: null,
    claimedBy: null,
    ...over,
  });
  const mine = mk({
    id: "T-MINE",
    title: "Mine task",
    owner: ME,
    source: "plan-session",
    session: "sess-a",
    planDocumentId: "doc-plan-1",
    originKind: "document",
    originRef: "doc-plan-1",
  });
  const other = mk({
    id: "T-OTHER",
    title: "Other task",
    owner: "other@example.com",
    source: "manual",
    originKind: "human",
  });
  const all = [mine, other];

  function ownerAwareFetch(calls: URLSearchParams[] = []) {
    return async (params: URLSearchParams) => {
      calls.push(params);
      const owner = params.get("owner");
      const rows = owner ? all.filter((t) => t.owner === owner) : all;
      return { tasks: rows, total: rows.length, limit: 50 };
    };
  }
  const get = (app: ReturnType<typeof createCodingTestApp>, path: string) =>
    app.request(path, { headers: { Cookie: `admin_session=${cookie}` } });

  it("renders source as an anchor when the task has a linked document, plain text otherwise", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({ fetchTaskStoreTasks: ownerAwareFetch() }),
    );
    const html = await (
      await get(app, "/admin/tasks?view=table&owner=all")
    ).text();
    expect(html).toMatch(
      /<td class="col-source[^"]*"[^>]*><a href="\/admin\/sessions\/sess-a[^"]*"[^>]*>plan-session<\/a>/,
    );
    expect(html).toMatch(/<td class="col-source[^"]*"[^>]*>manual<\/td>/);
    expect(html).toContain("<th>Owner</th>");
    expect(html).toContain("<th>Origin</th>");
    expect(html).toContain("document: doc-plan-1");
    expect(html).toContain("other@example.com");
  });

  it("?owner= filters the task-store query and the list", async () => {
    const calls: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({ fetchTaskStoreTasks: ownerAwareFetch(calls) }),
    );
    const html = await (
      await get(app, "/admin/tasks?view=table&owner=other@example.com")
    ).text();
    expect(calls.at(-1)?.get("owner")).toBe("other@example.com");
    expect(html).toContain("Other task");
    expect(html).not.toContain("Mine task");
  });

  it("defaults to Mine when the signed-in user owns tasks", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({ fetchTaskStoreTasks: ownerAwareFetch() }),
    );
    const html = await (await get(app, "/admin/tasks?view=table")).text();
    expect(html).toContain("Mine task");
    expect(html).not.toContain("Other task");
    expect(html).toMatch(
      /class="btn btn-primary"[^>]*aria-current="true">Mine</,
    );
    expect(html).toContain("owner=admin%40example.com");
  });

  it("defaults to All when the user owns nothing, and ?owner=all skips the probe", async () => {
    const nobody = await makeSessionCookie(
      undefined,
      "sub-9",
      "nobody@example.com",
    );
    const app = createCodingTestApp(
      makeCodingMockDeps({ fetchTaskStoreTasks: ownerAwareFetch() }),
    );
    const html = await (
      await app.request("/admin/tasks?view=table", {
        headers: { Cookie: `admin_session=${nobody}` },
      })
    ).text();
    expect(html).toContain("Mine task");
    expect(html).toContain("Other task");
    expect(html).toMatch(
      /class="btn btn-primary"[^>]*aria-current="true">All</,
    );

    const calls: URLSearchParams[] = [];
    const app2 = createCodingTestApp(
      makeCodingMockDeps({ fetchTaskStoreTasks: ownerAwareFetch(calls) }),
    );
    await get(app2, "/admin/tasks?view=table&owner=all");
    expect(calls).toHaveLength(1);
    expect(calls[0].get("owner")).toBeNull();
  });

  it("the board view shows the same Mine / All switch", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({ fetchTaskStoreTasks: ownerAwareFetch() }),
    );
    const html = await (await get(app, "/admin/tasks")).text();
    expect(html).toMatch(
      /class="btn btn-primary"[^>]*aria-current="true">Mine</,
    );
    expect(html).toContain("Mine task");
    expect(html).not.toContain("Other task");
  });

  it("quick-add form defaults owner to the signed-in email and posts it", async () => {
    const created: Record<string, unknown>[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: ownerAwareFetch(),
        createTask: async (body: Record<string, unknown>) => {
          created.push(body);
          return { id: "n" };
        },
      }),
    );
    const html = await (await get(app, "/admin/tasks?owner=all")).text();
    expect(html).toMatch(/name="owner"[^>]*value="admin@example.com"/);

    const post = (fields: Record<string, string>) =>
      app.request("/admin/tasks/quick-add", {
        method: "POST",
        headers: {
          Cookie: `admin_session=${cookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields).toString(),
      });
    await post({ title: "x", kind: "idea" });
    await post({ title: "y", kind: "idea", owner: "edited@example.com" });
    expect(created[0]).toMatchObject({ owner: ME });
    expect(created[1]).toMatchObject({ owner: "edited@example.com" });
  });
});

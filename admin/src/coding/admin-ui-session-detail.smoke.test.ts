/**
 * admin/src/coding/admin-ui-session-detail.smoke.test.ts
 * Smoke tests for the coding extension's session detail route (admin-ui-coding.ts),
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
import {
  createCodingTestApp,
  makeCodingMockDeps,
} from "./admin-ui-coding.fixtures.ts";
import type { PrListItem } from "./admin-ui-work-item-pages.ts";

// ─── Session detail page (ASV-1.1) ──────────────────────────────────────────

describe("admin UI — session detail page", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("GET /admin/sessions/:id renders stat cards + task table grouped by ready/in_progress/blocked/closed", async () => {
    const mockTasks = [
      {
        id: "task-1",
        title: "Build auth module",
        status: "pending",
        session: "session-abc",
        repo: "example-org/example-repo",
        layer: "Backend",
        hours: 2,
        assignee: null,
        claimedBy: null,
      },
      {
        id: "task-2",
        title: "Ship the feature",
        status: "done",
        session: "session-abc",
        repo: "example-org/example-repo",
        layer: "Frontend",
        hours: 3,
        assignee: null,
        claimedBy: null,
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          expect(params.get("session")).toBe("session-abc");
          return {
            tasks: mockTasks,
            total: mockTasks.length,
            limit: 500,
            offset: 0,
          };
        },
      }),
    );
    const res = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Build auth module");
    expect(html).toContain("Ship the feature");
    // Ready/in_progress/blocked/closed grouping present — task-1 is pending
    // with no blockedBy entries (ready), task-2 is done (closed).
    expect(html).toMatch(/1[^0-9]*ready/i);
    expect(html).toMatch(/1[^0-9]*closed/i);
    expect(html).toContain("Ready (1)");
    expect(html).toContain("Closed (1)");
    // Status column
    expect(html).toContain("Status");
  });

  it("GET /admin/sessions/:id renders a sensible empty state for a session with no tasks", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/sessions/empty-session", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("no tasks");
  });

  it("GET /admin/sessions/:id requests sort=desc from the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 500, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("sort")).toBe("desc");
  });

  it("GET /admin/sessions/:id?from=<valid task list URL> round-trips into the ← Tasks back link", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const from = "/admin/tasks?status=in_progress&page=2";
    const res = await app.request(
      `/admin/sessions/session-abc?from=${encodeURIComponent(from)}`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<a href="${from.replace(/&/g, "&amp;")}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  it("GET /admin/sessions/:id?from=<valid task detail URL> round-trips into the ← Tasks back link", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const from = "/admin/tasks/task-42";
    const res = await app.request(
      `/admin/sessions/session-abc?from=${encodeURIComponent(from)}`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<a href="${from}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  it.each([
    ["https://evil.com", "absolute URL"],
    ["//evil.com", "protocol-relative URL"],
    ["javascript:alert(1)", "javascript: URI"],
    ["/admin/other", "different admin path"],
  ])(
    "GET /admin/sessions/:id?from=<malicious %s (%s)> falls back to /admin/tasks",
    async (maliciousFrom) => {
      const app = createCodingTestApp(
        makeCodingMockDeps({
          fetchTaskStoreTasks: async () => ({
            tasks: [],
            total: 0,
            limit: 500,
            offset: 0,
          }),
        }),
      );
      const res = await app.request(
        `/admin/sessions/session-abc?from=${encodeURIComponent(maliciousFrom)}`,
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

  // ─── Needs-you panel + header state badge (SESH-5.1) ──────────────────────

  it("a waiting session (blocked task) shows the Needs-you panel with Blocked badge + reason + since + task link", async () => {
    const mockTasks = [
      {
        id: "task-blocked",
        title: "Stuck task",
        status: "blocked",
        session: "session-waiting",
        repo: "example-org/example-repo",
        assignee: null,
        claimedBy: null,
        blockedReason: "Needs a human decision",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/sessions/session-waiting", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Needs you");
    expect(html).toContain("Blocked");
    expect(html).toContain("Needs a human decision");
    expect(html).toContain("2026-09-01T00:00:00.000Z");
    expect(html).toContain('href="/admin/tasks/task-blocked"');
    expect(html).toContain("/shipwright:unblock task-blocked");
    // Header state badge
    expect(html).toContain("Waiting");
    expect(html).toContain("Waiting since");
  });

  it("a waiting session (hitl task, no unmet dependency) shows the Needs-you panel with HITL badge + fixed hint", async () => {
    const mockTasks = [
      {
        id: "task-hitl",
        title: "Needs a human",
        status: "in_progress",
        session: "session-hitl-waiting",
        repo: "example-org/example-repo",
        assignee: null,
        claimedBy: null,
        hitl: true,
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/sessions/session-hitl-waiting", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Needs you");
    expect(html).toContain("HITL");
    expect(html).toContain("Needs human via /shipwright:hitl");
    expect(html).toContain("/shipwright:hitl task-hitl");
  });

  it("a waiting session (pr_blocked task) shows the Needs-you panel with PR blocked badge + the PR's blockedReason + a PR link", async () => {
    const PR_BLOCKED: PrListItem = {
      id: "pr-block-1",
      repo: "example-org/example-repo",
      prNumber: 55,
      staged: false,
      state: "open",
      reviewState: "in_review",
      patchCycles: 0,
      reviewCycles: 0,
      blocked: true,
      blockedReason: "CI failing",
    };
    const mockTasks = [
      {
        id: "task-pr-blocked",
        title: "PR is blocked",
        status: "pr_open",
        session: "session-pr-blocked",
        repo: "example-org/example-repo",
        assignee: null,
        claimedBy: null,
        pr: 55,
        prUrl: "https://github.com/example-org/example-repo/pull/55",
        updatedAt: "2026-09-03T00:00:00.000Z",
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 500,
          offset: 0,
        }),
        fetchTaskStorePrs: async () => ({
          prs: [PR_BLOCKED],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/sessions/session-pr-blocked", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Needs you");
    expect(html).toContain("PR blocked");
    expect(html).toContain("CI failing");
    expect(html).toContain(
      'href="https://github.com/example-org/example-repo/pull/55"',
    );
    expect(html).toContain("/shipwright:unblock task-pr-blocked");
  });

  it("a non-waiting session (all active/closed) shows no Needs-you panel and no Waiting header state", async () => {
    const mockTasks = [
      {
        id: "task-active",
        title: "In progress work",
        status: "in_progress",
        session: "session-active",
        repo: "example-org/example-repo",
        assignee: null,
        claimedBy: null,
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "task-done",
        title: "Finished work",
        status: "done",
        session: "session-active",
        repo: "example-org/example-repo",
        assignee: null,
        claimedBy: null,
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/sessions/session-active", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Needs you");
    expect(html).not.toContain("Waiting since");
  });

  it("GET /admin/sessions/:id unauthenticated redirects to /admin/login", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/sessions/session-abc", {
      headers: { "Sec-Fetch-Mode": "navigate" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/login?returnTo=${encodeURIComponent("/admin/sessions/session-abc")}`,
    );
  });

  it("unauthenticated non-navigation request to /admin/sessions/session-abc returns 401 signed_out", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/sessions/session-abc");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
  });

  it("GET /admin/sessions/:id degrades gracefully when fetchTaskStoreTasks is not configured", async () => {
    const app = createCodingTestApp(makeCodingMockDeps({}));
    const res = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Task store unavailable");
  });

  // ─── Admin actions: flash banner + admin gating at the route (SESH-5.2) ───
  //
  // registerSessionAdminActionsRoutes()'s own smoke tests (in
  // admin-ui-session-admin-actions.smoke.test.ts) verify the POST routes
  // redirect with ?success=/?error=; renderSessionDetailPage()'s own unit
  // tests (in admin-ui-pages.unit.test.ts) verify the render function hides
  // the forms when isAdmin is false. Neither exercises this GET route's own
  // query-param-to-notice mapping or its c.var.isAdmin passthrough — both are
  // route-level glue, so they're covered here instead.

  it("GET /admin/sessions/:id?success=archived renders the success flash banner", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const res = await app.request(
      "/admin/sessions/session-abc?success=archived",
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="alert alert-success"');
    expect(html).toContain("Session archived.");
  });

  it("GET /admin/sessions/:id?error=rename_failed renders the error flash banner", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const res = await app.request(
      "/admin/sessions/session-abc?error=rename_failed",
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="alert alert-error"');
    expect(html).toContain("Failed to rename the session.");
  });

  it("GET /admin/sessions/:id as admin includes the archive/unarchive/rename controls", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/admin/sessions/session-abc/archive"');
    expect(html).toContain('action="/admin/sessions/session-abc/unarchive"');
    expect(html).toContain('action="/admin/sessions/session-abc/rename"');
  });

  it("GET /admin/sessions/:id as a visible member never renders the archive/unarchive/rename controls", async () => {
    const memberEmail = "member-no-admin-actions@example.com";
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member-no-admin-actions",
      memberEmail,
      false,
    );
    const mockTasks = [
      {
        id: "task-1",
        title: "Build auth module",
        status: "pending",
        session: "session-member-visible",
        repo: "example-org/example-repo",
        assignee: AGENT_ID,
        claimedBy: null,
      },
    ];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentMemberService: {
          listByEmail: async (email: string) =>
            email === memberEmail
              ? [
                  {
                    id: "m1",
                    agentId: AGENT_ID,
                    email: memberEmail,
                    createdAt: new Date("2024-01-01"),
                  },
                ]
              : [],
          exists: async () => false,
          add: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: memberEmail,
            createdAt: new Date(),
          }),
          remove: async () => {},
          listByAgentId: async () => [],
        },
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/sessions/session-member-visible", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(
      "/admin/sessions/session-member-visible/archive",
    );
    expect(html).not.toContain(
      "/admin/sessions/session-member-visible/unarchive",
    );
    expect(html).not.toContain("/admin/sessions/session-member-visible/rename");
  });

  // SESH-4.2: the flat `if (!isAdmin) 403` gate is replaced by a
  // session-scope.ts-based visibility check derived from the session's own
  // tasks (assignee/claimedBy → agentIds, repo → repos). This is an
  // intentional behavior change, not a regression — a member can now reach
  // a session detail page they're scoped to see, and is 404'd (not 403'd)
  // on one they aren't.
  describe("GET /admin/sessions/:id — member scope gate (SESH-4.2)", () => {
    const MEMBER_EMAIL = "member@example.com";

    it("a member sees a session detail page when one of its tasks is assigned to their agent", async () => {
      const memberCookie = await makeSessionCookie(
        SESSION_SECRET,
        "google-sub-member",
        MEMBER_EMAIL,
        false,
      );
      const mockTasks = [
        {
          id: "task-1",
          title: "Build auth module",
          status: "pending",
          session: "session-visible",
          repo: "example-org/example-repo",
          assignee: AGENT_ID,
          claimedBy: null,
        },
      ];
      const app = createCodingTestApp(
        makeCodingMockDeps({
          agentMemberService: {
            listByEmail: async (email: string) =>
              email === MEMBER_EMAIL
                ? [
                    {
                      id: "m1",
                      agentId: AGENT_ID,
                      email: MEMBER_EMAIL,
                      createdAt: new Date("2024-01-01"),
                    },
                  ]
                : [],
            exists: async () => false,
            add: async () => ({
              id: "m1",
              agentId: AGENT_ID,
              email: MEMBER_EMAIL,
              createdAt: new Date(),
            }),
            remove: async () => {},
            listByAgentId: async () => [],
          },
          fetchTaskStoreTasks: async () => ({
            tasks: mockTasks,
            total: mockTasks.length,
            limit: 500,
            offset: 0,
          }),
        }),
      );
      const res = await app.request("/admin/sessions/session-visible", {
        headers: { Cookie: `admin_session=${memberCookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Build auth module");
    });

    it("a member gets 404 (not 403) on a session none of whose tasks belong to their agent or repos", async () => {
      const memberCookie = await makeSessionCookie(
        SESSION_SECRET,
        "google-sub-member",
        MEMBER_EMAIL,
        false,
      );
      const mockTasks = [
        {
          id: "task-1",
          title: "Someone else's task",
          status: "pending",
          session: "session-hidden",
          repo: "other-org/other-repo",
          assignee: "agent-other",
          claimedBy: null,
        },
      ];
      const app = createCodingTestApp(
        makeCodingMockDeps({
          agentMemberService: {
            listByEmail: async (email: string) =>
              email === MEMBER_EMAIL
                ? [
                    {
                      id: "m1",
                      agentId: AGENT_ID,
                      email: MEMBER_EMAIL,
                      createdAt: new Date("2024-01-01"),
                    },
                  ]
                : [],
            exists: async () => false,
            add: async () => ({
              id: "m1",
              agentId: AGENT_ID,
              email: MEMBER_EMAIL,
              createdAt: new Date(),
            }),
            remove: async () => {},
            listByAgentId: async () => [],
          },
          agentService: {
            listAll: async () => [],
            listByIds: async () => [
              {
                id: AGENT_ID,
                name: "Test Agent",
                slackId: null,
                selfHosted: false,
                specialty: "coding",
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: ["example-org/example-repo"],
              },
            ],
            searchByName: async () => [],
            listOptions: async () => [],
            create: async () => {
              throw new Error("not used");
            },
            delete: async () => {},
            getDetail: async () => {
              throw new Error("not used");
            },
            updateFields: async () => {
              throw new Error("not used");
            },
          },
          fetchTaskStoreTasks: async () => ({
            tasks: mockTasks,
            total: mockTasks.length,
            limit: 500,
            offset: 0,
          }),
        }),
      );
      const res = await app.request("/admin/sessions/session-hidden", {
        headers: { Cookie: `admin_session=${memberCookie}` },
      });
      expect(res.status).toBe(404);
    });

    it("a member with zero memberships gets 404 on any session", async () => {
      const outsiderCookie = await makeSessionCookie(
        SESSION_SECRET,
        "google-sub-outsider",
        "outsider@example.com",
        false,
      );
      const mockTasks = [
        {
          id: "task-1",
          title: "Some task",
          status: "pending",
          session: "session-abc",
          repo: "example-org/example-repo",
          assignee: AGENT_ID,
          claimedBy: null,
        },
      ];
      const app = createCodingTestApp(
        makeCodingMockDeps({
          fetchTaskStoreTasks: async () => ({
            tasks: mockTasks,
            total: mockTasks.length,
            limit: 500,
            offset: 0,
          }),
        }),
      );
      const res = await app.request("/admin/sessions/session-abc", {
        headers: { Cookie: `admin_session=${outsiderCookie}` },
      });
      expect(res.status).toBe(404);
    });

    it("admin still sees any session detail page regardless of scope", async () => {
      const mockTasks = [
        {
          id: "task-1",
          title: "Some task",
          status: "pending",
          session: "session-abc",
          repo: "example-org/example-repo",
          assignee: "agent-other",
          claimedBy: null,
        },
      ];
      const app = createCodingTestApp(
        makeCodingMockDeps({
          fetchTaskStoreTasks: async () => ({
            tasks: mockTasks,
            total: mockTasks.length,
            limit: 500,
            offset: 0,
          }),
        }),
      );
      const res = await app.request("/admin/sessions/session-abc", {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
    });

    // The derived agentIds must follow the task-store rollup's precedence
    // (`claimedBy ?? assignee` — one id per task, claimedBy wins), not the
    // union of both fields: after a reassignment the old assignee's members
    // must lose access, matching what the list page hides.
    it("a reassigned task (claimedBy wins over assignee) 404s the old assignee's member", async () => {
      const memberCookie = await makeSessionCookie(
        SESSION_SECRET,
        "google-sub-member",
        MEMBER_EMAIL,
        false,
      );
      const mockTasks = [
        {
          id: "task-1",
          title: "Reassigned task",
          status: "pending",
          session: "session-reassigned",
          repo: "other-org/other-repo",
          // AGENT_ID was the original assignee; the task has since been
          // claimed by a different agent, so the rollup reports only
          // "agent-other".
          assignee: AGENT_ID,
          claimedBy: "agent-other",
        },
      ];
      const app = createCodingTestApp(
        makeCodingMockDeps({
          agentMemberService: {
            listByEmail: async (email: string) =>
              email === MEMBER_EMAIL
                ? [
                    {
                      id: "m1",
                      agentId: AGENT_ID,
                      email: MEMBER_EMAIL,
                      createdAt: new Date("2024-01-01"),
                    },
                  ]
                : [],
            exists: async () => false,
            add: async () => ({
              id: "m1",
              agentId: AGENT_ID,
              email: MEMBER_EMAIL,
              createdAt: new Date(),
            }),
            remove: async () => {},
            listByAgentId: async () => [],
          },
          agentService: {
            listAll: async () => [],
            listByIds: async () => [
              {
                id: AGENT_ID,
                name: "Test Agent",
                slackId: null,
                selfHosted: false,
                specialty: "coding",
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: ["example-org/example-repo"],
              },
            ],
            searchByName: async () => [],
            listOptions: async () => [],
            create: async () => {
              throw new Error("not used");
            },
            delete: async () => {},
            getDetail: async () => {
              throw new Error("not used");
            },
            updateFields: async () => {
              throw new Error("not used");
            },
          },
          fetchTaskStoreTasks: async () => ({
            tasks: mockTasks,
            total: mockTasks.length,
            limit: 500,
            offset: 0,
          }),
        }),
      );
      const res = await app.request("/admin/sessions/session-reassigned", {
        headers: { Cookie: `admin_session=${memberCookie}` },
      });
      expect(res.status).toBe(404);
    });

    // Degraded mode: tasks can't be fetched, so scope can't be verified
    // either way. Like every other degraded-mode route, render 200 with the
    // "unavailable" banner rather than 404ing legitimate members.
    it("degrades to 200 + banner for a member (not 404) when fetchTaskStoreTasks is absent", async () => {
      const memberCookie = await makeSessionCookie(
        SESSION_SECRET,
        "google-sub-member",
        MEMBER_EMAIL,
        false,
      );
      const app = createCodingTestApp(makeCodingMockDeps({}));
      const res = await app.request("/admin/sessions/session-abc", {
        headers: { Cookie: `admin_session=${memberCookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Task store unavailable");
    });

    it("degrades to 200 + banner for a member (not 404) when fetchTaskStoreTasks throws", async () => {
      const memberCookie = await makeSessionCookie(
        SESSION_SECRET,
        "google-sub-member",
        MEMBER_EMAIL,
        false,
      );
      const app = createCodingTestApp(
        makeCodingMockDeps({
          fetchTaskStoreTasks: async () => {
            throw new Error("task store down");
          },
        }),
      );
      const res = await app.request("/admin/sessions/session-abc", {
        headers: { Cookie: `admin_session=${memberCookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Task store unavailable");
    });
  });

  // AC4/AC5: full round-trip — tasks list (with filters/page) → Session Detail
  // → back link returns to the exact originating list URL.
  it("round-trip: tasks list → Session Detail → back link returns to the originating list view", async () => {
    const mockTasks = [
      {
        id: "task-1",
        title: "Build auth module",
        status: "in_progress",
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
          offset: 0,
        }),
      }),
    );
    const listRes = await app.request(
      "/admin/tasks?status=in_progress&page=2",
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(listRes.status).toBe(200);
    const listHtml = await listRes.text();
    const match = listHtml.match(
      /<a href="(\/admin\/sessions\/session-abc\?from=[^"]+)"/,
    );
    expect(match).not.toBeNull();
    const sessionHref = (match as RegExpMatchArray)[1].replace(/&amp;/g, "&");

    const sessionRes = await app.request(sessionHref, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(sessionRes.status).toBe(200);
    const sessionHtml = await sessionRes.text();
    expect(sessionHtml).toContain(
      `<a href="/admin/tasks?status=in_progress&amp;page=2" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  // AC4/AC5: full round-trip — Task Detail → Session Detail → back link
  // returns to the originating task detail page.
  it("round-trip: Task Detail → Session Detail → back link returns to the originating task detail page", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      session: "session-abc",
      repo: "org/repo",
    };
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const taskRes = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(taskRes.status).toBe(200);
    const taskHtml = await taskRes.text();
    const match = taskHtml.match(
      /<a href="(\/admin\/sessions\/session-abc\?from=[^"]+)"/,
    );
    expect(match).not.toBeNull();
    const sessionHref = (match as RegExpMatchArray)[1].replace(/&amp;/g, "&");

    const sessionRes = await app.request(sessionHref, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(sessionRes.status).toBe(200);
    const sessionHtml = await sessionRes.text();
    expect(sessionHtml).toContain(
      `<a href="/admin/tasks/task-42" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  // ─── Follow/unfollow button (SESH-5.3) ─────────────────────────────────────

  it("renders the Follow button when the current user does not follow the session", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
        fetchIsFollowingSession: async () => false,
      }),
    );
    const res = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-following="false"');
    expect(html).toContain(">Follow<");
    expect(html).not.toContain(">Following<");
  });

  it("renders the Following button when the current user already follows the session", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
        fetchIsFollowingSession: async () => true,
      }),
    );
    const res = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-following="true"');
    expect(html).toContain(">Following<");
  });

  it("falls back to a default 'Follow' state without throwing when fetchIsFollowingSession is absent", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-following="false"');
  });

  it("toggles follow/unfollow via the real routes and the detail page re-renders the button state before/after", async () => {
    // A minimal stateful double for the sessionFollow/sessionAlertState
    // Prisma models — exercises the real POST /admin/sessions/:slug/follow
    // and /unfollow routes (SESH-6.2, unmodified by this task) plus this
    // task's fetchIsFollowingSession fallback resolver end to end, rather
    // than asserting each rendered state in isolation.
    const followedSlugs = new Set<string>();
    const deps = makeCodingMockDeps({
      fetchTaskStoreTasks: async () => ({
        tasks: [],
        total: 0,
        limit: 500,
        offset: 0,
      }),
    });
    const prismaWithSessionFollow = deps.prisma as unknown as {
      sessionFollow: {
        upsert: (args: {
          where: {
            userEmail_sessionSlug: { userEmail: string; sessionSlug: string };
          };
        }) => Promise<{
          id: string;
          userEmail: string;
          sessionSlug: string;
          muted: boolean;
          createdAt: Date;
          updatedAt: Date;
        }>;
        deleteMany: (args: {
          where: { sessionSlug: string };
        }) => Promise<{ count: number }>;
        findMany: (args: { where: { userEmail: string } }) => Promise<
          Array<{
            id: string;
            userEmail: string;
            sessionSlug: string;
            muted: boolean;
            createdAt: Date;
            updatedAt: Date;
          }>
        >;
      };
      sessionAlertState: { deleteMany: () => Promise<{ count: number }> };
    };
    prismaWithSessionFollow.sessionFollow = {
      upsert: async ({ where }) => {
        const slug = where.userEmail_sessionSlug.sessionSlug;
        followedSlugs.add(slug);
        return {
          id: `follow-${slug}`,
          userEmail: where.userEmail_sessionSlug.userEmail,
          sessionSlug: slug,
          muted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        };
      },
      deleteMany: async ({ where }) => {
        const existed = followedSlugs.delete(where.sessionSlug);
        return { count: existed ? 1 : 0 };
      },
      findMany: async ({ where }) =>
        [...followedSlugs].map((slug) => ({
          id: `follow-${slug}`,
          userEmail: where.userEmail,
          sessionSlug: slug,
          muted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        })),
    };
    prismaWithSessionFollow.sessionAlertState = {
      deleteMany: async () => ({ count: 0 }),
    };
    const app = createCodingTestApp(deps);

    const before = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(before.status).toBe(200);
    const beforeHtml = await before.text();
    expect(beforeHtml).toContain('data-following="false"');
    expect(beforeHtml).toContain(">Follow<");

    const followRes = await app.request("/admin/sessions/session-abc/follow", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(followRes.status).toBe(200);
    expect(await followRes.json()).toEqual({
      sessionSlug: "session-abc",
      following: true,
    });

    const after = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const afterHtml = await after.text();
    expect(afterHtml).toContain('data-following="true"');
    expect(afterHtml).toContain(">Following<");

    const unfollowRes = await app.request(
      "/admin/sessions/session-abc/unfollow",
      { method: "POST", headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(unfollowRes.status).toBe(200);
    expect(await unfollowRes.json()).toEqual({
      sessionSlug: "session-abc",
      following: false,
    });

    const afterUnfollow = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const afterUnfollowHtml = await afterUnfollow.text();
    expect(afterUnfollowHtml).toContain('data-following="false"');
    expect(afterUnfollowHtml).toContain(">Follow<");
  });
});

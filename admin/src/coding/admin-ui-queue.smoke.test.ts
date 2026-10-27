/**
 * admin/src/coding/admin-ui-queue.smoke.test.ts
 * Smoke tests for the coding extension's Queue & Activity routes (admin-ui-coding.ts),
 * composed with the platform admin UI as startAdmin() does. Relocated from
 * admin-ui.smoke.test.ts (AEP-3.2).
 *
 * Uses app.request() — no real server, no real DB.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
  AGENT_ID,
  CRON_ID,
  MOCK_CRON,
  makeSessionCookie,
  SESSION_SECRET,
} from "@app-vitals/agent-admin/admin-ui.fixtures";
import {
  createCodingTestApp,
  makeCodingMockDeps,
} from "./admin-ui-coding.fixtures.ts";

describe("admin UI — unauthenticated redirects", () => {
  it("unauthenticated GET /admin/agents/:id/queue-activity redirects to /admin/login", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { "Sec-Fetch-Mode": "navigate" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/login?returnTo=${encodeURIComponent(`/admin/agents/${AGENT_ID}/queue-activity`)}`,
    );
  });

  it("unauthenticated non-navigation request to /admin/agents/:id/queue-activity returns 401 signed_out", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
  });
});

describe("admin UI — authenticated pages", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("authenticated GET /admin/agents/:id/queue-activity returns 200 with empty Upcoming and Past state", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Outcome");
    expect(html).toContain("Started");
    expect(html).toContain("Duration");
    // empty states by default in the base mock — no snapshot pushed, no runs
    expect(html).toContain("No runs");
    expect(html).toContain("No work queue snapshot");
    expect(html).not.toContain("Last computed");
  });

  it("authenticated GET /admin/agents/:id/queue-activity fetches the caller's accessible-agents list and renders it as the selector's options (AXR-3.4)", async () => {
    const OTHER_AGENT_ID = "agent-other-456";
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentService: {
          listAll: async () => [
            {
              id: AGENT_ID,
              name: "Test Agent",
              slackId: "U1",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
            {
              id: OTHER_AGENT_ID,
              name: "Other Agent",
              slackId: "U2",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
          ],
          listByIds: async () => [],
          searchByName: async () => [],
          listOptions: async () => [],
          create: async () => {
            throw new Error("not implemented");
          },
          delete: async () => {},
          getDetail: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
            reviewAuthorAllowlist: [],
            patchAuthorAllowlist: [],
            restrictSlackToMembers: false,
            missingRequiredEnv: [],
          }),
          updateFields: async () => {
            throw new Error("not implemented");
          },
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The caller (admin) sees the full fleet, with the currently-viewed agent pre-selected.
    expect(html).toContain(
      `<option value="${AGENT_ID}" selected>Test Agent</option>`,
    );
    expect(html).toContain(
      `<option value="${OTHER_AGENT_ID}">Other Agent</option>`,
    );
    // The dropdown also offers a round trip back to the merged multi-agent
    // view (AAV-2) via a sentinel option value.
    expect(html).toContain('<option value="__all__">All agents</option>');
  });

  it("authenticated GET /admin/agents/:id/queue-activity renders the Upcoming section above the Past section", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentWorkQueueService: {
          get: async () => ({
            id: "snap-1",
            agentId: AGENT_ID,
            computedAt: new Date("2026-06-01T10:00:00Z"),
            items: [
              {
                type: "task",
                id: "WLS-2.2",
                title: "Add work queue snapshot endpoints",
                phase: "dev-task",
                age: "2026-06-01T09:00:00Z",
              },
            ],
            createdAt: new Date("2026-06-01T10:00:00Z"),
          }),
          getMany: async () => [],
        },
        agentCronRunService: {
          listForAgent: async () => ({
            items: [makeCronRun()],
            total: 1,
            limit: 20,
            offset: 0,
          }),
          listAcrossAgents: async () => ({
            items: [],
            total: 0,
            limit: 20,
            offset: 0,
          }),
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const upcomingIndex = html.indexOf("WLS-2.2");
    const pastIndex = html.indexOf("posted");
    expect(upcomingIndex).toBeGreaterThan(-1);
    expect(pastIndex).toBeGreaterThan(-1);
    expect(upcomingIndex).toBeLessThan(pastIndex);
  });

  function makeCronRun(
    overrides?: Partial<{
      id: string;
      cronId: string;
      startedAt: Date;
      completedAt: Date | null;
      skipped: boolean;
      skipReason: string | null;
      outcome: string | null;
      error: string | null;
      phaseId: string | null;
      phaseCron: { id: string; name: string | null } | null;
      modelBreakdown: {
        id: string;
        cronRunId: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        costUsd: number;
      }[];
    }>,
  ) {
    return {
      id: "run-1",
      cronId: CRON_ID,
      agentId: AGENT_ID,
      startedAt: new Date("2026-06-01T10:00:00Z"),
      completedAt: new Date("2026-06-01T10:00:03Z"),
      skipped: false,
      skipReason: null,
      outcome: "posted",
      error: null,
      itemType: null,
      itemId: null,
      commandVariant: null,
      sessionId: null,
      lastHeartbeatAt: null,
      baselineModel: null,
      baselineContextTokens: null,
      baselineInputTokens: null,
      baselineCacheCreationTokens: null,
      baselineCacheReadTokens: null,
      turns: null,
      toolCalls: null,
      contextFingerprint: null,
      pluginVersion: null,
      claudeCodeVersion: null,
      phaseId: null,
      phaseCron: null,
      createdAt: new Date("2026-06-01T10:00:00Z"),
      modelBreakdown: [] as {
        id: string;
        cronRunId: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        costUsd: number;
      }[],
      cron: MOCK_CRON,
      ...overrides,
    };
  }

  it("authenticated GET /admin/agents/:id/queue-activity renders populated runs in the Past section", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        // AXR-3.2: only shipwright-loop crons stay visible in the primary
        // table by default — override the cron list so this run's owning
        // cron classifies as visible instead of collapsing into a <details>.
        agentCronJobService: {
          list: async () => [{ ...MOCK_CRON, name: "shipwright-loop" }],
          listWithRunSummary: async () => [
            {
              ...MOCK_CRON,
              name: "shipwright-loop",
              lastRun: null,
              runCountToday: 0,
            },
          ],
          get: async () => MOCK_CRON,
          create: async () => MOCK_CRON,
          setEnabled: async () => MOCK_CRON,
          update: async () => MOCK_CRON,
          delete: async () => {},
          reconcileSystemCrons: async () => ({
            created: 0,
            updated: 0,
            deleted: 0,
          }),
        },
        agentCronRunService: {
          listForAgent: async () => ({
            items: [makeCronRun()],
            total: 1,
            limit: 20,
            offset: 0,
          }),
          listAcrossAgents: async () => ({
            items: [],
            total: 0,
            limit: 20,
            offset: 0,
          }),
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("posted");
    expect(html).not.toContain("No runs");
  });

  it("authenticated GET /admin/agents/:id/queue-activity renders populated Upcoming snapshot", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentWorkQueueService: {
          get: async () => ({
            id: "snap-1",
            agentId: AGENT_ID,
            computedAt: new Date("2026-06-01T10:00:00Z"),
            items: [
              {
                type: "task",
                id: "WLS-2.2",
                title: "Add work queue snapshot endpoints",
                phase: "dev-task",
                age: "2026-06-01T09:00:00Z",
              },
              {
                type: "pr",
                id: "PR-42",
                title: "Fix flaky test",
                phase: "review",
                age: "2026-06-01T08:00:00Z",
              },
            ],
            createdAt: new Date("2026-06-01T10:00:00Z"),
          }),
          getMany: async () => [],
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Last computed");
    expect(html).toContain("WLS-2.2");
    expect(html).toContain("Add work queue snapshot endpoints");
    expect(html).toContain("PR-42");
    expect(html).toContain("dev-task");
    expect(html).toContain("review");
    expect(html).not.toContain("No work queue snapshot");
    // task item links to its admin task detail page
    expect(html).toContain('<a href="/admin/tasks/WLS-2.2"');
  });

  it("queue-activity Upcoming PR item links out to GitHub using the repo#prNumber id", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentWorkQueueService: {
          get: async () => ({
            id: "snap-2",
            agentId: AGENT_ID,
            computedAt: new Date("2026-06-01T10:00:00Z"),
            items: [
              {
                type: "pr",
                id: "app-vitals/shipwright#4321",
                title: "Fix flaky test",
                phase: "review",
                age: "2026-06-01T08:00:00Z",
              },
            ],
            createdAt: new Date("2026-06-01T10:00:00Z"),
          }),
          getMany: async () => [],
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      '<a href="https://github.com/app-vitals/shipwright/pull/4321"',
    );
  });

  it("authenticated GET /admin/agents/:id/queue-activity?cronId=... filters the Past section by cronId", async () => {
    let capturedOpts: unknown;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentCronRunService: {
          listForAgent: async (_agentId: string, opts?: unknown) => {
            capturedOpts = opts;
            return {
              items: [makeCronRun()],
              total: 1,
              limit: 20,
              offset: 0,
            };
          },
          listAcrossAgents: async () => ({
            items: [],
            total: 0,
            limit: 20,
            offset: 0,
          }),
        },
      }),
    );
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/queue-activity?cronId=${CRON_ID}`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(capturedOpts).toMatchObject({ cronId: CRON_ID });
    const html = await res.text();
    // Selected cron option should carry `selected`.
    const optionMatch = html.match(
      new RegExp(`<option value="${CRON_ID}"[^>]*>`),
    );
    expect(optionMatch).not.toBeNull();
    expect(optionMatch?.[0]).toContain("selected");
  });

  it("authenticated GET /admin/agents/:id/queue-activity?outcome=... filters the Past section by outcome", async () => {
    let capturedOpts: unknown;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentCronRunService: {
          listForAgent: async (_agentId: string, opts?: unknown) => {
            capturedOpts = opts;
            return {
              items: [makeCronRun({ outcome: "error" })],
              total: 1,
              limit: 20,
              offset: 0,
            };
          },
          listAcrossAgents: async () => ({
            items: [],
            total: 0,
            limit: 20,
            offset: 0,
          }),
        },
      }),
    );
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/queue-activity?outcome=error`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(capturedOpts).toMatchObject({ outcome: "error" });
  });

  it("authenticated GET /admin/agents/:id/queue-activity?outcome=skipped passes the skipped special-case outcome through", async () => {
    let capturedOpts: unknown;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentCronRunService: {
          listForAgent: async (_agentId: string, opts?: unknown) => {
            capturedOpts = opts;
            return {
              items: [
                makeCronRun({
                  skipped: true,
                  outcome: null,
                  skipReason: "pre-check failed",
                }),
              ],
              total: 1,
              limit: 20,
              offset: 0,
            };
          },
          listAcrossAgents: async () => ({
            items: [],
            total: 0,
            limit: 20,
            offset: 0,
          }),
        },
      }),
    );
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/queue-activity?outcome=skipped`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(capturedOpts).toMatchObject({ outcome: "skipped" });
    const html = await res.text();
    expect(html).toContain("skipped");
  });

  it("non-admin non-member gets 403 on GET /admin/agents/:id/queue-activity", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${outsiderCookie}` },
    });
    expect(res.status).toBe(403);
  });

  it("GET /admin/agents/:id/queue-activity returns 404 when agent not found", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentService: {
          ...makeCodingMockDeps().agentService,
          getDetail: async () => null,
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(404);
  });
});

// ─── Merged fleet-wide queue-activity view (AAV-2.1) ─────────────────────────
// Supersedes the former AXR-3.3 default-agent redirect: GET /admin/queue-activity
// now renders the merged cross-agent view directly instead of bouncing to the
// first accessible agent's own queue-activity page.

describe("admin UI — GET /admin/queue-activity (merged fleet-wide view)", () => {
  it("unauthenticated GET /admin/queue-activity redirects to /admin/login", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/queue-activity", {
      headers: { "Sec-Fetch-Mode": "navigate" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/login?returnTo=${encodeURIComponent("/admin/queue-activity")}`,
    );
  });

  it("unauthenticated non-navigation request to /admin/queue-activity returns 401 signed_out", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/queue-activity");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
  });

  it("admin sees the merged view rendered directly, not a redirect (full fleet)", async () => {
    const adminCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-admin",
      "admin@example.com",
      true,
    );
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request("/admin/queue-activity", {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      "<title>Queue &amp; Activity — All Agents — Shipwright Admin</title>",
    );
    // "All agents" is pre-selected on the merged view's own selector.
    expect(html).toContain(
      '<option value="__all__" selected>All agents</option>',
    );
    expect(html).toContain(`<option value="${AGENT_ID}">Test Agent</option>`);
  });

  it("non-admin AgentMember sees the merged view scoped to their accessible agents only", async () => {
    const MEMBER_EMAIL = "member@example.com";
    const OTHER_AGENT_ID = "agent-other-456";
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      MEMBER_EMAIL,
      false,
    );
    const deps = makeCodingMockDeps({
      agentMemberService: {
        listByEmail: async (email: string) =>
          email === MEMBER_EMAIL
            ? [
                {
                  id: "m1",
                  agentId: AGENT_ID,
                  email: MEMBER_EMAIL,
                  createdAt: new Date(),
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
        listAll: async () => [
          {
            id: AGENT_ID,
            name: "My Agent",
            slackId: "U1",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
          {
            id: OTHER_AGENT_ID,
            name: "Other Agent",
            slackId: "U2",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
        ],
        listByIds: async (ids: string[]) =>
          [
            {
              id: AGENT_ID,
              name: "My Agent",
              slackId: "U1",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
            {
              id: OTHER_AGENT_ID,
              name: "Other Agent",
              slackId: "U2",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
          ].filter((a) => ids.includes(a.id)),
        searchByName: async () => [],
        listOptions: async () => [
          { id: AGENT_ID, name: "My Agent" },
          { id: OTHER_AGENT_ID, name: "Other Agent" },
        ],
        create: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {},
        getDetail: async () => null,
        updateFields: async () => {
          throw new Error("not implemented");
        },
      },
    });
    const app = createCodingTestApp(deps);
    const res = await app.request("/admin/queue-activity", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Only the member's own accessible agent appears in the selector — the
    // inaccessible fleet-wide "Other Agent" is never rendered.
    expect(html).toContain('<option value="agent-test-123">My Agent</option>');
    expect(html).not.toContain("Other Agent");
  });

  it("non-admin with zero accessible agents is redirected to /admin/agents instead of a queue-activity page", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const deps = makeCodingMockDeps({
      agentMemberService: {
        listByEmail: async () => [],
        exists: async () => false,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: "member@example.com",
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
      },
      agentService: {
        listAll: async () => [],
        listByIds: async () => [],
        searchByName: async () => [],
        listOptions: async () => [],
        create: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {},
        getDetail: async () => null,
        updateFields: async () => {
          throw new Error("not implemented");
        },
      },
    });
    const app = createCodingTestApp(deps);
    const res = await app.request("/admin/queue-activity", {
      headers: { Cookie: `admin_session=${outsiderCookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents");
  });

  it("multi-agent fixture: renders the Agent, Eligible agents, and Queued by columns with expected content (AAV-2.1)", async () => {
    const ALPHA_ID = "agent-alpha";
    const BETA_ID = "agent-beta";
    const adminCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-admin",
      "admin@example.com",
      true,
    );
    const makeAgent = (id: string, name: string) => ({
      id,
      name,
      slackId: null,
      selfHosted: false,
      typeName: "coding",
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    });
    const deps = makeCodingMockDeps({
      agentService: {
        listAll: async () => [
          {
            ...makeAgent(ALPHA_ID, "Alpha Agent"),
            repos: ["app-vitals/shipwright"],
          },
          {
            ...makeAgent(BETA_ID, "Beta Agent"),
            repos: ["app-vitals/shipwright", "app-vitals/other-repo"],
          },
        ],
        listByIds: async () => [],
        searchByName: async () => [],
        listOptions: async () => [],
        create: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {},
        getDetail: async () => null,
        updateFields: async () => {
          throw new Error("not implemented");
        },
      },
      agentWorkQueueService: {
        get: async () => null,
        getMany: async () => [
          {
            id: "snap-alpha",
            agentId: ALPHA_ID,
            computedAt: new Date("2026-06-01T10:00:00Z"),
            items: [
              {
                type: "pr",
                id: "app-vitals/shipwright#100",
                title: "Shared PR",
                phase: "review",
                age: "2026-06-01T08:00:00Z",
              },
            ],
            createdAt: new Date("2026-06-01T10:00:00Z"),
          },
          {
            id: "snap-beta",
            agentId: BETA_ID,
            computedAt: new Date("2026-06-01T10:00:00Z"),
            items: [
              {
                type: "pr",
                id: "app-vitals/shipwright#100",
                title: "Shared PR",
                phase: "review",
                age: "2026-06-01T08:00:00Z",
              },
              {
                type: "pr",
                id: "app-vitals/other-repo#5",
                title: "Beta-only PR",
                phase: "patch",
                age: "2026-06-01T07:00:00Z",
              },
            ],
            createdAt: new Date("2026-06-01T10:00:00Z"),
          },
        ],
      },
      agentCronRunService: {
        listForAgent: async () => ({
          items: [],
          total: 0,
          limit: 20,
          offset: 0,
        }),
        listAcrossAgents: async () => ({
          items: [
            {
              id: "run-alpha",
              cronId: "cron-alpha",
              agentId: ALPHA_ID,
              startedAt: new Date("2026-06-01T10:00:00Z"),
              completedAt: new Date("2026-06-01T10:00:03Z"),
              skipped: false,
              skipReason: null,
              outcome: "posted",
              error: null,
              itemType: null,
              itemId: null,
              commandVariant: null,
              sessionId: null,
              lastHeartbeatAt: null,
              baselineModel: null,
              baselineContextTokens: null,
              baselineInputTokens: null,
              baselineCacheCreationTokens: null,
              baselineCacheReadTokens: null,
              turns: null,
              toolCalls: null,
              contextFingerprint: null,
              pluginVersion: null,
              claudeCodeVersion: null,
              phaseId: null,
              phaseCron: null,
              createdAt: new Date("2026-06-01T10:00:00Z"),
              modelBreakdown: [],
              cron: {
                id: "cron-alpha",
                name: "shipwright-loop",
                schedule: "*/5 * * * *",
              },
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      },
    });
    const app = createCodingTestApp(deps);
    const res = await app.request("/admin/queue-activity", {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    // Merged cron-run table's Agent column (AC2).
    expect(html).toContain("<th>Agent</th>");
    expect(html).toContain(
      '<a href="/admin/agents/agent-alpha" style="color:#6366f1;text-decoration:none">Alpha Agent</a>',
    );

    // Merged work-queue table's Eligible agents / Queued by columns (AC3).
    expect(html).toContain("<th>Eligible agents</th>");
    expect(html).toContain("<th>Queued by</th>");

    // Deduped shared PR: queued by both agents, eligible on both (both list
    // "app-vitals/shipwright" in repos) — exactly one row, not two.
    expect(html.match(/app-vitals\/shipwright#100/g)?.length).toBe(1);

    // Beta-only PR: queued only by Beta, eligible only for Beta (only Beta
    // lists "app-vitals/other-repo").
    const betaOnlyRowIndex = html.indexOf("app-vitals/other-repo#5");
    expect(betaOnlyRowIndex).toBeGreaterThan(-1);
    const betaOnlyRowEnd = html.indexOf("</tr>", betaOnlyRowIndex);
    const betaOnlyRowHtml = html.slice(betaOnlyRowIndex, betaOnlyRowEnd);
    expect(betaOnlyRowHtml).toContain("Beta Agent");
    expect(betaOnlyRowHtml).not.toContain("Alpha Agent");
  });

  it("Eligible agents cell excludes an agent with no shipwright-loop cron row even though it lists the item's repo (QAE-1.2)", async () => {
    const ALPHA_ID = "agent-alpha";
    const BETA_ID = "agent-beta";
    const adminCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-admin",
      "admin@example.com",
      true,
    );
    const makeAgent = (id: string, name: string) => ({
      id,
      name,
      slackId: null,
      selfHosted: false,
      typeName: "coding",
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    });
    const deps = makeCodingMockDeps({
      agentService: {
        listAll: async () => [
          {
            ...makeAgent(ALPHA_ID, "Alpha Agent"),
            repos: ["app-vitals/shipwright"],
          },
          {
            ...makeAgent(BETA_ID, "Beta Agent"),
            repos: ["app-vitals/shipwright"],
          },
        ],
        listByIds: async () => [],
        searchByName: async () => [],
        listOptions: async () => [],
        create: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {},
        getDetail: async () => null,
        updateFields: async () => {
          throw new Error("not implemented");
        },
      },
      agentWorkQueueService: {
        get: async () => null,
        getMany: async () => [
          {
            id: "snap-alpha",
            agentId: ALPHA_ID,
            computedAt: new Date("2026-06-01T10:00:00Z"),
            items: [
              {
                type: "pr",
                id: "app-vitals/shipwright#200",
                title: "Shared repo PR",
                phase: "review",
                age: "2026-06-01T08:00:00Z",
              },
            ],
            createdAt: new Date("2026-06-01T10:00:00Z"),
          },
        ],
      },
      shipwrightLoopJobService: {
        // Alpha has an enabled shipwright-loop cron; Beta has no row at
        // all for it — findMany-style: absent rows just don't appear.
        listShipwrightLoopJobs: async () => [
          {
            ...MOCK_CRON,
            agentId: ALPHA_ID,
            name: "shipwright-loop",
            enabled: true,
          },
        ],
      },
      agentCronJobService: {
        list: async () => [],
        listWithRunSummary: async () => [],
        get: async () => MOCK_CRON,
        create: async () => MOCK_CRON,
        setEnabled: async () => MOCK_CRON,
        update: async () => MOCK_CRON,
        delete: async () => {},
        reconcileSystemCrons: async () => ({
          created: 0,
          updated: 0,
          deleted: 0,
        }),
      },
    });
    const app = createCodingTestApp(deps);
    const res = await app.request("/admin/queue-activity", {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    const rowIndex = html.indexOf("app-vitals/shipwright#200");
    expect(rowIndex).toBeGreaterThan(-1);
    const rowEnd = html.indexOf("</tr>", rowIndex);
    const rowHtml = html.slice(rowIndex, rowEnd);
    expect(rowHtml).toContain("Alpha Agent");
    expect(rowHtml).not.toContain("Beta Agent");
  });
});

/**
 * admin/src/coding/admin-ui-agent-cards.smoke.test.ts
 * Smoke tests for the coding extension's agent detail cards (GitHub
 * installations, Recent Verification Activity, Phase Methodology) rendered
 * through the platform agent page's card slots. Relocated from
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
} from "@app-vitals/agent-admin/admin-ui.fixtures";
import {
  createCodingTestApp,
  makeCodingMockDeps,
} from "./admin-ui-coding.fixtures.ts";

describe("admin UI — authenticated pages", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("authenticated GET /admin/agents/:id renders the GitHub Installations card from the stored snapshot", async () => {
    const reads: string[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentGitHubInstallationsService: {
          get: async (agentId: string) => {
            reads.push(agentId);
            return {
              id: "snap-1",
              agentId,
              reportedAt: new Date(),
              installations: [
                { owner: "app-vitals", installationId: 1, state: "ok" },
                {
                  owner: "broken-org",
                  installationId: 2,
                  state: "broken",
                  lastError: "installation suspended",
                },
              ],
              repoAccess: null,
              createdAt: new Date(),
            };
          },
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("GitHub Installations");
    expect(html).toContain("app-vitals");
    expect(html).toContain("installation suspended");
    expect(reads).toEqual([AGENT_ID]);
  });

  it("authenticated GET /admin/agents/:id omits the GitHub Installations card when there is no snapshot", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentGitHubInstallationsService: { get: async () => null },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("GitHub Installations");
  });

  it("authenticated GET /admin/agents/:id renders a Recent Verification Activity rollup from recent cron-run dispatch targets", async () => {
    const rollupLimits: number[] = [];
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentCronRunService: {
          listForAgent: async () => ({
            items: [
              {
                id: "run-1",
                cronId: CRON_ID,
                agentId: AGENT_ID,
                startedAt: new Date("2026-06-01T10:00:00Z"),
                completedAt: new Date("2026-06-01T10:00:03Z"),
                skipped: false,
                skipReason: null,
                outcome: "posted",
                error: null,
                itemType: "task",
                itemId: "WLS-2.2",
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
                cron: MOCK_CRON,
              },
              {
                id: "run-2",
                cronId: CRON_ID,
                agentId: AGENT_ID,
                startedAt: new Date("2026-06-01T11:00:00Z"),
                completedAt: new Date("2026-06-01T11:00:03Z"),
                skipped: false,
                skipReason: null,
                outcome: "posted",
                error: null,
                itemType: "pr",
                itemId: "acme/widgets#7",
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
                createdAt: new Date("2026-06-01T11:00:00Z"),
                modelBreakdown: [],
                cron: MOCK_CRON,
              },
            ],
            total: 2,
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
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          expect(params.get("repo")).toBe("acme/widgets");
          expect(params.get("prNumber")).toBe("7");
          return {
            prs: [
              {
                id: "pr-record-7",
                repo: "acme/widgets",
                prNumber: 7,
                staged: false,
                state: "open",
                reviewState: "posted",
                patchCycles: 0,
                reviewCycles: 0,
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          };
        },
        fetchVerificationChecks: async (params: URLSearchParams) => {
          // The rollup must ask for more than the task-store's oldest-first
          // 50-row default page, or its per-checkName "latest" is stale.
          rollupLimits.push(Number(params.get("limit")));
          if (params.get("taskId") === "WLS-2.2") {
            return {
              checks: [
                {
                  id: "vc-task-1",
                  taskId: "WLS-2.2",
                  prRecordId: null,
                  repo: "acme/widgets",
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
              offset: 0,
            };
          }
          if (params.get("prId") === "pr-record-7") {
            return {
              checks: [
                {
                  id: "vc-pr-1",
                  taskId: null,
                  prRecordId: "pr-record-7",
                  repo: "acme/widgets",
                  checkName: "lint",
                  status: "ran_failed",
                  reasonCategory: null,
                  learnedFromCategory: null,
                  durationMs: 500,
                  at: "2026-06-01T11:00:00.000Z",
                  createdAt: "2026-06-01T11:00:00.000Z",
                },
              ],
              total: 1,
              limit: 50,
              offset: 0,
            };
          }
          return { checks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Recent Verification Activity");
    expect(html).toContain("unit");
    expect(html).toContain("lint");
    expect(rollupLimits.length).toBeGreaterThan(0);
    for (const limit of rollupLimits) expect(limit).toBeGreaterThan(50);
  });

  it("authenticated GET /admin/agents/:id renders per-repo and environmental-issue breakdowns from multi-repo, mixed-reasonCategory verification checks", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentCronRunService: {
          listForAgent: async () => ({
            items: [
              {
                id: "run-1",
                cronId: CRON_ID,
                agentId: AGENT_ID,
                startedAt: new Date("2026-06-01T10:00:00Z"),
                completedAt: new Date("2026-06-01T10:00:03Z"),
                skipped: false,
                skipReason: null,
                outcome: "posted",
                error: null,
                itemType: "task",
                itemId: "WLS-2.2",
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
                cron: MOCK_CRON,
              },
              {
                id: "run-2",
                cronId: CRON_ID,
                agentId: AGENT_ID,
                startedAt: new Date("2026-06-01T11:00:00Z"),
                completedAt: new Date("2026-06-01T11:00:03Z"),
                skipped: false,
                skipReason: null,
                outcome: "posted",
                error: null,
                itemType: "pr",
                itemId: "acme/gadgets#7",
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
                createdAt: new Date("2026-06-01T11:00:00Z"),
                modelBreakdown: [],
                cron: MOCK_CRON,
              },
            ],
            total: 2,
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
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          expect(params.get("repo")).toBe("acme/gadgets");
          expect(params.get("prNumber")).toBe("7");
          return {
            prs: [
              {
                id: "pr-record-7",
                repo: "acme/gadgets",
                prNumber: 7,
                staged: false,
                state: "open",
                reviewState: "posted",
                patchCycles: 0,
                reviewCycles: 0,
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          };
        },
        fetchVerificationChecks: async (params: URLSearchParams) => {
          if (params.get("taskId") === "WLS-2.2") {
            return {
              checks: [
                {
                  id: "vc-task-1",
                  taskId: "WLS-2.2",
                  prRecordId: null,
                  repo: "acme/widgets",
                  checkName: "unit",
                  status: "ran_passed",
                  reasonCategory: null,
                  learnedFromCategory: null,
                  durationMs: 1000,
                  at: "2026-06-01T10:00:00.000Z",
                  createdAt: "2026-06-01T10:00:00.000Z",
                },
                {
                  id: "vc-task-2",
                  taskId: "WLS-2.2",
                  prRecordId: null,
                  repo: "acme/widgets",
                  checkName: "lint",
                  status: "skipped",
                  reasonCategory: "missing_tool",
                  learnedFromCategory: null,
                  durationMs: null,
                  at: "2026-06-01T10:05:00.000Z",
                  createdAt: "2026-06-01T10:05:00.000Z",
                },
              ],
              total: 2,
              limit: 50,
              offset: 0,
            };
          }
          if (params.get("prId") === "pr-record-7") {
            return {
              checks: [
                {
                  id: "vc-pr-1",
                  taskId: null,
                  prRecordId: "pr-record-7",
                  repo: "acme/gadgets",
                  checkName: "integration",
                  status: "ran_failed",
                  reasonCategory: null,
                  learnedFromCategory: null,
                  durationMs: 500,
                  at: "2026-06-01T11:00:00.000Z",
                  createdAt: "2026-06-01T11:00:00.000Z",
                },
                {
                  id: "vc-pr-2",
                  taskId: null,
                  prRecordId: "pr-record-7",
                  repo: "acme/gadgets",
                  checkName: "e2e",
                  status: "timed_out",
                  reasonCategory: "check_timeout",
                  learnedFromCategory: null,
                  durationMs: 600000,
                  at: "2026-06-01T11:05:00.000Z",
                  createdAt: "2026-06-01T11:05:00.000Z",
                },
              ],
              total: 2,
              limit: 50,
              offset: 0,
            };
          }
          return { checks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Recent Verification Activity");
    // Per-repo status breakdown: two distinct repos, so the sub-section
    // should render (it's suppressed when only one repo is represented).
    expect(html).toContain("acme/widgets");
    expect(html).toContain("acme/gadgets");
    // Environmental issues sub-section with human-readable reasonCategory
    // labels for the skipped/timed_out rows.
    expect(html).toContain("Environmental issues");
    expect(html).toContain("missing tool");
    expect(html).toContain("check timed out");
    // The ran_failed row (reasonCategory: null) must never surface inside
    // the environmental-issues sub-section.
    const envIdx = html.indexOf("Environmental issues");
    expect(envIdx).toBeGreaterThan(-1);
    const envSection = html.slice(envIdx, envIdx + 2000);
    expect(envSection).not.toContain("failed");
  });

  it("authenticated GET /admin/agents/:id renders no Recent Verification Activity card when fetchVerificationChecks is absent", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentCronRunService: {
          listForAgent: async () => ({
            items: [
              {
                id: "run-1",
                cronId: CRON_ID,
                agentId: AGENT_ID,
                startedAt: new Date("2026-06-01T10:00:00Z"),
                completedAt: new Date("2026-06-01T10:00:03Z"),
                skipped: false,
                skipReason: null,
                outcome: "posted",
                error: null,
                itemType: "task",
                itemId: "WLS-2.2",
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
                cron: MOCK_CRON,
              },
            ],
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
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Recent Verification Activity");
  });

  it("authenticated GET /admin/agents/:id renders the Recent Verification Activity empty state when no recent runs carry a dispatch target", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentCronRunService: {
          listForAgent: async () => ({
            items: [
              {
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
                modelBreakdown: [],
                cron: MOCK_CRON,
              },
            ],
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
        fetchVerificationChecks: async () => ({
          checks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Recent Verification Activity");
    expect(html).toContain("No recent verification checks recorded");
  });
});

describe("admin UI — phase methodology panel", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("GET /admin/agents/:id renders all six phases, 'default' for unconfigured and the value for configured ones", async () => {
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentPhaseMethodologyService: {
          list: async () => [
            {
              id: "pm1",
              agentId: AGENT_ID,
              phase: "review",
              subagentType: "shipwright:code-reviewer",
              updatedAt: new Date("2024-01-01"),
            },
          ],
          upsert: async (
            agentId: string,
            phase: string,
            subagentType: string | null,
          ) => ({
            id: "pm1",
            agentId,
            phase,
            subagentType,
            updatedAt: new Date("2024-01-01"),
          }),
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="card-title">Phase Methodology</div>');
    // All six fixed phases are shown regardless of override state.
    for (const phase of [
      "prd",
      "plan-session",
      "review",
      "patch",
      "deploy",
      "dev-task",
    ]) {
      expect(html).toContain(`>${phase}<`);
    }
    // Configured phase shows its overridden value.
    expect(html).toContain("shipwright:code-reviewer");
    // Unconfigured phases show the "default" placeholder.
    expect(html).toContain(">default<");
  });

  it("POST /admin/agents/:id/phase-methodology/:phase with a non-empty subagentType sets the override", async () => {
    const received: {
      agentId?: string;
      phase?: string;
      subagentType?: string | null;
    } = {};
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentPhaseMethodologyService: {
          list: async () => [],
          upsert: async (
            agentId: string,
            phase: string,
            subagentType: string | null,
          ) => {
            received.agentId = agentId;
            received.phase = phase;
            received.subagentType = subagentType;
            return {
              id: "pm1",
              agentId,
              phase,
              subagentType,
              updatedAt: new Date("2024-01-01"),
            };
          },
        },
      }),
    );
    const body = new URLSearchParams({
      subagentType: "shipwright:code-reviewer",
    });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/phase-methodology/review`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
    expect(received).toEqual({
      agentId: AGENT_ID,
      phase: "review",
      subagentType: "shipwright:code-reviewer",
    });
  });

  it("POST /admin/agents/:id/phase-methodology/:phase with an empty subagentType clears the override", async () => {
    const received: {
      agentId?: string;
      phase?: string;
      subagentType?: string | null;
    } = {};
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentPhaseMethodologyService: {
          list: async () => [
            {
              id: "pm1",
              agentId: AGENT_ID,
              phase: "review",
              subagentType: "shipwright:code-reviewer",
              updatedAt: new Date("2024-01-01"),
            },
          ],
          upsert: async (
            agentId: string,
            phase: string,
            subagentType: string | null,
          ) => {
            received.agentId = agentId;
            received.phase = phase;
            received.subagentType = subagentType;
            return {
              id: "pm1",
              agentId,
              phase,
              subagentType,
              updatedAt: new Date("2024-01-01"),
            };
          },
        },
      }),
    );
    const body = new URLSearchParams({ subagentType: "" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/phase-methodology/review`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
    expect(received).toEqual({
      agentId: AGENT_ID,
      phase: "review",
      subagentType: null,
    });
  });

  it("POST /admin/agents/:id/phase-methodology/:phase with an invalid phase is rejected without calling upsert", async () => {
    let upsertCalled = false;
    const app = createCodingTestApp(
      makeCodingMockDeps({
        agentPhaseMethodologyService: {
          list: async () => [],
          upsert: async (
            agentId: string,
            phase: string,
            subagentType: string | null,
          ) => {
            upsertCalled = true;
            return {
              id: "pm1",
              agentId,
              phase,
              subagentType,
              updatedAt: new Date("2024-01-01"),
            };
          },
        },
      }),
    );
    const body = new URLSearchParams({ subagentType: "some-value" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/phase-methodology/not-a-real-phase`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}?error=invalid_phase`,
    );
    expect(upsertCalled).toBe(false);
  });
});

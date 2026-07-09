/**
 * metrics/src/api.tokens-phase.smoke.test.ts
 * WL-3.5 — smoke coverage for GET /metrics/tokens's byAgentCron /
 * byAgentCronModel response shape now carrying a per-run `phase`.
 *
 * Drives the authenticated app via app.request() (no real server) with the
 * offline fixture TaskStoreProvider so a phase-tagged cron run flows all the
 * way from the CronRunTokenStats double through the /metrics/tokens JSON
 * response. Confirms:
 *   - byAgentCron / byAgentCronModel rows expose a `phase` field
 *   - a phase-tagged cron produces one row per (cronId, phase)
 *   - a legacy (no-phase) cron still collapses into a single row with
 *     phase: null — no regression to today's cronId-only display (AC#1)
 *
 * No mock.module(), no global.fetch overrides — DI seam only, per
 * docs/testing.md's isolation contract.
 */

import { describe, expect, test } from "bun:test";
import { type MetricsDeps, createMetricsApp } from "./api.ts";
import { createFixtureTaskStoreProvider } from "./fixtures/task-store-fixtures.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";

const noopAccountsClient = makeAccountsClientMock(async () => []);

function makeDevAuthDeps(): MetricsDeps {
  return {
    provider: createFixtureTaskStoreProvider(),
    sessionSecret: "",
    dashboardDevAuth: true,
  };
}

describe("GET /metrics/tokens — byAgentCron/byAgentCronModel phase shape (WL-3.5)", () => {
  test("response includes byAgentCron and byAgentCronModel arrays whose rows carry a phase field", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/metrics/tokens?preset=7d");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.data.byAgentCron)).toBe(true);
    expect(Array.isArray(body.data.byAgentCronModel)).toBe(true);
    expect(body.data.byAgentCron.length).toBeGreaterThan(0);

    // The fixture's byCron rows have no phase set (legacy) — every row must
    // still carry an explicit `phase` key (null), not omit the field.
    for (const row of body.data.byAgentCron) {
      expect(row).toHaveProperty("phase");
    }
    for (const row of body.data.byAgentCronModel) {
      expect(row).toHaveProperty("phase");
    }
  });

  test("a legacy (no-phase) cron collapses into a single row with phase: null", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/metrics/tokens?preset=7d");
    const body = await res.json();

    // Fixture cassette's byCron entries ("ship-loop", "patrol") carry no
    // phase — each must appear exactly once, with phase: null.
    const shipLoopRows = body.data.byAgentCron.filter(
      (r: { cronName: string }) => r.cronName === "ship-loop",
    );
    expect(shipLoopRows).toHaveLength(1);
    expect(shipLoopRows[0].phase).toBeNull();
  });
});

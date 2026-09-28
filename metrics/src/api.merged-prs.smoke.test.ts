/**
 * metrics/src/api.merged-prs.smoke.test.ts
 * Smoke coverage (POM-2.1): GET /metrics/merged-prs — the authenticated,
 * all-repo merged-PRs-by-repo-and-origin endpoint.
 *
 * Drives the authenticated app via app.request() (no real server, no
 * network). Uses the dashboardDevAuth bypass (matches
 * api.tokens-phase.smoke.test.ts's pattern) plus a hand-built MetricsProvider
 * double injected via MetricsDeps — no mock.module(), no global overrides.
 * Covers:
 *   - 200 + zod-schema-shaped body on a valid request
 *   - 400 on missing groupBy
 *   - 400 on invalid groupBy
 */

import { describe, expect, test } from "bun:test";
import { createMetricsApp, type MetricsDeps } from "./api.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";
import type { MetricsProvider } from "./metrics-provider.ts";
import { MergedPrsResultSchema } from "./schemas.ts";
import type { HogQLResult } from "./types.ts";

const noopAccountsClient = makeAccountsClientMock(async () => []);

const emptyResult: HogQLResult = {
  columns: [],
  results: [],
  types: [],
  hasMore: false,
  limit: 100,
  offset: 0,
};

const MERGED_PRS_COLUMNS = [
  "repo",
  "origin",
  "period",
  "count",
  "commitSum",
  "qualifyingCount",
  "docsRefreshSum",
  "reviewPatchSum",
  "ciFixSum",
  "implementationSum",
];

function makeProvider(): MetricsProvider {
  return {
    query: async (q) => {
      if (q.kind === "mergedPrsByRepo") {
        return {
          columns: MERGED_PRS_COLUMNS,
          results: [
            ["org/alpha", "shipwright", "2026-06-01", 2, 0, 0, 0, 0, 0, 0],
            ["org/alpha", "ci", "2026-06-01", 1, 0, 0, 0, 0, 0, 0],
            ["org/beta", "unknown", "2026-06-08", 1, 0, 0, 0, 0, 0, 0],
          ],
          types: [],
        };
      }
      return emptyResult;
    },
  };
}

/** A provider double for the commit-aggregation-specific test cases below —
 * kept separate from makeProvider() so the existing pre-CPP-1.3 test cases
 * above stay byte-identical (no retired tests, per CPP-1.3's acceptance
 * criteria). */
function makeCommitAggProvider(rows: (string | number)[][]): MetricsProvider {
  return {
    query: async (q) => {
      if (q.kind === "mergedPrsByRepo") {
        return { columns: MERGED_PRS_COLUMNS, results: rows, types: [] };
      }
      return emptyResult;
    },
  };
}

function makeDevAuthDeps(
  provider: MetricsProvider = makeProvider(),
): MetricsDeps {
  return {
    provider,
    sessionSecret: "",
    dashboardDevAuth: true,
  };
}

describe("GET /metrics/merged-prs (POM-2.1)", () => {
  test("valid request → 200, body validates against MergedPrsResultSchema", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/metrics/merged-prs?preset=7d&groupBy=week");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(() => MergedPrsResultSchema.parse(body.data)).not.toThrow();
    expect(body.data.groupBy).toBe("week");
    expect(typeof body.data.from).toBe("string");
    expect(typeof body.data.to).toBe("string");
  });

  test("valid request → repos[] totals and trend[] rows reflect the grouped counts", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/metrics/merged-prs?preset=7d&groupBy=week");
    const body = await res.json();

    const alpha = body.data.repos.find(
      (r: { repo: string }) => r.repo === "org/alpha",
    );
    const beta = body.data.repos.find(
      (r: { repo: string }) => r.repo === "org/beta",
    );
    expect(alpha.total).toBe(3);
    expect(alpha.byOrigin).toEqual({
      shipwright: 2,
      ci: 1,
      dependency_bot: 0,
      human: 0,
      unknown: 0,
    });
    expect(beta.total).toBe(1);
    expect(beta.byOrigin.unknown).toBe(1);

    expect(body.data.trend).toHaveLength(2);
    const alphaTrend = body.data.trend.find(
      (t: { repo: string }) => t.repo === "org/alpha",
    );
    expect(alphaTrend.period).toBe("2026-06-01");
    expect(alphaTrend.byOrigin.shipwright).toBe(2);
    expect(alphaTrend.byOrigin.ci).toBe(1);
  });

  test("missing groupBy → 400", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/metrics/merged-prs?preset=7d");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test("invalid groupBy → 400", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request(
      "/metrics/merged-prs?preset=7d&groupBy=month",
    );
    expect(res.status).toBe(400);
  });

  test("no auth, dev-auth disabled → 401", async () => {
    const deps: MetricsDeps = { provider: makeProvider(), sessionSecret: "" };
    const app = createMetricsApp(new Map(), noopAccountsClient, deps);
    const res = await app.request("/metrics/merged-prs?preset=7d&groupBy=day");
    expect(res.status).toBe(401);
  });

  // ─── Commits-per-PR aggregation (CPP-1.3) ──────────────────────────────────

  test("origin:shipwright rows with non-null commitCount → avgCommitCount + commitBreakdown computed as per-PR averages", async () => {
    const provider = makeCommitAggProvider([
      // Two qualifying org/alpha PRs: commitCount 3 and 5 → avg 4.
      ["org/alpha", "shipwright", "2026-06-01", 1, 3, 1, 1, 1, 0, 1],
      ["org/alpha", "shipwright", "2026-06-01", 1, 5, 1, 0, 2, 1, 2],
    ]);
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(provider),
    );
    const res = await app.request("/metrics/merged-prs?preset=7d&groupBy=week");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => MergedPrsResultSchema.parse(body.data)).not.toThrow();

    const alpha = body.data.repos.find(
      (r: { repo: string }) => r.repo === "org/alpha",
    );
    expect(alpha.avgCommitCount).toBe(4);
    expect(alpha.commitBreakdown).toEqual({
      docsRefresh: 0.5,
      reviewPatch: 1.5,
      ciFix: 0.5,
      implementation: 1.5,
    });
  });

  test("all rows non-shipwright origin or null commitCount → avgCommitCount and commitBreakdown are null, not 0", async () => {
    const provider = makeCommitAggProvider([
      // origin ci, would-be-qualifying commitCount ignored because origin != shipwright
      ["org/beta", "ci", "2026-06-01", 1, 0, 0, 0, 0, 0, 0],
      // origin shipwright but null commitCount at the source (provider marks qualifyingCount 0)
      ["org/beta", "shipwright", "2026-06-01", 1, 0, 0, 0, 0, 0, 0],
    ]);
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(provider),
    );
    const res = await app.request("/metrics/merged-prs?preset=7d&groupBy=week");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => MergedPrsResultSchema.parse(body.data)).not.toThrow();

    const beta = body.data.repos.find(
      (r: { repo: string }) => r.repo === "org/beta",
    );
    expect(beta.avgCommitCount).toBeNull();
    expect(beta.commitBreakdown).toBeNull();
  });

  test("existing fixture (no commit columns populated) → avgCommitCount and commitBreakdown are null", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/metrics/merged-prs?preset=7d&groupBy=week");
    const body = await res.json();

    const alpha = body.data.repos.find(
      (r: { repo: string }) => r.repo === "org/alpha",
    );
    expect(alpha.avgCommitCount).toBeNull();
    expect(alpha.commitBreakdown).toBeNull();
  });
});

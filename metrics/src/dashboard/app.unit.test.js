/**
 * metrics/src/dashboard/app.unit.test.js
 * Unit tests for the pure fetch-sequencing helper extracted from app.js
 * (fetchSequential). app.js is a plain browser `<script>` (not an ES module,
 * no DOM globals touched outside DOMContentLoaded) — importing it for its
 * side effect exposes the pure helper on `globalThis.__dashboardAppTestExports`
 * only when `window` is undefined (i.e. under bun:test), so this file needs
 * no DOM/browser globals to run.
 */

import { beforeAll, describe, expect, test } from "bun:test";

let fetchSequential;
let computeFleetWeightedAvgCommits;
let buildCoverageTrend;
let fmtCoverageDelta;
let buildAdminTasksHref;
let fmtAsOfMeta;
let resolveTheme;
let nextTheme;
let fmtReadinessHeadline;
let sortFailingChecks;
let fmtFailingCheck;
let buildReadinessRows;
let buildReadinessTrend;

beforeAll(async () => {
  await import("./app.js");
  ({
    fetchSequential,
    computeFleetWeightedAvgCommits,
    buildCoverageTrend,
    fmtCoverageDelta,
    buildAdminTasksHref,
    fmtAsOfMeta,
    resolveTheme,
    nextTheme,
    fmtReadinessHeadline,
    sortFailingChecks,
    fmtFailingCheck,
    buildReadinessRows,
    buildReadinessTrend,
  } = globalThis.__dashboardAppTestExports);
});

describe("fetchSequential", () => {
  test("issues requests strictly sequentially — the 2nd request isn't issued until the 1st settles", async () => {
    const callOrder = [];
    let resolveFirst;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const fakeFetch = (url) => {
      callOrder.push(url);
      if (url === "/one") {
        return firstPromise.then(() => ({
          json: async () => ({ id: "one" }),
        }));
      }
      return Promise.resolve({ json: async () => ({ id: url }) });
    };

    const entries = [
      { url: "/one", parse: (r) => r.json() },
      { url: "/two", parse: (r) => r.json() },
      { url: "/three", parse: (r) => r.json() },
    ];

    const resultPromise = fetchSequential(entries, fakeFetch);

    // Only the first request should have been issued so far — the second
    // must not fire until the first request's promise settles.
    await Promise.resolve();
    await Promise.resolve();
    expect(callOrder).toEqual(["/one"]);

    resolveFirst();
    const results = await resultPromise;

    expect(callOrder).toEqual(["/one", "/two", "/three"]);
    expect(results).toEqual([{ id: "one" }, { id: "/two" }, { id: "/three" }]);
  });

  test("a per-entry onError fallback (e.g. to null) does not abort subsequent requests", async () => {
    const callOrder = [];
    const fakeFetch = (url) => {
      callOrder.push(url);
      if (url === "/fails") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve({ json: async () => ({ ok: url }) });
    };

    const errors = [];
    const entries = [
      { url: "/before", parse: (r) => r.json() },
      {
        url: "/fails",
        parse: (r) => r.json(),
        onError: (err) => {
          errors.push(err);
          return null;
        },
      },
      { url: "/after", parse: (r) => r.json() },
    ];

    const results = await fetchSequential(entries, fakeFetch);

    expect(callOrder).toEqual(["/before", "/fails", "/after"]);
    expect(results).toEqual([{ ok: "/before" }, null, { ok: "/after" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toBe("boom");
  });

  test("an entry without onError propagates its rejection (matches summary/trends' uncaught behavior)", async () => {
    const fakeFetch = (url) => {
      if (url === "/summary") return Promise.reject(new Error("summary down"));
      return Promise.resolve({ json: async () => ({ ok: true }) });
    };

    const entries = [{ url: "/summary", parse: (r) => r.json() }];

    await expect(fetchSequential(entries, fakeFetch)).rejects.toThrow(
      "summary down",
    );
  });

  test("a rejection with no onError still stops later entries from being issued (propagates immediately)", async () => {
    const callOrder = [];
    const fakeFetch = (url) => {
      callOrder.push(url);
      if (url === "/summary") return Promise.reject(new Error("summary down"));
      return Promise.resolve({ json: async () => ({ ok: true }) });
    };

    const entries = [
      { url: "/summary", parse: (r) => r.json() },
      { url: "/trends", parse: (r) => r.json() },
    ];

    await expect(fetchSequential(entries, fakeFetch)).rejects.toThrow(
      "summary down",
    );
    expect(callOrder).toEqual(["/summary"]);
  });

  test("parse errors also route through onError when provided", async () => {
    const fakeFetch = () =>
      Promise.resolve({
        json: async () => {
          throw new Error("bad json");
        },
      });

    const errors = [];
    const entries = [
      {
        url: "/queue",
        parse: (r) => r.json(),
        onError: (err) => {
          errors.push(err);
          return null;
        },
      },
    ];

    const results = await fetchSequential(entries, fakeFetch);
    expect(results).toEqual([null]);
    expect(errors).toHaveLength(1);
  });

  test("empty entries resolves to an empty array without calling fetch", async () => {
    let called = false;
    const fakeFetch = () => {
      called = true;
      return Promise.resolve({ json: async () => ({}) });
    };

    const results = await fetchSequential([], fakeFetch);
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("computeFleetWeightedAvgCommits", () => {
  test("single repo with avgCommitCount and commitBreakdown → returns weighted average (weight = byOrigin.shipwright)", () => {
    const repos = [
      {
        repo: "org/alpha",
        byOrigin: {
          shipwright: 5,
          ci: 1,
          dependency_bot: 0,
          human: 0,
          unknown: 0,
        },
        avgCommitCount: 4.0,
        commitBreakdown: {
          docsRefresh: 0.5,
          reviewPatch: 1.5,
          ciFix: 0.5,
          implementation: 1.5,
        },
      },
    ];

    const result = computeFleetWeightedAvgCommits(repos);

    expect(result.avgCommitCount).toBe(4.0);
    expect(result.commitBreakdown).toEqual({
      docsRefresh: 0.5,
      reviewPatch: 1.5,
      ciFix: 0.5,
      implementation: 1.5,
    });
  });

  test("multiple repos with different qualifying counts → computes fleet-wide weighted average", () => {
    const repos = [
      {
        repo: "org/alpha",
        byOrigin: {
          shipwright: 10,
          ci: 1,
          dependency_bot: 0,
          human: 0,
          unknown: 0,
        },
        avgCommitCount: 3.0,
        commitBreakdown: {
          docsRefresh: 0.3,
          reviewPatch: 0.9,
          ciFix: 0.6,
          implementation: 1.2,
        },
      },
      {
        repo: "org/beta",
        byOrigin: {
          shipwright: 5,
          ci: 2,
          dependency_bot: 0,
          human: 0,
          unknown: 0,
        },
        avgCommitCount: 4.0,
        commitBreakdown: {
          docsRefresh: 0.4,
          reviewPatch: 1.2,
          ciFix: 0.8,
          implementation: 1.6,
        },
      },
    ];

    const result = computeFleetWeightedAvgCommits(repos);

    // weighted avg = (10 * 3.0 + 5 * 4.0) / (10 + 5) = (30 + 20) / 15 = 3.33...
    expect(result.avgCommitCount).toBeCloseTo(3.33, 2);

    // weighted breakdown:
    // docsRefresh: (10 * 0.3 + 5 * 0.4) / 15 = (3 + 2) / 15 = 0.333...
    expect(result.commitBreakdown.docsRefresh).toBeCloseTo(0.333, 2);

    // reviewPatch: (10 * 0.9 + 5 * 1.2) / 15 = (9 + 6) / 15 = 1.0
    expect(result.commitBreakdown.reviewPatch).toBe(1.0);

    // ciFix: (10 * 0.6 + 5 * 0.8) / 15 = (6 + 4) / 15 = 0.6666...
    expect(result.commitBreakdown.ciFix).toBeCloseTo(0.667, 2);

    // implementation: (10 * 1.2 + 5 * 1.6) / 15 = (12 + 8) / 15 = 1.333...
    expect(result.commitBreakdown.implementation).toBeCloseTo(1.333, 2);
  });

  test("all repos with null avgCommitCount → returns null for avgCommitCount and commitBreakdown", () => {
    const repos = [
      {
        repo: "org/alpha",
        byOrigin: {
          shipwright: 5,
          ci: 1,
          dependency_bot: 0,
          human: 0,
          unknown: 0,
        },
        avgCommitCount: null,
        commitBreakdown: null,
      },
      {
        repo: "org/beta",
        byOrigin: {
          shipwright: 3,
          ci: 2,
          dependency_bot: 0,
          human: 0,
          unknown: 0,
        },
        avgCommitCount: null,
        commitBreakdown: null,
      },
    ];

    const result = computeFleetWeightedAvgCommits(repos);

    expect(result.avgCommitCount).toBeNull();
    expect(result.commitBreakdown).toBeNull();
  });

  test("empty repos array → returns null for avgCommitCount and commitBreakdown", () => {
    const repos = [];

    const result = computeFleetWeightedAvgCommits(repos);

    expect(result.avgCommitCount).toBeNull();
    expect(result.commitBreakdown).toBeNull();
  });

  test("repos with no qualifying shipwright PRs (byOrigin.shipwright = 0) → skipped from weighting", () => {
    const repos = [
      {
        repo: "org/alpha",
        byOrigin: {
          shipwright: 10,
          ci: 0,
          dependency_bot: 0,
          human: 0,
          unknown: 0,
        },
        avgCommitCount: 5.0,
        commitBreakdown: {
          docsRefresh: 0.5,
          reviewPatch: 1.5,
          ciFix: 0.5,
          implementation: 2.5,
        },
      },
      {
        repo: "org/beta",
        byOrigin: {
          shipwright: 0,
          ci: 5,
          dependency_bot: 0,
          human: 0,
          unknown: 0,
        },
        avgCommitCount: 3.0,
        commitBreakdown: {
          docsRefresh: 0.3,
          reviewPatch: 0.9,
          ciFix: 0.6,
          implementation: 1.2,
        },
      },
    ];

    const result = computeFleetWeightedAvgCommits(repos);

    // Only org/alpha should count (org/beta has 0 shipwright PRs)
    expect(result.avgCommitCount).toBe(5.0);
    expect(result.commitBreakdown).toEqual({
      docsRefresh: 0.5,
      reviewPatch: 1.5,
      ciFix: 0.5,
      implementation: 2.5,
    });
  });

  test("mixed case: some repos with null, some with data → uses only repos with data", () => {
    const repos = [
      {
        repo: "org/alpha",
        byOrigin: {
          shipwright: 10,
          ci: 0,
          dependency_bot: 0,
          human: 0,
          unknown: 0,
        },
        avgCommitCount: 2.0,
        commitBreakdown: {
          docsRefresh: 0.2,
          reviewPatch: 0.8,
          ciFix: 0.4,
          implementation: 0.6,
        },
      },
      {
        repo: "org/beta",
        byOrigin: {
          shipwright: 5,
          ci: 0,
          dependency_bot: 0,
          human: 0,
          unknown: 0,
        },
        avgCommitCount: null,
        commitBreakdown: null,
      },
    ];

    const result = computeFleetWeightedAvgCommits(repos);

    // Only org/alpha should count (org/beta has null)
    expect(result.avgCommitCount).toBe(2.0);
    expect(result.commitBreakdown).toEqual({
      docsRefresh: 0.2,
      reviewPatch: 0.8,
      ciFix: 0.4,
      implementation: 0.6,
    });
  });
});

describe("buildCoverageTrend", () => {
  const trend = [
    {
      repo: "org/alpha",
      measuredAt: "2026-06-10T12:00:00.000Z",
      commitSha: "a",
      linesPct: 81,
    },
    {
      repo: "org/beta",
      measuredAt: "2026-06-12T09:00:00.000Z",
      commitSha: "b",
      linesPct: 64,
    },
    {
      repo: "org/alpha",
      measuredAt: "2026-06-17T12:00:00.000Z",
      commitSha: "c",
      linesPct: 82.5,
    },
  ];

  test("one dataset per repo with one point per snapshot (null where a repo has none)", () => {
    const { labels, datasets } = buildCoverageTrend(trend, "");
    expect(labels).toHaveLength(3);
    expect(datasets.map((d) => d.label)).toEqual(["org/alpha", "org/beta"]);
    expect(datasets[0].data).toEqual([81, null, 82.5]);
    expect(datasets[1].data).toEqual([null, 64, null]);
  });

  test("repo filter restricts to that repo's series", () => {
    const { labels, datasets } = buildCoverageTrend(trend, "org/alpha");
    expect(labels).toHaveLength(2);
    expect(datasets).toHaveLength(1);
    expect(datasets[0].label).toBe("org/alpha");
    expect(datasets[0].data).toEqual([81, 82.5]);
  });

  test("empty input yields no labels or datasets", () => {
    expect(buildCoverageTrend([], "")).toEqual({ labels: [], datasets: [] });
    expect(buildCoverageTrend(undefined, "org/x").datasets).toEqual([]);
  });
});

describe("fmtCoverageDelta", () => {
  test("signs positive and negative deltas, formats to 1 decimal", () => {
    expect(fmtCoverageDelta(1.5)).toEqual({ text: "+1.5 pp", cls: "good" });
    expect(fmtCoverageDelta(-0.25).text).toBe("-0.3 pp");
    expect(fmtCoverageDelta(-2).cls).toBe("critical");
    expect(fmtCoverageDelta(0)).toEqual({ text: "0.0 pp", cls: "" });
  });

  test("null delta renders an em dash", () => {
    expect(fmtCoverageDelta(null)).toEqual({ text: "—", cls: "" });
  });
});

describe("buildAdminTasksHref (SCM-8.4)", () => {
  const filter = {
    originKind: "cron",
    originRef: "test-readiness",
    createdFrom: "2026-11-11T08:00:00.000Z",
    createdTo: "2026-11-18T07:59:59.999Z",
    source: "system-cron",
    bucket: "shipped",
  };

  test("targets /admin/tasks on the admin base with table view and all owners", () => {
    const url = new URL(buildAdminTasksHref("http://admin:3001/", filter));
    expect(url.origin).toBe("http://admin:3001");
    expect(url.pathname).toBe("/admin/tasks");
    expect(url.searchParams.get("view")).toBe("table");
    expect(url.searchParams.get("owner")).toBe("all");
  });

  test("forwards every filter param verbatim, including metrics-side bucket/sourceNot", () => {
    const url = new URL(
      buildAdminTasksHref("", {
        ...filter,
        sourceNot: "system-cron",
        status: "cancelled",
      }),
      "http://x",
    );
    for (const [k, v] of Object.entries({
      ...filter,
      sourceNot: "system-cron",
      status: "cancelled",
    })) {
      expect(url.searchParams.get(k)).toBe(v);
    }
  });

  test("empty admin base yields a same-origin relative href; missing filter is tolerated", () => {
    expect(buildAdminTasksHref("", filter).startsWith("/admin/tasks?")).toBe(
      true,
    );
    expect(buildAdminTasksHref(undefined, undefined)).toBe(
      "/admin/tasks?view=table&owner=all",
    );
  });
});

describe("fmtAsOfMeta (SCM-8.4)", () => {
  test("pluralizes repo scope", () => {
    expect(fmtAsOfMeta({ repoCount: 3 })).toBe("3 repos");
    expect(fmtAsOfMeta({ repoCount: 1 })).toBe("1 repo");
    expect(fmtAsOfMeta(undefined)).toBe("0 repos");
  });
});

describe("resolveTheme", () => {
  test("a saved choice wins over the system preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("with no saved choice it follows the system preference", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
  });

  test("an unrecognised saved value is ignored", () => {
    expect(resolveTheme("sepia", true)).toBe("dark");
    expect(resolveTheme("", false)).toBe("light");
    expect(resolveTheme(undefined, false)).toBe("light");
  });
});

describe("nextTheme", () => {
  test("flips between the two themes", () => {
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
  });

  test("treats a missing theme as light", () => {
    expect(nextTheme(null)).toBe("dark");
  });
});

describe("readiness formatters (RDY-5.1)", () => {
  test("fmtReadinessHeadline renders the percentage and repo count", () => {
    expect(
      fmtReadinessHeadline({ percentAtOrAboveFloor: 50, repoCount: 2 }),
    ).toEqual({
      headline: "50% of repos at Level 3+",
      count: "2 repos",
    });
    expect(
      fmtReadinessHeadline({ percentAtOrAboveFloor: 33.3, repoCount: 1 }),
    ).toEqual({
      headline: "33.3% of repos at Level 3+",
      count: "1 repo",
    });
  });

  test("fmtReadinessHeadline handles no fresh repos", () => {
    expect(
      fmtReadinessHeadline({ percentAtOrAboveFloor: null, repoCount: 0 }),
    ).toEqual({
      headline: "No up-to-date repos scored",
      count: "0 repos",
    });
  });

  test("sortFailingChecks orders lowest level first, then by id, without mutating", () => {
    const checks = [
      { id: "b", level: 3, owner: "x", ownerRunning: true },
      { id: "z", level: 2, owner: "x", ownerRunning: true },
      { id: "a", level: 3, owner: "x", ownerRunning: true },
    ];
    expect(sortFailingChecks(checks).map((c) => c.id)).toEqual(["z", "a", "b"]);
    expect(checks.map((c) => c.id)).toEqual(["b", "z", "a"]);
  });

  test("fmtFailingCheck names the owner cron, or 'no owner running'", () => {
    expect(
      fmtFailingCheck({
        id: "lockfile",
        level: 2,
        owner: "test-readiness",
        ownerRunning: true,
      }),
    ).toEqual({
      id: "lockfile",
      level: 2,
      ownerText: "test-readiness",
      noOwner: false,
    });
    expect(
      fmtFailingCheck({
        id: "preview-env",
        level: 3,
        owner: "environments-scan",
        ownerRunning: false,
      }),
    ).toEqual({
      id: "preview-env",
      level: 3,
      ownerText: "no owner running",
      noOwner: true,
    });
  });

  test("buildReadinessRows maps repos to level plus sorted failing checks and stale flag", () => {
    const rows = buildReadinessRows([
      {
        repo: "org/beta",
        level: 2,
        stale: true,
        failingChecks: [
          {
            id: "preview-env",
            level: 3,
            owner: "environments-scan",
            ownerRunning: false,
          },
          {
            id: "lockfile",
            level: 2,
            owner: "test-readiness",
            ownerRunning: true,
          },
        ],
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe("org/beta");
    expect(rows[0].level).toBe(2);
    expect(rows[0].stale).toBe(true);
    expect(rows[0].checks.map((c) => c.id)).toEqual([
      "lockfile",
      "preview-env",
    ]);
    expect(rows[0].checks[1].ownerText).toBe("no owner running");
  });

  test("buildReadinessTrend labels weeks and keeps null gaps", () => {
    const t = buildReadinessTrend([
      {
        weekStart: "2026-06-01T00:00:00.000Z",
        percentAtOrAboveFloor: null,
        repoCount: 0,
      },
      {
        weekStart: "2026-06-08T00:00:00.000Z",
        percentAtOrAboveFloor: 50,
        repoCount: 2,
      },
    ]);
    expect(t.labels).toEqual(["2026-06-01", "2026-06-08"]);
    expect(t.data).toEqual([null, 50]);
  });
});

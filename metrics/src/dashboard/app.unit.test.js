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

beforeAll(async () => {
  await import("./app.js");
  ({ fetchSequential, computeFleetWeightedAvgCommits } = globalThis.__dashboardAppTestExports);
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
        byOrigin: { shipwright: 5, ci: 1, dependency_bot: 0, human: 0, unknown: 0 },
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
        byOrigin: { shipwright: 10, ci: 1, dependency_bot: 0, human: 0, unknown: 0 },
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
        byOrigin: { shipwright: 5, ci: 2, dependency_bot: 0, human: 0, unknown: 0 },
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
        byOrigin: { shipwright: 5, ci: 1, dependency_bot: 0, human: 0, unknown: 0 },
        avgCommitCount: null,
        commitBreakdown: null,
      },
      {
        repo: "org/beta",
        byOrigin: { shipwright: 3, ci: 2, dependency_bot: 0, human: 0, unknown: 0 },
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
        byOrigin: { shipwright: 10, ci: 0, dependency_bot: 0, human: 0, unknown: 0 },
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
        byOrigin: { shipwright: 0, ci: 5, dependency_bot: 0, human: 0, unknown: 0 },
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
        byOrigin: { shipwright: 10, ci: 0, dependency_bot: 0, human: 0, unknown: 0 },
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
        byOrigin: { shipwright: 5, ci: 0, dependency_bot: 0, human: 0, unknown: 0 },
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

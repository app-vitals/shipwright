/**
 * Integration test (PCR-3.4): the error-scan repo filter against recorded
 * Sentry fixtures. fetch is injected; no global overrides.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchUnresolvedIssues,
  type ProjectRepoMap,
  type SentryDeps,
  scanRepo,
} from "./repo-filter.ts";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

function sentryDeps(calls: string[] = []): SentryDeps {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(
      ((init?.headers ?? {}) as Record<string, string>).Authorization,
    ).toBe("Bearer tok");
    if (url.includes(`cursor=${encodeURIComponent("0:100:0")}`)) {
      return new Response(fixture("sentry-issues-page2.json"), {
        headers: {
          Link: '<https://sentry.io/x>; rel="next"; results="false"; cursor="0:200:0"',
        },
      });
    }
    return new Response(fixture("sentry-issues-page1.json"), {
      headers: {
        Link: '<https://sentry.io/x>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/x>; rel="next"; results="true"; cursor="0:100:0"',
      },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, org: "example-org", token: "tok" };
}

const MAP: ProjectRepoMap = {
  api: "acme/api",
  web: "acme/web",
  mystery: null,
};

describe("fetchUnresolvedIssues", () => {
  it("follows Link pagination and normalizes counts", async () => {
    const calls: string[] = [];
    const issues = await fetchUnresolvedIssues(sentryDeps(calls));
    expect(issues.map((i) => i.id)).toEqual(["1001", "1002", "1003", "1004"]);
    expect(issues[0]?.count).toBe(120);
    expect(issues[0]?.project).toBe("api");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("query=is%3Aunresolved");
  });

  it("throws on a non-2xx Sentry response", async () => {
    const fetchFn = (async () =>
      new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(
      fetchUnresolvedIssues({ fetchFn, org: "o", token: "t" }),
    ).rejects.toThrow("HTTP 500");
  });
});

describe("scanRepo --repo acme/api", () => {
  it("keeps only issues mapped to this repo; unmapped counted, no other output", async () => {
    const result = await scanRepo(sentryDeps(), {
      repo: "acme/api",
      projectRepoMap: MAP,
      prior: [],
    });
    expect(result.findings.map((f) => f.fingerprint)).toEqual(["1001", "1003"]);
    expect(result.metrics.unmapped).toBe(1);
    expect(result.metrics.other_repo).toBe(1);
    expect(result.metrics.new).toBe(2);
    expect(result.outcome).toBe("ok");
    expect(result.machineState.projectRepoMap).toEqual(MAP);
    expect(JSON.stringify(result)).not.toContain("MYSTERY-4D");
  });

  it("classifies regressed, unchanged and resolved against prior findings", async () => {
    const result = await scanRepo(sentryDeps(), {
      repo: "acme/api",
      projectRepoMap: MAP,
      prior: [
        { fingerprint: "1001", status: "open", detail: { count: 100 } },
        { fingerprint: "1003", status: "open", detail: { count: 7 } },
        { fingerprint: "0999", status: "open", detail: { count: 1 } },
      ],
    });
    expect(result.metrics).toMatchObject({
      new: 0,
      regressed: 1,
      unchanged: 1,
      resolved: 1,
    });
    const byFp = Object.fromEntries(
      result.findings.map((f) => [f.fingerprint, f.status]),
    );
    expect(byFp).toEqual({
      "1001": "open",
      "1003": "open",
      "0999": "resolved",
    });
  });

  it("treats a resolved-then-unresolved issue as regressed and no-ops when nothing changed", async () => {
    const regressed = await scanRepo(sentryDeps(), {
      repo: "acme/api",
      projectRepoMap: MAP,
      prior: [
        { fingerprint: "1001", status: "resolved", detail: { count: 500 } },
        { fingerprint: "1003", status: "open", detail: { count: 7 } },
      ],
    });
    expect(regressed.metrics.regressed).toBe(1);

    const quiet = await scanRepo(sentryDeps(), {
      repo: "acme/api",
      projectRepoMap: MAP,
      prior: [
        { fingerprint: "1001", status: "open", detail: { count: 120 } },
        { fingerprint: "1003", status: "open", detail: { count: 7 } },
      ],
    });
    expect(quiet.outcome).toBe("no_op");
  });

  it("returns nothing for a repo with no mapped projects", async () => {
    const result = await scanRepo(sentryDeps(), {
      repo: "acme/other",
      projectRepoMap: MAP,
      prior: [],
    });
    expect(result.findings).toHaveLength(0);
    expect(result.metrics.other_repo).toBe(3);
    expect(result.metrics.unmapped).toBe(1);
  });
});

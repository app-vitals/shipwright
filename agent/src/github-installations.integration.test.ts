/**
 * Integration tests for discoverInstallations/selectInstallations using a
 * recorded cassette of GET /app/installations (multi-page, a suspended
 * installation, and a user installation not created via admin) replayed
 * through an injected fetchFn. No real network.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  discoverInstallations,
  selectInstallations,
} from "./github-installations.ts";

interface CassetteEntry {
  status: number;
  body: unknown;
}

const cassette: Record<string, CassetteEntry> = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/github-installations/installations.json",
      import.meta.url,
    ).pathname,
    "utf-8",
  ),
);

function replay(keyForPage: (page: number) => string) {
  const requests: { url: string; auth: string | null }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    requests.push({
      url: String(url),
      auth: new Headers(init?.headers).get("Authorization"),
    });
    const entry = cassette[keyForPage(Number(u.searchParams.get("page")))];
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      statusText: `status-${entry.status}`,
    });
  }) as typeof fetch;
  return { fetchFn, requests };
}

describe("discoverInstallations (cassette)", () => {
  it("follows pagination across pages with the App JWT only", async () => {
    const { fetchFn, requests } = replay((p) =>
      p === 1 ? "page1_full" : "page2_partial",
    );
    const r = await discoverInstallations("app-jwt", fetchFn);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.installations).toHaveLength(101);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain("per_page=100&page=1");
    expect(requests.every((q) => q.auth === "Bearer app-jwt")).toBe(true);
    expect(
      r.installations.find((i) => i.id === 1005)?.suspendedAt,
    ).not.toBeNull();
    expect(r.installations.find((i) => i.id === 2001)?.owner).toBe("octocat");
  });

  it("returns an error result on a 401", async () => {
    const { fetchFn } = replay(() => "unauthorized");
    const r = await discoverInstallations("bad", fetchFn);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("401");
  });

  it("feeds selection: out-of-scope ignored, suspended flagged, non-admin install selected", async () => {
    const { fetchFn } = replay((p) =>
      p === 1 ? "page1_full" : "page2_partial",
    );
    const r = await discoverInstallations("jwt", fetchFn);
    if (!r.ok) throw new Error("discovery failed");
    const sel = selectInstallations({
      discovered: r.installations,
      scopedRepos: ["acme-corp/app", "suspended-org/x", "octocat/dotfiles"],
      scopeSynced: true,
    });
    expect(sel.installations.map((i) => i.id)).toEqual([1003, 1005, 2001]);
    expect(sel.installations.find((i) => i.id === 1005)?.suspended).toBe(true);
    expect(sel.defaultId).toBe(1003);
  });
});

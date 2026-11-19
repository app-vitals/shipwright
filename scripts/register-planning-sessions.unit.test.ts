import { describe, expect, it } from "bun:test";
import {
  formatReport,
  HttpPlanningStoreClient,
  parseArgs,
  repoFromRemote,
} from "./register-planning-sessions.ts";

describe("parseArgs", () => {
  it("parses flags", () => {
    expect(parseArgs(["--dry-run", "--repo", "a/b", "--root", "/x"])).toEqual({
      dryRun: true,
      root: "/x",
      repo: "a/b",
    });
  });
  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--nope"])).toThrow("unknown argument");
  });
});

describe("repoFromRemote", () => {
  it("handles https and ssh remotes", () => {
    expect(repoFromRemote("https://github.com/o/r.git\n")).toBe("o/r");
    expect(repoFromRemote("git@github.com:o/r.git")).toBe("o/r");
    expect(repoFromRemote("https://github.com/o/r")).toBe("o/r");
    expect(repoFromRemote("nonsense")).toBeNull();
  });
});

describe("formatReport", () => {
  it("labels dry runs and lists reported files and errors", () => {
    const out = formatReport({
      dryRun: true,
      created: 1,
      updated: 0,
      linked: 2,
      reported: [{ path: "planning/x/A.md", reason: "non-standard file" }],
      errors: ["x: boom"],
    });
    expect(out).toContain("Dry run: nothing was written.");
    expect(out).toContain("planning/x/A.md — non-standard file");
    expect(out).toContain("x: boom");
  });
});

describe("HttpPlanningStoreClient.listTasks", () => {
  it("follows nextCursor until null and never sends offset", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      urls.push(String(url));
      const cursor = new URL(String(url)).searchParams.get("cursor");
      const body =
        cursor === null
          ? { tasks: [{ id: "a" }], nextCursor: "c1" }
          : { tasks: [{ id: "b" }], nextCursor: null };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new HttpPlanningStoreClient({
      baseUrl: "http://ts.test",
      token: "t",
      fetch: fetchFn,
    });

    const rows = await client.listTasks({ source: "planning/x" });

    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("cursor=c1");
    for (const u of urls) expect(u).not.toContain("offset");
  });
});

import { describe, expect, it } from "bun:test";
import {
  formatReport,
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

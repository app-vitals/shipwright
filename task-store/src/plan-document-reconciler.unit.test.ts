/**
 * Unit tests for the pure state-decision function and the GitHub client
 * (replaying recorded fixtures) — PLU-2.6.
 */

import { describe, expect, it } from "bun:test";
import {
  createGitHubPlanClient,
  githubTokenFromEnv,
} from "./github-plan-client.ts";
import { decideDocumentState } from "./plan-document-reconciler.ts";
import { fixtureFetch } from "./plan-reconciler-fixtures.ts";

const doc = { prUrl: "https://github.com/acme/home/pull/12", commitSha: null };
const FILE = { commitSha: "abc123", prUrl: null };

describe("decideDocumentState", () => {
  it("file on default branch -> merged, with its commit sha", () => {
    expect(decideDocumentState(doc, { file: FILE, pr: null })).toEqual({
      state: "merged",
      prUrl: doc.prUrl,
      commitSha: "abc123",
    });
  });

  it("file on default branch wins over an open PR", () => {
    const d = decideDocumentState(doc, {
      file: FILE,
      pr: { state: "open", merged: false },
    });
    expect(d?.state).toBe("merged");
  });

  it("fills a missing prUrl from the file's merged PR, never replaces one", () => {
    const withPr = {
      commitSha: "abc123",
      prUrl: "https://github.com/acme/home/pull/99",
    };
    expect(
      decideDocumentState(
        { prUrl: null, commitSha: null },
        { file: withPr, pr: null },
      )?.prUrl,
    ).toBe(withPr.prUrl);
    expect(decideDocumentState(doc, { file: withPr, pr: null })?.prUrl).toBe(
      doc.prUrl,
    );
  });

  it("keeps the existing commitSha when GitHub reports none", () => {
    const d = decideDocumentState(
      { prUrl: null, commitSha: "old" },
      { file: { commitSha: null, prUrl: null }, pr: null },
    );
    expect(d?.commitSha).toBe("old");
  });

  it("closed-unmerged PR and no file -> abandoned, other fields untouched", () => {
    expect(
      decideDocumentState(
        { prUrl: doc.prUrl, commitSha: "keep" },
        { file: null, pr: { state: "closed", merged: false } },
      ),
    ).toEqual({ state: "abandoned", prUrl: doc.prUrl, commitSha: "keep" });
  });

  it("open PR and no file -> no change", () => {
    expect(
      decideDocumentState(doc, {
        file: null,
        pr: { state: "open", merged: false },
      }),
    ).toBeNull();
  });

  it("closed-merged PR but file missing (deleted later) -> no change", () => {
    expect(
      decideDocumentState(doc, {
        file: null,
        pr: { state: "closed", merged: true },
      }),
    ).toBeNull();
  });

  it("no file and no PR (plain draft) -> no change", () => {
    expect(decideDocumentState(doc, { file: null, pr: null })).toBeNull();
  });
});

describe("createGitHubPlanClient (recorded fixtures)", () => {
  const client = createGitHubPlanClient({ token: "t", fetch: fixtureFetch() });

  it("finds a file on the default branch with commit and merged PR", async () => {
    expect(
      await client.getFileOnDefaultBranch(
        "acme/home",
        "planning/s1/SPEC-0001.md",
      ),
    ).toEqual({
      commitSha: "9f8e7d6c5b4a39281706f5e4d3c2b1a099887766",
      prUrl: "https://github.com/acme/home/pull/12",
    });
  });

  it("returns null for a file that 404s", async () => {
    expect(
      await client.getFileOnDefaultBranch(
        "acme/home",
        "planning/s1/SPEC-0002.md",
      ),
    ).toBeNull();
  });

  it("reads PR state", async () => {
    expect(
      await client.getPullRequest("https://github.com/acme/home/pull/13"),
    ).toEqual({ state: "closed", merged: false });
  });

  it("returns null for a non-PR url", async () => {
    expect(await client.getPullRequest("https://example.com/x")).toBeNull();
  });

  it("throws on non-404 errors", async () => {
    const failing = createGitHubPlanClient({
      token: "t",
      fetch: (async () =>
        new Response("{}", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(
      failing.getPullRequest("https://github.com/a/b/pull/1"),
    ).rejects.toThrow("500");
  });
});

describe("githubTokenFromEnv", () => {
  it("prefers GH_TOKEN, falls back to GITHUB_TOKEN, else null", () => {
    expect(githubTokenFromEnv({ GH_TOKEN: "a", GITHUB_TOKEN: "b" })).toBe("a");
    expect(githubTokenFromEnv({ GITHUB_TOKEN: "b" })).toBe("b");
    expect(githubTokenFromEnv({})).toBeNull();
  });
});

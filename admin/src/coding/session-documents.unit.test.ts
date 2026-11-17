/**
 * admin/src/coding/session-documents.unit.test.ts
 * Unit tests for the pure document-link, summary and Mine/All helpers.
 */

import { describe, expect, it } from "bun:test";
import {
  documentLink,
  documentsSummary,
  resolveOwnerView,
  type SessionDocument,
} from "./session-documents.ts";

function doc(overrides: Partial<SessionDocument> = {}): SessionDocument {
  return {
    kind: "spec",
    number: 1,
    repo: "org/home",
    path: "planning/s/SPEC-0001.md",
    owner: "a@example.com",
    prUrl: null,
    state: "merged",
    commitSha: null,
    plannedAt: null,
    ...overrides,
  };
}

describe("documentLink", () => {
  it("links a merged document to the GitHub file at main when no sha", () => {
    expect(documentLink(doc())).toBe(
      "https://github.com/org/home/blob/main/planning/s/SPEC-0001.md",
    );
  });

  it("pins a merged document to its commitSha", () => {
    expect(documentLink(doc({ commitSha: "abc123" }))).toBe(
      "https://github.com/org/home/blob/abc123/planning/s/SPEC-0001.md",
    );
  });

  it("links an unmerged document to its PR", () => {
    expect(
      documentLink(
        doc({ state: "pr_open", prUrl: "https://github.com/org/home/pull/3" }),
      ),
    ).toBe("https://github.com/org/home/pull/3");
  });

  it("returns null for an unmerged document with no PR", () => {
    expect(documentLink(doc({ state: "draft" }))).toBeNull();
  });

  it("returns null for a non-http prUrl", () => {
    expect(
      documentLink(doc({ state: "pr_open", prUrl: "javascript:alert(1)" })),
    ).toBeNull();
  });
});

describe("documentsSummary", () => {
  it("counts specs and flags no attention when all merged", () => {
    expect(
      documentsSummary([doc(), doc({ number: 2 }), doc({ kind: "plan" })]),
    ).toEqual({ specCount: 2, needsAttention: false });
  });

  it.each(["draft", "pr_open", "abandoned"] as const)(
    "flags %s documents",
    (state) => {
      expect(documentsSummary([doc(), doc({ state })]).needsAttention).toBe(
        true,
      );
    },
  );

  it("handles empty/undefined", () => {
    expect(documentsSummary(undefined)).toEqual({
      specCount: 0,
      needsAttention: false,
    });
  });
});

describe("resolveOwnerView", () => {
  const me = "me@example.com";

  it("defaults to mine when the user owns sessions", () => {
    expect(resolveOwnerView(undefined, me, true)).toEqual({
      mode: "mine",
      owner: me,
    });
  });

  it("defaults to all when the user owns nothing", () => {
    expect(resolveOwnerView(undefined, me, false)).toEqual({ mode: "all" });
  });

  it("defaults to all when identity is unknown", () => {
    expect(resolveOwnerView(undefined, "", true)).toEqual({ mode: "all" });
  });

  it("treats empty and 'all' as an explicit All", () => {
    expect(resolveOwnerView("", me, true)).toEqual({ mode: "all" });
    expect(resolveOwnerView("all", me, true)).toEqual({ mode: "all" });
  });

  it("treats owner=<me> as mine, case-insensitively", () => {
    expect(resolveOwnerView("ME@example.com", me, false).mode).toBe("mine");
  });

  it("treats another email as a specific owner filter", () => {
    expect(resolveOwnerView("b@example.com", me, true)).toEqual({
      mode: "owner",
      owner: "b@example.com",
    });
  });
});

import { describe, expect, test } from "bun:test";
import type { CheckPatchDeps } from "./check-patch.ts";
import {
  createPatchStateSnapshotter,
  evaluatePatchOutcome,
  type PatchStateSnapshot,
} from "./patch-outcome-check.ts";

const base: PatchStateSnapshot = {
  headSha: "abcdef1234567",
  findingRefs: ["abcdef1234567@2026-01-01T00:00:00Z"],
  mergeDirty: false,
  ciFailing: false,
};

describe("evaluatePatchOutcome", () => {
  test("settled: nothing left that makes the PR a candidate", () => {
    const after = { ...base, findingRefs: [] };
    // Same head, findings gone is a change; settled needs no before findings either.
    expect(evaluatePatchOutcome({ ...base, findingRefs: [] }, after)).toEqual({
      kind: "settled",
    });
  });

  test("changed: findings settled without a new head", () => {
    expect(evaluatePatchOutcome(base, { ...base, findingRefs: [] }).kind).toBe(
      "changed",
    );
  });

  test("changed: a pushed commit", () => {
    expect(
      evaluatePatchOutcome(base, { ...base, headSha: "fffffff0000000" }).kind,
    ).toBe("changed");
  });

  test("changed: CI resolved or merge conflict cleared", () => {
    const failing = { ...base, findingRefs: [], ciFailing: true };
    expect(
      evaluatePatchOutcome(failing, { ...failing, ciFailing: false }).kind,
    ).toBe("changed");
    const dirty = { ...base, findingRefs: [], mergeDirty: true };
    expect(
      evaluatePatchOutcome(dirty, { ...dirty, mergeDirty: false }).kind,
    ).toBe("changed");
  });

  test("changed: a different unsettled finding set", () => {
    expect(
      evaluatePatchOutcome(base, { ...base, findingRefs: ["thread:T@2"] }).kind,
    ).toBe("changed");
  });

  test("escalated: same head, same unsettled findings — reason names the refs", () => {
    const out = evaluatePatchOutcome(base, { ...base });
    expect(out.kind).toBe("escalated");
    if (out.kind === "escalated") {
      expect(out.reason).toContain(base.findingRefs[0]);
      expect(out.reason).toContain("abcdef1");
    }
  });

  test("escalated: unchanged failing CI / merge conflict", () => {
    const s = { ...base, findingRefs: [], ciFailing: true, mergeDirty: true };
    const out = evaluatePatchOutcome(s, { ...s });
    expect(out.kind).toBe("escalated");
    if (out.kind === "escalated") {
      expect(out.reason).toContain("failing CI");
      expect(out.reason).toContain("merge conflict");
    }
  });
});

describe("createPatchStateSnapshotter", () => {
  function deps(over: Partial<CheckPatchDeps> = {}): CheckPatchDeps {
    return {
      getCurrentUser: async () => "agent",
      getScopedRepos: () => ["acme/x"],
      listOwnOpenPrs: async () => [],
      listPrCommits: async () => [],
      fetchMergeStatus: async () => ({ isDirty: false }),
      fetchCiStatus: async () => ({ hasFailing: false }),
      fetchPrReviews: async () => ({
        headRefOid: "sha1",
        reviews: {
          nodes: [
            {
              author: { login: "bot" },
              state: "COMMENTED",
              submittedAt: "2026-01-01T00:00:00Z",
              commit: { oid: "sha1" },
              body: "no feedback to provide",
            },
          ],
        },
        reviewThreads: { nodes: [] },
        comments: { nodes: [] },
      }),
      ...over,
    };
  }

  test("reports an unsettled bot review by ref", async () => {
    const snap = await createPatchStateSnapshotter(deps())("acme/x#7");
    expect(snap).toEqual({
      headSha: "sha1",
      findingRefs: ["sha1@2026-01-01T00:00:00Z"],
      mergeDirty: false,
      ciFailing: false,
    });
  });

  test("a patch-source rejected ledger entry settles it", async () => {
    const snap = await createPatchStateSnapshotter(
      deps({
        queryPrRecord: async () => ({
          findings: [
            {
              id: "f1",
              prRecordId: "pr1",
              ref: "sha1@2026-01-01T00:00:00Z",
              source: "patch",
              disposition: "rejected",
              evidence: "no actionable feedback",
              at: "2026-01-01T00:00:00Z",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      }),
    )("acme/x#7");
    expect(snap?.findingRefs).toEqual([]);
  });

  test("returns null on a read failure and on a malformed id", async () => {
    const throwing = deps({
      fetchMergeStatus: async () => {
        throw new Error("boom");
      },
    });
    expect(await createPatchStateSnapshotter(throwing)("acme/x#7")).toBeNull();
    expect(await createPatchStateSnapshotter(deps())("nonsense")).toBeNull();
  });
});

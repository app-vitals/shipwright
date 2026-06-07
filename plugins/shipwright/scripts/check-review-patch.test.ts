/**
 * plugins/shipwright/scripts/check-review-patch.test.ts
 *
 * Unit tests for check-review-patch.ts
 *
 * The combined precheck runs check-review logic then check-patch logic.
 * Exits 0 if either sub-check would trigger; exits 1 only when both exit 1.
 *
 * Design: inject `{ reviewDeps, patchDeps }` into the combined `run` function.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-review-patch.ts";

// ─── Types mirroring check-review's Deps ──────────────────────────────────────

interface PrInfo {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  headRefOid: string;
}

interface ReviewEntry {
  pr: number;
  lastReviewedCommit?: string;
  status?: string;
}

// ─── Types mirroring check-patch's Deps ───────────────────────────────────────

interface RunResult {
  exit: 0 | 1;
  output: string;
}

interface CiCheckStatus {
  hasFailing: boolean;
}

interface MergeStatusInfo {
  isBehind: boolean;
  isDirty: boolean;
}

interface OwnPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  repo: string;
}

interface PrReviewData {
  headRefOid: string;
  reviews: { nodes: unknown[] };
  reviewThreads: { nodes: unknown[] };
}

// ─── Dep builders ─────────────────────────────────────────────────────────────

/** Build reviewDeps that exits 0 (one unreviewed PR) */
function makeReviewDepsTriggering() {
  return {
    getCurrentUser: () => "bot-user",
    isSelfReviewAllowed: false,
    listOpenPrs: async (_repo: string): Promise<PrInfo[]> => [
      {
        number: 1,
        title: "Some PR",
        author: { login: "other-user" },
        headRefName: "feat/thing",
        headRefOid: "sha-abc",
      },
    ],
    readReviews: (): ReviewEntry[] => [], // no prior reviews → triggers
    listPrCommits: async (_prNumber: number) => [],
  };
}

/** Build reviewDeps that exits 1 (no work to do) */
function makeReviewDepsIdle() {
  return {
    getCurrentUser: () => "bot-user",
    isSelfReviewAllowed: false,
    listOpenPrs: async (_repo: string): Promise<PrInfo[]> => [],
    readReviews: (): ReviewEntry[] => [],
    listPrCommits: async (_prNumber: number) => [],
  };
}

/** Build patchDeps that exits 0 (failing CI on own PR) */
function makePatchDepsTriggering() {
  return {
    listOwnOpenPrs: async (_repo: string): Promise<OwnPr[]> => [
      {
        number: 10,
        title: "My PR",
        headRefName: "feat/my-pr",
        headRefOid: "sha-xyz",
        repo: "acme/example-repo",
      },
    ],
    fetchPrReviews: async (
      _org: string,
      _repo: string,
      _pr: number,
    ): Promise<PrReviewData> => ({
      headRefOid: "sha-xyz",
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
    }),
    fetchCiStatus: async (
      _org: string,
      _repo: string,
      _pr: number,
    ): Promise<CiCheckStatus> => ({ hasFailing: true }),
    fetchMergeStatus: async (
      _org: string,
      _repo: string,
      _pr: number,
    ): Promise<MergeStatusInfo> => ({ isBehind: false, isDirty: false }),
    updateBranch: async (
      _org: string,
      _repo: string,
      _pr: number,
    ): Promise<void> => {},
  };
}

/** Build patchDeps that exits 1 (nothing to do) */
function makePatchDepsIdle() {
  return {
    listOwnOpenPrs: async (_repo: string): Promise<OwnPr[]> => [],
    fetchPrReviews: async (
      _org: string,
      _repo: string,
      _pr: number,
    ): Promise<PrReviewData> => ({
      headRefOid: "sha-xyz",
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
    }),
    fetchCiStatus: async (
      _org: string,
      _repo: string,
      _pr: number,
    ): Promise<CiCheckStatus> => ({ hasFailing: false }),
    fetchMergeStatus: async (
      _org: string,
      _repo: string,
      _pr: number,
    ): Promise<MergeStatusInfo> => ({ isBehind: false, isDirty: false }),
    updateBranch: async (
      _org: string,
      _repo: string,
      _pr: number,
    ): Promise<void> => {},
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-review-patch (combined precheck)", () => {
  test("exits 0 when only review check triggers (patch is idle)", async () => {
    const result = await run({
      reviewDeps: makeReviewDepsTriggering(),
      patchDeps: makePatchDepsIdle(),
    });
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
    expect(result.output.toLowerCase()).toContain("review");
  });

  test("exits 0 when only patch check triggers (review is idle)", async () => {
    const result = await run({
      reviewDeps: makeReviewDepsIdle(),
      patchDeps: makePatchDepsTriggering(),
    });
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
    expect(result.output.toLowerCase()).toContain("patch");
  });

  test("exits 0 and short-circuits when both would trigger (patch check NOT called)", async () => {
    // Spy to verify patchDeps.listOwnOpenPrs is never called
    let patchCalled = false;
    const patchDepsSpy = {
      ...makePatchDepsTriggering(),
      listOwnOpenPrs: async (_repo: string): Promise<OwnPr[]> => {
        patchCalled = true;
        return [];
      },
    };

    const result = await run({
      reviewDeps: makeReviewDepsTriggering(),
      patchDeps: patchDepsSpy,
    });

    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
    expect(patchCalled).toBe(false); // short-circuited
  });

  test("exits 1 silently when neither review nor patch triggers", async () => {
    const result = await run({
      reviewDeps: makeReviewDepsIdle(),
      patchDeps: makePatchDepsIdle(),
    });
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });
});

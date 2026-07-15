/**
 * agent/src/pr-state-reconciler.unit.test.ts
 *
 * Unit tests for reconcilePrState() — self-heals task-store PullRequest
 * records left state:"open" after an untracked merge/close on GitHub.
 *
 * Uses injected fake task-store list/patch functions and a fake ghJson — no
 * real network/gh calls, per this repo's unit-test isolation contract.
 */

import { describe, expect, test } from "bun:test";
import {
  type GhPrView,
  type PrOpenTaskRecord,
  type PrStateRecord,
  type PrStateReconcilerDeps,
  reconcilePrState,
} from "./pr-state-reconciler.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface ListPrsCall {
  repo: string;
  state: string;
  limit: number;
  offset: number;
}

interface PatchCall {
  id: string;
  fields: Record<string, unknown>;
}

/** Default fake "now" — a fixed, clearly-fake timestamp so tests never rely on the real clock. */
const FAKE_NOW = "2026-07-15T00:00:00.000Z";

interface MakeDepsOptions {
  repos?: string[];
  /** repo -> full page of state:"open" records (pagination is simulated by slicing). */
  openRecords?: Record<string, PrStateRecord[]>;
  /** "repo#prNumber" -> gh view result, or an Error to throw for that lookup. */
  ghResults?: Record<string, GhPrView | Error>;
  pageLimit?: number;
  /** pr_open tasks for the new reconcile-tasks pass; defaults to [] so existing tests are unaffected. */
  prOpenTasks?: PrOpenTaskRecord[];
  /** "repo#branch" -> merged-PR-list result, or an Error to throw, for the branch-fallback path. */
  branchResults?: Record<string, Array<{ number: number }> | Error>;
  /** "repo#prNumber" -> existing task-store PullRequest record, for the taskId backfill lookup. */
  prRecords?: Record<string, PrStateRecord>;
  now?: () => string;
}

function makeDeps({
  repos = ["acme/example-repo"],
  openRecords = {},
  ghResults = {},
  pageLimit = 50,
  prOpenTasks = [],
  branchResults = {},
  prRecords = {},
  now = () => FAKE_NOW,
}: MakeDepsOptions = {}): {
  deps: PrStateReconcilerDeps;
  listCalls: ListPrsCall[];
  patchCalls: PatchCall[];
  taskPatchCalls: PatchCall[];
} {
  const listCalls: ListPrsCall[] = [];
  const patchCalls: PatchCall[] = [];
  const taskPatchCalls: PatchCall[] = [];

  const deps: PrStateReconcilerDeps = {
    repos,
    pageLimit,
    listOpenPrRecords: async (repo: string, limit: number, offset: number) => {
      listCalls.push({ repo, state: "open", limit, offset });
      const all = openRecords[repo] ?? [];
      return all.slice(offset, offset + limit);
    },
    patchPrRecord: async (id: string, fields: Record<string, unknown>) => {
      patchCalls.push({ id, fields });
    },
    ghViewPr: async (repo: string, prNumber: number) => {
      const key = `${repo}#${prNumber}`;
      const result = ghResults[key];
      if (result instanceof Error) throw result;
      if (!result) throw new Error(`no fake gh result configured for ${key}`);
      return result;
    },
    listPrOpenTasks: async () => prOpenTasks,
    updateTaskStatus: async (id: string, fields: Record<string, unknown>) => {
      taskPatchCalls.push({ id, fields });
    },
    ghListMergedPrsForBranch: async (repo: string, branch: string) => {
      const key = `${repo}#${branch}`;
      const result = branchResults[key];
      if (result instanceof Error) throw result;
      return result ?? [];
    },
    findPrRecordByRepoAndPrNumber: async (repo: string, prNumber: number) => {
      const key = `${repo}#${prNumber}`;
      return prRecords[key] ?? null;
    },
    now,
  };

  return { deps, listCalls, patchCalls, taskPatchCalls };
}

function makeRecord(overrides: Partial<PrStateRecord> = {}): PrStateRecord {
  return {
    id: "pr-1",
    repo: "acme/example-repo",
    prNumber: 1,
    state: "open",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reconcilePrState", () => {
  test("open on GitHub stays open — no PATCH issued", async () => {
    const record = makeRecord({ id: "pr-1", prNumber: 1 });
    const { deps, patchCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#1": { state: "OPEN", mergedAt: null },
      },
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(0);
  });

  test("merged on GitHub gets reconciled — state + mergedAt synced, claim fields cleared", async () => {
    const record = makeRecord({ id: "pr-2", prNumber: 2 });
    const { deps, patchCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#2": {
          state: "MERGED",
          mergedAt: "2026-07-14T09:00:00.000Z",
        },
      },
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-2");
    expect(patchCalls[0].fields.state).toBe("merged");
    expect(patchCalls[0].fields.mergedAt).toBe("2026-07-14T09:00:00.000Z");
    expect(patchCalls[0].fields.claimedBy).toBeNull();
    expect(patchCalls[0].fields.claimedAt).toBeNull();
    expect(patchCalls[0].fields.heartbeatAt).toBeNull();
    expect(patchCalls[0].fields.phase).toBeNull();
  });

  test("closed on GitHub gets reconciled — state synced, no mergedAt, claim fields cleared", async () => {
    const record = makeRecord({ id: "pr-3", prNumber: 3 });
    const { deps, patchCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#3": { state: "CLOSED", mergedAt: null },
      },
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-3");
    expect(patchCalls[0].fields.state).toBe("closed");
    expect(patchCalls[0].fields.mergedAt).toBeUndefined();
    expect(patchCalls[0].fields.claimedBy).toBeNull();
    expect(patchCalls[0].fields.claimedAt).toBeNull();
    expect(patchCalls[0].fields.heartbeatAt).toBeNull();
    expect(patchCalls[0].fields.phase).toBeNull();
  });

  test("gh lookup failure for one PR does not abort reconciliation of the others in the same batch", async () => {
    const recordA = makeRecord({ id: "pr-a", prNumber: 10 });
    const recordB = makeRecord({ id: "pr-b", prNumber: 11 });
    const recordC = makeRecord({ id: "pr-c", prNumber: 12 });
    const { deps, patchCalls } = makeDeps({
      openRecords: { "acme/example-repo": [recordA, recordB, recordC] },
      ghResults: {
        "acme/example-repo#10": { state: "MERGED", mergedAt: "2026-07-14T00:00:00.000Z" },
        "acme/example-repo#11": new Error("gh pr view failed: rate limited"),
        "acme/example-repo#12": { state: "CLOSED", mergedAt: null },
      },
    });

    await reconcilePrState(deps);

    // pr-a and pr-c reconciled despite pr-b's lookup failure
    expect(patchCalls).toHaveLength(2);
    const ids = patchCalls.map((c) => c.id).sort();
    expect(ids).toEqual(["pr-a", "pr-c"]);
  });

  test("paginates beyond the default page limit — scans a second page", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) =>
      makeRecord({ id: `pr-p1-${i}`, prNumber: 100 + i }),
    );
    const page2 = Array.from({ length: 1 }, (_, i) =>
      makeRecord({ id: `pr-p2-${i}`, prNumber: 200 + i }),
    );
    const ghResults: Record<string, GhPrView> = {};
    for (const r of [...page1, ...page2]) {
      ghResults[`acme/example-repo#${r.prNumber}`] = { state: "OPEN", mergedAt: null };
    }

    const { deps, listCalls } = makeDeps({
      openRecords: { "acme/example-repo": [...page1, ...page2] },
      ghResults,
      pageLimit: 2,
    });

    await reconcilePrState(deps);

    // Two pages fetched: offset 0 (full page of 2) then offset 2 (partial page of 1)
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]).toMatchObject({ repo: "acme/example-repo", limit: 2, offset: 0 });
    expect(listCalls[1]).toMatchObject({ repo: "acme/example-repo", limit: 2, offset: 2 });
  });

  test("scans multiple repos independently", async () => {
    const recordA = makeRecord({ id: "pr-repoA", repo: "acme/repo-a", prNumber: 1 });
    const recordB = makeRecord({ id: "pr-repoB", repo: "acme/repo-b", prNumber: 1 });
    const { deps, patchCalls } = makeDeps({
      repos: ["acme/repo-a", "acme/repo-b"],
      openRecords: {
        "acme/repo-a": [recordA],
        "acme/repo-b": [recordB],
      },
      ghResults: {
        "acme/repo-a#1": { state: "MERGED", mergedAt: "2026-07-14T00:00:00.000Z" },
        "acme/repo-b#1": { state: "OPEN", mergedAt: null },
      },
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-repoA");
  });

  test("no repos configured — no-op, no PATCH calls", async () => {
    const { deps, patchCalls, listCalls } = makeDeps({ repos: [] });

    await reconcilePrState(deps);

    expect(listCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(0);
  });

  test("no open records for a repo — no-op for that repo", async () => {
    const { deps, patchCalls } = makeDeps({
      repos: ["acme/example-repo"],
      openRecords: {},
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(0);
  });
});

describe("reconcilePrState — pr_open task reconciliation pass", () => {
  test("pr_open task with merged PR (direct path) is reconciled to merged, using GitHub's mergedAt", async () => {
    const task: PrOpenTaskRecord = { id: "task-1", repo: "acme/example-repo", pr: 42 };
    const { deps, taskPatchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#42": { state: "MERGED", mergedAt: "2026-07-10T00:00:00.000Z" },
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-1");
    expect(taskPatchCalls[0].fields.status).toBe("merged");
    expect(taskPatchCalls[0].fields.mergedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(taskPatchCalls[0].fields.pr).toBeUndefined();
  });

  test("pr_open task whose PR has no mergedAt from GitHub falls back to the injected clock", async () => {
    const task: PrOpenTaskRecord = { id: "task-2", repo: "acme/example-repo", pr: 43 };
    const { deps, taskPatchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#43": { state: "MERGED", mergedAt: null },
      },
      now: () => "2026-07-15T12:00:00.000Z",
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].fields.mergedAt).toBe("2026-07-15T12:00:00.000Z");
  });

  test("pr_open task whose PR is still open on GitHub is left untouched — no PATCH", async () => {
    const task: PrOpenTaskRecord = { id: "task-3", repo: "acme/example-repo", pr: 44 };
    const { deps, taskPatchCalls, patchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#44": { state: "OPEN", mergedAt: null },
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(0);
  });

  test("task with no pr number is resolved via the branch fallback", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-4",
      repo: "acme/example-repo",
      branch: "feat/sw-x-y",
    };
    const { deps, taskPatchCalls } = makeDeps({
      prOpenTasks: [task],
      branchResults: {
        "acme/example-repo#feat/sw-x-y": [{ number: 55 }],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-4");
    expect(taskPatchCalls[0].fields.status).toBe("merged");
    expect(taskPatchCalls[0].fields.pr).toBe(55);
    expect(taskPatchCalls[0].fields.mergedAt).toBe(FAKE_NOW);
  });

  test("task with no pr AND no branch is skipped — no PATCH, no throw", async () => {
    const task: PrOpenTaskRecord = { id: "task-5", repo: "acme/example-repo" };
    const { deps, taskPatchCalls } = makeDeps({ prOpenTasks: [task] });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("taskId is backfilled on the matching PR record when it is currently null", async () => {
    const task: PrOpenTaskRecord = { id: "task-6", repo: "acme/example-repo", pr: 60 };
    const { deps, patchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#60": { state: "MERGED", mergedAt: "2026-07-10T00:00:00.000Z" },
      },
      prRecords: {
        "acme/example-repo#60": {
          id: "pr-record-60",
          repo: "acme/example-repo",
          prNumber: 60,
          state: "open",
          taskId: null,
        },
      },
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-record-60");
    expect(patchCalls[0].fields).toEqual({ taskId: "task-6" });
  });

  test("taskId is left untouched when the PR record already has one set", async () => {
    const task: PrOpenTaskRecord = { id: "task-7", repo: "acme/example-repo", pr: 61 };
    const { deps, patchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#61": { state: "MERGED", mergedAt: "2026-07-10T00:00:00.000Z" },
      },
      prRecords: {
        "acme/example-repo#61": {
          id: "pr-record-61",
          repo: "acme/example-repo",
          prNumber: 61,
          state: "open",
          taskId: "some-other-task",
        },
      },
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(0);
  });

  test("a lookup failure for one pr_open task does not abort reconciliation of the others in the batch", async () => {
    const taskA: PrOpenTaskRecord = { id: "task-8", repo: "acme/example-repo", pr: 70 };
    const taskB: PrOpenTaskRecord = { id: "task-9", repo: "acme/example-repo", pr: 71 };
    const { deps, taskPatchCalls } = makeDeps({
      prOpenTasks: [taskA, taskB],
      ghResults: {
        "acme/example-repo#70": new Error("gh pr view failed: rate limited"),
        "acme/example-repo#71": { state: "MERGED", mergedAt: "2026-07-10T00:00:00.000Z" },
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-9");
  });

  test("task.repo without a slash and no configured repos is skipped defensively — no throw", async () => {
    const task: PrOpenTaskRecord = { id: "task-10", repo: "example-repo", pr: 80 };
    const { deps, taskPatchCalls } = makeDeps({ repos: [], prOpenTasks: [task] });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });
});

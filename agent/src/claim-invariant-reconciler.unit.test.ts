/**
 * agent/src/claim-invariant-reconciler.unit.test.ts
 *
 * Unit tests for reconcileClaimInvariant() — TCS-4.1's self-heal pass that
 * scans status:"pending" task-store records for a non-null claimedBy (the
 * exact AGH-3.4 invariant violation shape — a pending task should never be
 * claimed) and releases each one back to unclaimed via
 * `POST /tasks/:id/release`.
 *
 * Uses fully injected task-store-list/release doubles — no real fetch, no
 * global.fetch/global.* overrides — per this repo's unit-test isolation
 * contract. Modeled directly on worktree-reaper.unit.test.ts's structure.
 */

import { describe, expect, test } from "bun:test";
import {
  type ClaimInvariantReconcilerDeps,
  type PendingTaskRecord,
  reconcileClaimInvariant,
} from "./claim-invariant-reconciler.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface MakeDepsOptions {
  scopedRepos?: string[];
  /** repo -> full list of pending task records for that repo (paginated internally by the fake). */
  tasksByRepo?: Record<string, PendingTaskRecord[]>;
  /** repo -> Error to throw from listPendingTasks, if configured (applies to every page for that repo). */
  listErrors?: Record<string, Error>;
  /** task id -> Error to throw from releaseTask, if configured. */
  releaseErrors?: Record<string, Error>;
  pageLimit?: number;
}

function makeDeps(opts: MakeDepsOptions = {}): {
  deps: ClaimInvariantReconcilerDeps;
  releaseCalls: string[];
} {
  const {
    scopedRepos = [],
    tasksByRepo = {},
    listErrors = {},
    releaseErrors = {},
    pageLimit,
  } = opts;

  const releaseCalls: string[] = [];

  const deps: ClaimInvariantReconcilerDeps = {
    getScopedRepos: () => scopedRepos,
    ...(pageLimit !== undefined ? { pageLimit } : {}),
    listPendingTasks: async (repo: string, limit: number, offset: number) => {
      const err = listErrors[repo];
      if (err) throw err;
      const all = tasksByRepo[repo] ?? [];
      return all.slice(offset, offset + limit);
    },
    releaseTask: async (id: string) => {
      releaseCalls.push(id);
      const err = releaseErrors[id];
      if (err) throw err;
    },
  };

  return { deps, releaseCalls };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reconcileClaimInvariant", () => {
  test("flagged-and-healed case: a scoped repo has a pending task with non-null claimedBy — releaseTask is called for it", async () => {
    const { deps, releaseCalls } = makeDeps({
      scopedRepos: ["example-repo"],
      tasksByRepo: {
        "example-repo": [{ id: "task-1", claimedBy: "agent-a" }],
      },
    });

    await reconcileClaimInvariant(deps);

    expect(releaseCalls).toEqual(["task-1"]);
  });

  test("clean-scan case: pending tasks exist but all have claimedBy=null — no releaseTask calls", async () => {
    const { deps, releaseCalls } = makeDeps({
      scopedRepos: ["example-repo"],
      tasksByRepo: {
        "example-repo": [
          { id: "task-1", claimedBy: null },
          { id: "task-2", claimedBy: null },
        ],
      },
    });

    await reconcileClaimInvariant(deps);

    expect(releaseCalls).toEqual([]);
  });

  test("a repo with zero pending tasks is a no-op", async () => {
    const { deps, releaseCalls } = makeDeps({
      scopedRepos: ["example-repo"],
      tasksByRepo: { "example-repo": [] },
    });

    await expect(reconcileClaimInvariant(deps)).resolves.toBeUndefined();
    expect(releaseCalls).toEqual([]);
  });

  test("pagination: pages through listPendingTasks to completion across multiple pages", async () => {
    const tasks: PendingTaskRecord[] = Array.from({ length: 5 }, (_, i) => ({
      id: `task-${i}`,
      claimedBy: i % 2 === 0 ? "agent-x" : null,
    }));
    const { deps, releaseCalls } = makeDeps({
      scopedRepos: ["example-repo"],
      tasksByRepo: { "example-repo": tasks },
      pageLimit: 2,
    });

    await reconcileClaimInvariant(deps);

    // Indices 0, 2, 4 have non-null claimedBy.
    expect(releaseCalls).toEqual(["task-0", "task-2", "task-4"]);
  });

  test("a releaseTask failure is caught and logged; remaining tasks in the batch still processed", async () => {
    const { deps, releaseCalls } = makeDeps({
      scopedRepos: ["example-repo"],
      tasksByRepo: {
        "example-repo": [
          { id: "task-broken", claimedBy: "agent-a" },
          { id: "task-fine", claimedBy: "agent-b" },
        ],
      },
      releaseErrors: {
        "task-broken": new Error("release failed"),
      },
    });

    await expect(reconcileClaimInvariant(deps)).resolves.toBeUndefined();

    expect(releaseCalls).toEqual(["task-broken", "task-fine"]);
  });

  test("a listPendingTasks failure for one repo does not block another scoped repo", async () => {
    const { deps, releaseCalls } = makeDeps({
      scopedRepos: ["broken-repo", "example-repo"],
      tasksByRepo: {
        "example-repo": [{ id: "task-1", claimedBy: "agent-a" }],
      },
      listErrors: {
        "broken-repo": new Error("task-store unreachable"),
      },
    });

    await expect(reconcileClaimInvariant(deps)).resolves.toBeUndefined();

    expect(releaseCalls).toEqual(["task-1"]);
  });

  test("multiple scoped repos are all scanned independently", async () => {
    const { deps, releaseCalls } = makeDeps({
      scopedRepos: ["repo-a", "repo-b"],
      tasksByRepo: {
        "repo-a": [{ id: "a-1", claimedBy: "agent-a" }],
        "repo-b": [
          { id: "b-1", claimedBy: null },
          { id: "b-2", claimedBy: "agent-b" },
        ],
      },
    });

    await reconcileClaimInvariant(deps);

    expect(releaseCalls).toEqual(["a-1", "b-2"]);
  });

  test("no scoped repos — no-op", async () => {
    const { deps, releaseCalls } = makeDeps({ scopedRepos: [] });

    await expect(reconcileClaimInvariant(deps)).resolves.toBeUndefined();
    expect(releaseCalls).toEqual([]);
  });
});

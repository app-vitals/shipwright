/**
 * agent/src/sync-config-clone.unit.test.ts
 *
 * Unit tests for syncClonedRepos() — RSF-4.1's auto-clone step wired into
 * index.ts's syncConfig() tick. Uses fully injected getScopedRepos/exists/
 * cloneRepo doubles — no real filesystem or `gh` calls, no global.fetch/
 * global.* overrides — per this repo's unit-test isolation contract.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type SyncConfigCloneDeps,
  syncClonedRepos,
} from "./sync-config-clone.ts";

const REPOS_DIR = "/data/agent-home/workspace/repos";

interface CloneCall {
  repo: string;
  dest: string;
}

interface MakeDepsOptions {
  scopedRepos?: string[];
  /** repo-dest paths (as computed from reposDir + short name) that already exist on disk. */
  existingDests?: string[];
  /** dest -> Error to throw from cloneRepo, if configured. */
  cloneErrors?: Record<string, Error>;
}

function makeDeps(opts: MakeDepsOptions = {}): {
  deps: SyncConfigCloneDeps;
  cloneCalls: CloneCall[];
} {
  const { scopedRepos = [], existingDests = [], cloneErrors = {} } = opts;
  const cloneCalls: CloneCall[] = [];

  const deps: SyncConfigCloneDeps = {
    getScopedRepos: () => scopedRepos,
    reposDir: REPOS_DIR,
    exists: (path: string) => existingDests.includes(path),
    cloneRepo: async (repo: string, dest: string) => {
      cloneCalls.push({ repo, dest });
      const err = cloneErrors[dest];
      if (err) throw err;
    },
  };

  return { deps, cloneCalls };
}

describe("syncClonedRepos", () => {
  test("AC1: a newly-added repo not present on disk triggers a clone call with the correct destination path", async () => {
    const { deps, cloneCalls } = makeDeps({
      scopedRepos: ["app-vitals/shipwright"],
      existingDests: [],
    });

    await syncClonedRepos(deps);

    expect(cloneCalls).toEqual([
      { repo: "app-vitals/shipwright", dest: join(REPOS_DIR, "shipwright") },
    ]);
  });

  test("AC2: an already-present repo triggers no clone call", async () => {
    const dest = join(REPOS_DIR, "shipwright");
    const { deps, cloneCalls } = makeDeps({
      scopedRepos: ["app-vitals/shipwright"],
      existingDests: [dest],
    });

    await syncClonedRepos(deps);

    expect(cloneCalls).toEqual([]);
  });

  test("AC3: a clone failure is caught and logged without throwing", async () => {
    const dest = join(REPOS_DIR, "shipwright");
    const { deps, cloneCalls } = makeDeps({
      scopedRepos: ["app-vitals/shipwright"],
      existingDests: [],
      cloneErrors: {
        [dest]: new Error("gh repo clone failed for app-vitals/shipwright"),
      },
    });

    await expect(syncClonedRepos(deps)).resolves.toBeUndefined();

    expect(cloneCalls).toEqual([{ repo: "app-vitals/shipwright", dest }]);
  });

  test("a mix of missing and present repos only clones the missing ones", async () => {
    const presentDest = join(REPOS_DIR, "widget");
    const { deps, cloneCalls } = makeDeps({
      scopedRepos: ["app-vitals/shipwright", "app-vitals/widget"],
      existingDests: [presentDest],
    });

    await syncClonedRepos(deps);

    expect(cloneCalls).toEqual([
      { repo: "app-vitals/shipwright", dest: join(REPOS_DIR, "shipwright") },
    ]);
  });

  test("a failed clone does not block a subsequent missing repo from being cloned", async () => {
    const brokenDest = join(REPOS_DIR, "broken-repo");
    const fineDest = join(REPOS_DIR, "fine-repo");
    const { deps, cloneCalls } = makeDeps({
      scopedRepos: ["app-vitals/broken-repo", "app-vitals/fine-repo"],
      existingDests: [],
      cloneErrors: { [brokenDest]: new Error("auth failed") },
    });

    await expect(syncClonedRepos(deps)).resolves.toBeUndefined();

    expect(cloneCalls).toEqual([
      { repo: "app-vitals/broken-repo", dest: brokenDest },
      { repo: "app-vitals/fine-repo", dest: fineDest },
    ]);
  });

  test("empty scoped repos list triggers no clone calls and no exists checks", async () => {
    let existsCalled = false;
    const { deps, cloneCalls } = makeDeps({ scopedRepos: [] });
    const wrappedDeps: SyncConfigCloneDeps = {
      ...deps,
      exists: (path: string) => {
        existsCalled = true;
        return deps.exists(path);
      },
    };

    await syncClonedRepos(wrappedDeps);

    expect(cloneCalls).toEqual([]);
    expect(existsCalled).toBe(false);
  });
});

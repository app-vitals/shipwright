/**
 * agent/src/sync-config-clone.unit.test.ts
 *
 * Unit tests for syncClonedRepos() and makeCloneRepo() — RSF-4.1's auto-clone
 * step wired into index.ts's syncConfig() tick. Uses fully injected
 * getScopedRepos/exists/cloneRepo/removePartialClone doubles and an injected
 * spawner — no real filesystem or `gh` calls, no global.fetch/global.*
 * overrides — per this repo's unit-test isolation contract.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  makeCloneRepo,
  readRemoteOwner,
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
  /** When set, cloneRepo awaits this before resolving (used for overlap tests). */
  cloneGate?: Promise<void>;
  /** When set, removePartialClone throws this. */
  removeError?: Error;
}

function makeDeps(opts: MakeDepsOptions = {}): {
  deps: SyncConfigCloneDeps;
  cloneCalls: CloneCall[];
  removedDests: string[];
} {
  const { scopedRepos = [], existingDests = [], cloneErrors = {} } = opts;
  const cloneCalls: CloneCall[] = [];
  const removedDests: string[] = [];

  const deps: SyncConfigCloneDeps = {
    getScopedRepos: () => scopedRepos,
    reposDir: REPOS_DIR,
    exists: (path: string) => existingDests.includes(path),
    cloneRepo: async (repo: string, dest: string) => {
      cloneCalls.push({ repo, dest });
      if (opts.cloneGate) await opts.cloneGate;
      const err = cloneErrors[dest];
      if (err) throw err;
    },
    removePartialClone: (dest: string) => {
      removedDests.push(dest);
      if (opts.removeError) throw opts.removeError;
    },
  };

  return { deps, cloneCalls, removedDests };
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

  test("a failed clone's partial destination directory is removed so the next tick retries it", async () => {
    const dest = join(REPOS_DIR, "shipwright");
    const { deps, removedDests } = makeDeps({
      scopedRepos: ["app-vitals/shipwright"],
      existingDests: [],
      cloneErrors: { [dest]: new Error("gh repo clone failed") },
    });

    await syncClonedRepos(deps);

    expect(removedDests).toEqual([dest]);
  });

  test("a successful clone leaves its destination directory alone", async () => {
    const { deps, removedDests } = makeDeps({
      scopedRepos: ["app-vitals/shipwright"],
      existingDests: [],
    });

    await syncClonedRepos(deps);

    expect(removedDests).toEqual([]);
  });

  test("a removePartialClone failure is caught and does not throw", async () => {
    const dest = join(REPOS_DIR, "shipwright");
    const { deps, removedDests } = makeDeps({
      scopedRepos: ["app-vitals/shipwright"],
      existingDests: [],
      cloneErrors: { [dest]: new Error("gh repo clone failed") },
      removeError: new Error("EACCES"),
    });

    await expect(syncClonedRepos(deps)).resolves.toBeUndefined();

    expect(removedDests).toEqual([dest]);
  });

  test("an overlapping tick does not start a second clone of an in-flight destination", async () => {
    // index.ts drives syncConfig() with a bare setInterval, which never waits
    // for the previous tick — now that the clone's child process is spawned
    // asynchronously, two ticks can genuinely overlap.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, cloneCalls } = makeDeps({
      scopedRepos: ["app-vitals/shipwright"],
      existingDests: [],
      cloneGate: gate,
    });

    const first = syncClonedRepos(deps);
    // Second tick fires while the first clone is still in flight — `exists()`
    // still reports the destination as missing (gh hasn't created it yet).
    const second = syncClonedRepos(deps);

    release();
    await Promise.all([first, second]);

    expect(cloneCalls).toEqual([
      { repo: "app-vitals/shipwright", dest: join(REPOS_DIR, "shipwright") },
    ]);

    // The in-flight guard releases afterwards, so a later tick clones again.
    await syncClonedRepos(deps);
    expect(cloneCalls).toHaveLength(2);
  });
});

// ─── makeCloneRepo ──────────────────────────────────────────────────────────
//
// The clone's child process must be spawned ASYNCHRONOUSLY (Bun.spawn +
// await proc.exited), never with Bun.spawnSync: this code runs inside the
// long-lived process that also serves the liveness/readiness probes, and a
// synchronous clone would block that process's event loop for the whole
// duration of the clone. The injected spawner mirrors claude.ts's
// `spawner: typeof Bun.spawn = Bun.spawn` convention.

interface FakeSpawnCall {
  cmd: string[];
  opts: { stdout?: unknown; stderr?: unknown; env?: unknown };
}

function fakeSpawner(exitCode: number | Promise<number>): {
  spawn: typeof Bun.spawn;
  calls: FakeSpawnCall[];
} {
  const calls: FakeSpawnCall[] = [];
  const spawn = ((cmd: string[], opts: FakeSpawnCall["opts"]) => {
    calls.push({ cmd, opts });
    return {
      exited:
        typeof exitCode === "number" ? Promise.resolve(exitCode) : exitCode,
    };
  }) as unknown as typeof Bun.spawn;
  return { spawn, calls };
}

describe("makeCloneRepo", () => {
  test("spawns `gh repo clone <repo> <dest>` with inherited stdio and live process.env", async () => {
    const { spawn, calls } = fakeSpawner(0);

    await makeCloneRepo(spawn)(
      "app-vitals/shipwright",
      join(REPOS_DIR, "shipwright"),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toEqual([
      "gh",
      "repo",
      "clone",
      "app-vitals/shipwright",
      join(REPOS_DIR, "shipwright"),
    ]);
    expect(calls[0].opts.stdout).toBe("inherit");
    expect(calls[0].opts.stderr).toBe("inherit");
    // Live process.env — not Bun's startup snapshot — so a GH_TOKEN synced by
    // this very tick reaches `gh`.
    expect(calls[0].opts.env).toBe(process.env);
  });

  test("throws with the exit code when `gh repo clone` fails", async () => {
    const { spawn } = fakeSpawner(1);

    await expect(
      makeCloneRepo(spawn)("app-vitals/shipwright", join(REPOS_DIR, "x")),
    ).rejects.toThrow(
      "gh repo clone failed for app-vitals/shipwright (exit 1)",
    );
  });

  test("awaits the child process asynchronously rather than blocking", async () => {
    let release: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      release = resolve;
    });
    const { spawn } = fakeSpawner(exited);

    let settled = false;
    const clonePromise = makeCloneRepo(spawn)(
      "app-vitals/shipwright",
      join(REPOS_DIR, "shipwright"),
    ).then(() => {
      settled = true;
    });

    // Control returned to the event loop while the child is still running —
    // the proof that this is not a blocking spawnSync.
    await Promise.resolve();
    expect(settled).toBe(false);

    release(0);
    await clonePromise;
    expect(settled).toBe(true);
  });
});

describe("syncClonedRepos name collisions (MGI-3.3)", () => {
  test("skips the later colliding repo and logs an error naming both", async () => {
    const { deps, cloneCalls } = makeDeps({
      scopedRepos: ["acme/api", "globex/api", "acme/web"],
    });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      await syncClonedRepos(deps);
    } finally {
      console.error = orig;
    }

    expect(cloneCalls.map((c) => c.repo)).toEqual(["acme/api", "acme/web"]);
    expect(
      errors.some((e) => e.includes("globex/api") && e.includes("acme/api")),
    ).toBe(true);
  });

  test("an existing folder whose remote owner differs is skipped and logged", async () => {
    const dest = join(REPOS_DIR, "api");
    const { deps, cloneCalls } = makeDeps({
      scopedRepos: ["acme/api"],
      existingDests: [dest],
    });
    deps.getRemoteOwner = () => "globex";
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      await syncClonedRepos(deps);
    } finally {
      console.error = orig;
    }

    expect(cloneCalls).toEqual([]);
    expect(errors.some((e) => e.includes("globex") && e.includes("acme"))).toBe(
      true,
    );
  });

  test("an existing folder with a matching owner (case-insensitive) is not a collision", async () => {
    const dest = join(REPOS_DIR, "api");
    const { deps } = makeDeps({
      scopedRepos: ["Acme/api"],
      existingDests: [dest],
    });
    deps.getRemoteOwner = () => "acme";
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      await syncClonedRepos(deps);
    } finally {
      console.error = orig;
    }
    expect(errors).toEqual([]);
  });
});

describe("readRemoteOwner", () => {
  const fake = (code: number, out: string) =>
    (() => ({
      exitCode: code,
      stdout: Buffer.from(out),
    })) as unknown as typeof Bun.spawnSync;

  test("parses https and ssh origin URLs", () => {
    expect(
      readRemoteOwner("/x", fake(0, "https://github.com/acme/api.git\n")),
    ).toBe("acme");
    expect(
      readRemoteOwner("/x", fake(0, "git@github.com:acme/api.git\n")),
    ).toBe("acme");
  });

  test("returns null when git fails", () => {
    expect(readRemoteOwner("/x", fake(128, ""))).toBeNull();
  });
});

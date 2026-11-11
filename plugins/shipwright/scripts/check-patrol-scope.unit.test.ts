/**
 * plugins/shipwright/scripts/check-patrol-scope.unit.test.ts
 *
 * Unit tests for check-patrol-scope.ts — the shared precheck for the
 * entropy-patrol-maintenance and security-patrol-maintenance crons.
 *
 * Design: the script exports a `run(deps)` function that accepts injected
 * dependencies — `resolveScoped` (a stub for RSF-2.1's resolveScopedRepos())
 * and `repoDirs` (a stub for resolveRepoDirs()'s { repo, dir } pairs). No
 * file I/O, git commands, or network calls are executed.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-patrol-scope.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface RepoDir {
  repo: string;
  dir: string;
}

interface MakeDepsOptions {
  scopedRepos?: string[];
  repoDirs?: RepoDir[];
}

const REPO_A: RepoDir = { repo: "app-vitals/shipwright", dir: "/repos/shipwright" };
const REPO_B: RepoDir = { repo: "app-vitals/squadron", dir: "/repos/squadron" };

function makeDeps(overrides: MakeDepsOptions = {}) {
  return {
    resolveScoped: async () => overrides.scopedRepos ?? [REPO_A.repo],
    repoDirs: overrides.repoDirs ?? [REPO_A, REPO_B],
  };
}

// ─── Fail-closed behavior (AC #2 — config-fetch failure no-ops the tick) ──────

describe("check-patrol-scope — fail closed", () => {
  test("exits 1 with no output when resolveScopedRepos returns [] (config-fetch failure or unconfigured)", async () => {
    const deps = makeDeps({ scopedRepos: [] });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when scoped repos resolve but none match a cloned repo dir", async () => {
    const deps = makeDeps({
      scopedRepos: ["app-vitals/not-cloned"],
      repoDirs: [REPO_A, REPO_B],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });
});

// ─── Success path ──────────────────────────────────────────────────────────────

describe("check-patrol-scope — repo list emission", () => {
  test("exits 0 with a single repo section when exactly one repo is in scope", async () => {
    const deps = makeDeps({ scopedRepos: [REPO_A.repo], repoDirs: [REPO_A, REPO_B] });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain(REPO_A.repo);
    expect(result.output).toContain(REPO_A.dir);
    expect(result.output).not.toContain(REPO_B.repo);
  });

  test("exits 0 with one section per configured repo, mirroring check-docs-freshness.ts's convention", async () => {
    const deps = makeDeps({
      scopedRepos: [REPO_A.repo, REPO_B.repo],
      repoDirs: [REPO_A, REPO_B],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain(`${REPO_A.repo}:\n${REPO_A.dir}`);
    expect(result.output).toContain(`${REPO_B.repo}:\n${REPO_B.dir}`);
    // Sections are separated by a blank line, same join convention as
    // check-docs-freshness.ts's RepoFinding sections.
    expect(result.output).toContain("\n\n");
  });

  test("only emits repos present in both the scoped set and the cloned repoDirs (intersection)", async () => {
    const deps = makeDeps({
      scopedRepos: [REPO_A.repo, "app-vitals/configured-but-not-cloned"],
      repoDirs: [REPO_A, REPO_B],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain(REPO_A.repo);
    expect(result.output).not.toContain("configured-but-not-cloned");
    expect(result.output).not.toContain(REPO_B.repo);
  });
});

#!/usr/bin/env bun
// Fails CI if a PR's aggregate line-coverage percentage decreased relative
// to its base branch. This is the concrete "coverage must not decrease"
// check the PRD's Feature 4 AC #1 depends on — check-coverage.ts (MTC-1.1)
// only gates on an absolute 80% threshold, which says nothing about
// direction of change once a repo is already above it. No new GitHub
// secret is provisioned: the base ref's coverage is computed by checking it
// out into an isolated git worktree (default token / plain git only).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LcovParser, computeAggregateLinePct } from "./check-coverage";

const LCOV_PATH = "coverage/lcov.info";
const DEFAULT_BASE_REF = "main";

export type CoverageDelta = { decreased: boolean };

// Pure comparison — the required unit-testable piece (AC #3). `decreased`
// is true only when current is strictly less than base: a PR that holds
// coverage exactly flat (equal-at-boundary) must pass, not fail.
export function evaluateCoverageDelta(
  currentPct: number,
  basePct: number,
): CoverageDelta {
  return { decreased: currentPct < basePct };
}

// Resolves which ref to compare against: explicit override wins, then
// GITHUB_BASE_REF (set by GitHub Actions on pull_request events, unprefixed
// e.g. "main"), then a hardcoded fallback for local/manual runs.
export function resolveBaseRef(
  override: string | undefined,
  env: Record<string, string | undefined>,
): string {
  return override ?? env.GITHUB_BASE_REF ?? DEFAULT_BASE_REF;
}

// Checks out origin/<baseRef> into an isolated temp worktree, installs deps,
// runs that ref's own test suite with coverage, and returns its aggregate
// line-coverage percentage. Uses `git worktree` (not a stash/checkout) so
// the current working tree — and the PR's own just-produced lcov.info — is
// never disturbed. Always cleans up the worktree, even on failure.
export async function computeBaseCoveragePct(
  baseRef: string,
  run: (
    cmd: string[],
    opts?: { cwd?: string },
  ) => Promise<{ exitCode: number }> = defaultRun,
): Promise<number> {
  const worktreeDir = mkdtempSync(join(tmpdir(), "coverage-base-"));

  try {
    const fetch = await run(["git", "fetch", "origin", baseRef]);
    if (fetch.exitCode !== 0) {
      throw new Error(`Failed to fetch origin/${baseRef}`);
    }

    const add = await run([
      "git",
      "worktree",
      "add",
      "--detach",
      worktreeDir,
      `origin/${baseRef}`,
    ]);
    if (add.exitCode !== 0) {
      throw new Error(`Failed to check out origin/${baseRef} into a worktree`);
    }

    const install = await run(["bun", "install"], { cwd: worktreeDir });
    if (install.exitCode !== 0) {
      throw new Error(`Failed to install dependencies for origin/${baseRef}`);
    }

    const test = await run(
      ["bun", "test", "--coverage", "--coverage-reporter=lcov"],
      { cwd: worktreeDir },
    );
    if (test.exitCode !== 0) {
      throw new Error(`Base ref origin/${baseRef}'s test suite failed to run`);
    }

    const lcov = await Bun.file(join(worktreeDir, LCOV_PATH)).text();
    const files = LcovParser.parse(lcov);
    return computeAggregateLinePct(files);
  } finally {
    // `git worktree remove` deletes both the checked-out directory and the
    // worktree's git metadata in one step. Fall back to a plain rmSync if
    // it fails for any reason (e.g. add() never succeeded) — an orphaned
    // temp directory is a bigger CI-runner nuisance than stale worktree
    // metadata, so the directory must be gone either way.
    const remove = await run([
      "git",
      "worktree",
      "remove",
      "--force",
      worktreeDir,
    ]).catch(() => ({ exitCode: 1 }));
    if (remove.exitCode !== 0) {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  }
}

async function defaultRun(
  cmd: string[],
  opts?: { cwd?: string },
): Promise<{ exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  return { exitCode };
}

async function main() {
  const currentLcov = await Bun.file(LCOV_PATH)
    .text()
    .catch(() => {
      console.error(
        `No coverage file at ${LCOV_PATH}. Run: bun test --coverage --coverage-reporter=lcov`,
      );
      process.exit(1);
    });

  const currentPct = computeAggregateLinePct(LcovParser.parse(currentLcov));

  const baseRefArg = process.argv[2];
  const baseRef = resolveBaseRef(baseRefArg, Bun.env);

  let basePct: number;
  try {
    basePct = await computeBaseCoveragePct(baseRef);
  } catch (err) {
    console.error(
      `❌ Could not compute base coverage for '${baseRef}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
  }

  console.log(
    `Current PR line coverage: ${currentPct.toFixed(2)}%\nBase (${baseRef}) line coverage: ${basePct.toFixed(2)}%`,
  );

  const { decreased } = evaluateCoverageDelta(currentPct, basePct);

  if (decreased) {
    console.error(
      `\n❌ Coverage decreased: ${currentPct.toFixed(2)}% < ${basePct.toFixed(2)}% (base: ${baseRef})`,
    );
    process.exit(1);
  }

  console.log("✅ Coverage did not decrease");
}

if (import.meta.main) {
  await main();
}

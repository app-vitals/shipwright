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

    // Exit code is intentionally ignored here: a non-zero exit means one or
    // more *tests* failed on the base ref (which the `ci` job already gates
    // on separately), not that coverage collection failed — `bun test
    // --coverage` still writes a complete lcov.info even when individual
    // tests fail. Treating a failing test on base as fatal would make this
    // check permanently unable to compute a comparison on any repo with an
    // existing flaky/failing test, which is a stricter (and wrong) failure
    // mode than "coverage decreased".
    await run(["bun", "test", "--coverage", "--coverage-reporter=lcov"], {
      cwd: worktreeDir,
    });

    const lcov = await Bun.file(join(worktreeDir, LCOV_PATH))
      .text()
      .catch(() => {
        throw new Error(
          `Base ref origin/${baseRef} produced no coverage file at ${LCOV_PATH}`,
        );
      });
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

export async function defaultRun(
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

export type CliDeps = {
  readCurrentLcov?: () => Promise<string>;
  computeBase?: (baseRef: string) => Promise<number>;
  argv?: string[];
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
};

// Orchestrates the CLI end to end and returns an exit code, rather than
// calling process.exit directly — the same injectable-dependencies pattern
// as computeBaseCoveragePct's `run` param, so this can be unit tested
// without a real filesystem/subprocess/process.exit.
export async function runCli(deps: CliDeps = {}): Promise<number> {
  const {
    readCurrentLcov = () => Bun.file(LCOV_PATH).text(),
    computeBase = computeBaseCoveragePct,
    argv = process.argv,
    env = Bun.env,
    log = console.log,
    error = console.error,
  } = deps;

  let currentLcov: string;
  try {
    currentLcov = await readCurrentLcov();
  } catch {
    error(
      `No coverage file at ${LCOV_PATH}. Run: bun test --coverage --coverage-reporter=lcov`,
    );
    return 1;
  }

  const currentPct = computeAggregateLinePct(LcovParser.parse(currentLcov));
  const baseRef = resolveBaseRef(argv[2], env);

  let basePct: number;
  try {
    basePct = await computeBase(baseRef);
  } catch (err) {
    error(
      `❌ Could not compute base coverage for '${baseRef}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  log(
    `Current PR line coverage: ${currentPct.toFixed(2)}%\nBase (${baseRef}) line coverage: ${basePct.toFixed(2)}%`,
  );

  const { decreased } = evaluateCoverageDelta(currentPct, basePct);

  if (decreased) {
    error(
      `\n❌ Coverage decreased: ${currentPct.toFixed(2)}% < ${basePct.toFixed(2)}% (base: ${baseRef})`,
    );
    return 1;
  }

  log("✅ Coverage did not decrease");
  return 0;
}

if (import.meta.main) {
  process.exit(await runCli());
}

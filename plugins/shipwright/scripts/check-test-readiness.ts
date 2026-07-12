#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-test-readiness.ts
 *
 * Pre-check for the test-readiness cron.
 *
 * Iterates every repo under repos/ (via resolveRepoDirs — see
 * check-helpers.ts) rather than assuming cwd is a single "configured repo".
 * This cron's agent-level cwd is the workspace root (not a git repo), so a
 * process.cwd()-based single-repo implementation would silently no-op for
 * every configured repo — the same bug PR #1432 fixed for docs-freshness.
 *
 * Qualification per repo: has a docs/test-readiness/ directory. That
 * directory is the opt-in signal — a repo with no docs/test-readiness/ is
 * NOT the implicit target and is skipped cleanly, not silently defaulted to.
 *
 * For each qualifying repo, mirrors the staleness gate documented in
 * skills/test-readiness/SKILL.md (Staleness check section): compares the
 * mtimes of the 4 phase artifacts (relative to that repo's own directory)
 * against a 24h threshold.
 * - If all 4 artifacts are fresh (mtime within 24h) → repo does not qualify
 * - If any artifact is missing or stale (older than 24h) → repo qualifies,
 *   its stale artifact(s) recorded
 *
 * One repo's evaluation failure is isolated (permissive — treated as
 * qualifying) and does not block or suppress findings in other repos.
 *
 * Exit 0 + repo-scoped summary → at least one repo has a stale test-readiness run pending
 * Exit 1 + no output            → nothing to do in any repo
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-test-readiness.ts
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoDirs, resolveWorkspacePath } from "./check-helpers.ts";
import type { RepoDir } from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Deps {
  repos: RepoDir[];
  hasTestReadinessDir: (dir: string) => boolean;
  getMtimeMs: (dir: string, path: string) => number | null;
  now: () => number;
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

interface RepoFinding {
  repo: string;
  staleArtifacts: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * The 4 phase artifacts, in phase order, as documented in
 * skills/test-readiness/SKILL.md. Paths are relative to a repo's own
 * directory.
 */
export const ARTIFACT_PATHS = [
  "docs/test-readiness/test-inventory.md",
  "docs/test-readiness/test-system.md",
  "docs/test-readiness/test-migration.md",
  "docs/test-readiness/test-readiness-plan.md",
] as const;

export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// ─── Per-repo evaluation ───────────────────────────────────────────────────────

function isStale(repoDir: RepoDir, path: string, deps: Deps): boolean {
  const mtimeMs = deps.getMtimeMs(repoDir.dir, path);
  if (mtimeMs === null) return true;
  return deps.now() - mtimeMs > STALE_THRESHOLD_MS;
}

/**
 * Evaluate a single repo. Returns:
 * - "no-opt-in" → repo has no docs/test-readiness/ directory, skip cleanly
 * - "fresh"     → repo opted in but every phase artifact is fresh
 * - a RepoFinding → repo qualifies (one or more stale/missing artifacts)
 */
function evaluateRepo(
  repoDir: RepoDir,
  deps: Deps,
): "no-opt-in" | "fresh" | RepoFinding {
  if (!deps.hasTestReadinessDir(repoDir.dir)) return "no-opt-in";

  const staleArtifacts = ARTIFACT_PATHS.filter((path) =>
    isStale(repoDir, path, deps),
  );

  if (staleArtifacts.length === 0) return "fresh";

  return { repo: repoDir.repo, staleArtifacts };
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function run(deps: Deps): Promise<RunResult> {
  const findings: RepoFinding[] = [];

  for (const repoDir of deps.repos) {
    try {
      const result = evaluateRepo(repoDir, deps);
      if (result === "no-opt-in" || result === "fresh") continue;
      findings.push(result);
    } catch (err) {
      process.stderr.write(
        `check-test-readiness: evaluation failed for ${repoDir.repo}: ${String(err)}\n`,
      );
      // Permissive on unexpected failure — one repo's error must not
      // suppress a real finding in another repo, so still flag it.
      findings.push({ repo: repoDir.repo, staleArtifacts: [...ARTIFACT_PATHS] });
    }
  }

  if (findings.length === 0) return { exit: 1, output: "" };

  const lines = findings.map(
    (f) => `${f.repo}:\n${f.staleArtifacts.join("\n")}`,
  );

  return {
    exit: 0,
    output: `Repos with test-readiness check needed:\n${lines.join("\n\n")}`,
  };
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  const workspacePath = resolveWorkspacePath();
  const repos = resolveRepoDirs(workspacePath);

  return {
    repos,

    hasTestReadinessDir: (dir: string): boolean =>
      existsSync(join(dir, "docs", "test-readiness")),

    getMtimeMs: (dir: string, path: string): number | null => {
      const fullPath = join(dir, path);
      if (!existsSync(fullPath)) return null;
      try {
        return statSync(fullPath).mtimeMs;
      } catch {
        return null;
      }
    },

    now: (): number => Date.now(),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const deps = buildProductionDeps();
  const result = await run(deps);
  if (result.exit === 0) {
    process.stdout.write(`${result.output}\n`);
  }
  process.exit(result.exit);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exit(2);
  });
}

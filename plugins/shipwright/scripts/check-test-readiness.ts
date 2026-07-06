#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-test-readiness.ts
 *
 * Pre-check for the test-readiness cron.
 *
 * Mirrors the staleness gate documented in
 * skills/test-readiness/SKILL.md (Staleness check section): compares the
 * mtimes of the 4 phase artifacts against a 24h threshold.
 * - If all 4 artifacts are fresh (mtime within 24h) → exit 1 (nothing to do)
 * - If any artifact is missing or stale (older than 24h) → exit 0 with a
 *   summary of the stale artifact(s)
 *
 * Exit 0 + summary → run the test-readiness skill
 * Exit 1 + no output → nothing to do
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-test-readiness.ts
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Deps {
  getMtimeMs: (path: string) => number | null;
  now: () => number;
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * The 4 phase artifacts, in phase order, as documented in
 * skills/test-readiness/SKILL.md.
 */
export const ARTIFACT_PATHS = [
  "docs/test-readiness/test-inventory.md",
  "docs/test-readiness/test-system.md",
  "docs/test-readiness/test-migration.md",
  "docs/test-readiness/test-readiness-plan.md",
] as const;

export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// ─── Core logic ───────────────────────────────────────────────────────────────

function isStale(path: string, deps: Deps): boolean {
  const mtimeMs = deps.getMtimeMs(path);
  if (mtimeMs === null) return true;
  return deps.now() - mtimeMs > STALE_THRESHOLD_MS;
}

export async function run(deps: Deps): Promise<RunResult> {
  const staleArtifacts = ARTIFACT_PATHS.filter((path) => isStale(path, deps));

  if (staleArtifacts.length === 0) {
    return { exit: 1, output: "" };
  }

  const output = `Stale or missing test-readiness artifacts:\n${staleArtifacts.join("\n")}`;
  return { exit: 0, output };
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  const cwd = process.cwd();

  return {
    getMtimeMs: (path: string): number | null => {
      const fullPath = join(cwd, path);
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

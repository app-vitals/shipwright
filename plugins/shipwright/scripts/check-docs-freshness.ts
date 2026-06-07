#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-docs-freshness.ts
 *
 * Pre-check for the docs-freshness cron.
 *
 * Reads state/docs-last-synced.json to get the last-synced SHA.
 * - If absent → exit 0 (first run, always worth running)
 * - If no commits since SHA → exit 1 (nothing to check)
 * - If commits exist but only docs/state/.github changes → exit 1 (no source changes)
 * - If source files changed → exit 0 with changed-file summary as stdout
 *
 * Exit 0 + file list → source files changed, run the docs check
 * Exit 1 + no output  → nothing to do
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-docs-freshness.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Deps {
  readSyncAnchor: () => string | null;
  getCommitsSince: (sha: string) => string[] | null;
  getChangedFilesSince: (sha: string) => string[] | null;
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

// ─── Filter logic ─────────────────────────────────────────────────────────────

/**
 * Returns true if the path is a source file worth checking.
 * Excluded: docs/, state/, .github/
 */
function isSourceFile(path: string): boolean {
  if (path.startsWith("docs/")) return false;
  if (path.startsWith("state/")) return false;
  if (path.startsWith(".github/")) return false;
  return true;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function run(deps: Deps): Promise<RunResult> {
  const sha = deps.readSyncAnchor();

  // First run — no anchor, always worth checking
  if (sha === null) {
    return {
      exit: 0,
      output: "No sync anchor found — running full docs check.",
    };
  }

  const commits = deps.getCommitsSince(sha);

  // Git failure — unknown state, exit permissively
  if (commits === null) {
    return { exit: 0, output: "" };
  }

  // No commits since last sync — nothing to check
  if (commits.length === 0) {
    return { exit: 1, output: "" };
  }

  const changedFiles = deps.getChangedFilesSince(sha);

  // Git failure — unknown state, exit permissively
  if (changedFiles === null) {
    return { exit: 0, output: "" };
  }
  const sourceFiles = changedFiles.filter(isSourceFile);

  // Only non-source files changed (docs, state, .github) — skip
  if (sourceFiles.length === 0) {
    return { exit: 1, output: "" };
  }

  // Source files changed — run the docs check
  const output = `Source files changed since last sync:\n${sourceFiles.join("\n")}`;
  return { exit: 0, output };
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  const cwd = process.cwd();

  return {
    readSyncAnchor: (): string | null => {
      const anchorPath = join(cwd, "state", "docs-last-synced.json");
      if (!existsSync(anchorPath)) return null;
      try {
        const data = JSON.parse(readFileSync(anchorPath, "utf-8")) as {
          sha?: string;
        };
        return data.sha ?? null;
      } catch {
        return null;
      }
    },

    getCommitsSince: (sha: string): string[] | null => {
      const result = spawnSync("git", ["log", `${sha}...HEAD`, "--oneline"], {
        cwd,
        encoding: "utf-8",
      });
      if (result.error || result.status !== 0) {
        process.stderr.write(
          "check-docs-freshness: git log failed — skipping permissively\n",
        );
        return null;
      }
      return (result.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    },

    getChangedFilesSince: (sha: string): string[] | null => {
      const result = spawnSync(
        "git",
        ["diff", `${sha}...HEAD`, "--name-only"],
        { cwd, encoding: "utf-8" },
      );
      if (result.error || result.status !== 0) {
        process.stderr.write(
          "check-docs-freshness: git diff failed — skipping permissively\n",
        );
        return null;
      }
      return (result.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    },
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

#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-docs-freshness.ts
 *
 * Pre-check for the docs-freshness cron.
 *
 * Iterates every repo under repos/ (via resolveRepoDirs — see
 * check-helpers.ts) rather than assuming cwd is a single target repo. This
 * cron's agent-level cwd is the workspace root (not a git repo), so a
 * process.cwd()-based single-repo implementation would silently no-op for
 * every configured repo.
 *
 * For each repo:
 * - No docs/ directory → skip cleanly, no anchor read/write, no output
 * - Reads that repo's own state/docs-last-synced.json to get the
 *   last-synced SHA
 *   - If absent → repo qualifies (first run, always worth running)
 *   - If no commits since SHA → repo does not qualify
 *   - If commits exist but only docs/state/.github changes → does not qualify
 *   - If source files changed → repo qualifies, changed-file summary recorded
 *
 * One repo's git failure is isolated (permissive — treated as qualifying)
 * and does not block or suppress findings in other repos.
 *
 * Exit 0 + repo-scoped summary → at least one repo has source changes worth checking
 * Exit 1 + no output            → nothing to do in any repo
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-docs-freshness.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoDirs, resolveWorkspacePath } from "./check-helpers.ts";
import type { RepoDir } from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Deps {
  repos: RepoDir[];
  hasDocsDir: (dir: string) => boolean;
  readSyncAnchor: (dir: string) => string | null;
  getCommitsSince: (dir: string, sha: string) => string[] | null;
  getChangedFilesSince: (dir: string, sha: string) => string[] | null;
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

interface RepoFinding {
  repo: string;
  sourceFiles: string[];
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

// ─── Per-repo evaluation ───────────────────────────────────────────────────────

/**
 * Evaluate a single repo. Returns:
 * - "no-docs"    → repo has no docs/ directory, skip cleanly
 * - "no-change"  → repo has an anchor but nothing worth checking since it
 * - a RepoFinding → repo qualifies (first run, or source files changed)
 */
function evaluateRepo(
  repoDir: RepoDir,
  deps: Deps,
): "no-docs" | "no-change" | RepoFinding {
  if (!deps.hasDocsDir(repoDir.dir)) return "no-docs";

  const sha = deps.readSyncAnchor(repoDir.dir);

  // First run — no anchor, always worth checking
  if (sha === null) {
    return { repo: repoDir.repo, sourceFiles: [] };
  }

  const commits = deps.getCommitsSince(repoDir.dir, sha);

  // Git failure — unknown state, treat as qualifying (permissive)
  if (commits === null) {
    return { repo: repoDir.repo, sourceFiles: [] };
  }

  // No commits since last sync — nothing to check
  if (commits.length === 0) return "no-change";

  const changedFiles = deps.getChangedFilesSince(repoDir.dir, sha);

  // Git failure — unknown state, treat as qualifying (permissive)
  if (changedFiles === null) {
    return { repo: repoDir.repo, sourceFiles: [] };
  }

  const sourceFiles = changedFiles.filter(isSourceFile);

  // Only non-source files changed (docs, state, .github) — skip
  if (sourceFiles.length === 0) return "no-change";

  return { repo: repoDir.repo, sourceFiles };
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function run(deps: Deps): Promise<RunResult> {
  const findings: RepoFinding[] = [];

  for (const repoDir of deps.repos) {
    try {
      const result = evaluateRepo(repoDir, deps);
      if (result === "no-docs" || result === "no-change") continue;
      findings.push(result);
    } catch (err) {
      process.stderr.write(
        `check-docs-freshness: evaluation failed for ${repoDir.repo}: ${String(err)}\n`,
      );
      // Permissive on unexpected failure — one repo's error must not
      // suppress a real finding in another repo, so still flag it.
      findings.push({ repo: repoDir.repo, sourceFiles: [] });
    }
  }

  if (findings.length === 0) return { exit: 1, output: "" };

  const lines = findings.map((f) =>
    f.sourceFiles.length > 0
      ? `${f.repo}:\n${f.sourceFiles.join("\n")}`
      : `${f.repo}: no sync anchor found — run full docs check`,
  );

  return {
    exit: 0,
    output: `Repos with docs check needed:\n${lines.join("\n\n")}`,
  };
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  const workspacePath = resolveWorkspacePath();
  const repos = resolveRepoDirs(workspacePath);

  return {
    repos,

    hasDocsDir: (dir: string): boolean => existsSync(join(dir, "docs")),

    readSyncAnchor: (dir: string): string | null => {
      const anchorPath = join(dir, "state", "docs-last-synced.json");
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

    getCommitsSince: (dir: string, sha: string): string[] | null => {
      const result = spawnSync("git", ["log", `${sha}...HEAD`, "--oneline"], {
        cwd: dir,
        encoding: "utf-8",
      });
      if (result.error || result.status !== 0) {
        process.stderr.write(
          `check-docs-freshness: git log failed for ${dir} — skipping permissively\n`,
        );
        return null;
      }
      return (result.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    },

    getChangedFilesSince: (dir: string, sha: string): string[] | null => {
      const result = spawnSync(
        "git",
        ["diff", `${sha}...HEAD`, "--name-only"],
        { cwd: dir, encoding: "utf-8" },
      );
      if (result.error || result.status !== 0) {
        process.stderr.write(
          `check-docs-freshness: git diff failed for ${dir} — skipping permissively\n`,
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

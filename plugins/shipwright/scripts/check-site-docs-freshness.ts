#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-site-docs-freshness.ts
 *
 * Pre-check for a site-docs-freshness cron (not yet wired up — see SDR-4).
 *
 * Mirrors check-docs-freshness.ts's pattern (repo-scoped anchor +
 * getCommitsSince/getChangedFilesSince + exit 0/1 contract), but this script
 * is PAGE-scoped instead of repo-scoped: it operates on exactly one repo
 * (this repo, cwd) and reads site/docs-source-map.json (built by SDR-1) —
 * `{ "<page>.mdx": ["<source path>", ...] }` — to get N pages, each with its
 * OWN last-synced anchor SHA (not one shared repo-wide anchor).
 *
 * For each page in the source map:
 * - No anchor entry for that page (whether the anchor file itself is
 *   missing, or the file exists but this page has no entry yet — e.g. a
 *   page added to the source map after the anchor file was first created)
 *   → page qualifies (first run, always worth checking)
 * - Anchor exists but no commits touch any of the page's mapped source
 *   paths since that SHA → page does not qualify
 * - Commits exist and touch a mapped source path → page qualifies,
 *   changed-file summary recorded
 *
 * One page's git failure is isolated (permissive — treated as qualifying)
 * and does not block or suppress findings for other pages.
 *
 * Exit 0 + page-scoped summary → at least one page has source changes worth checking
 * Exit 1 + no output           → nothing to do for any page
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-site-docs-freshness.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Anchor {
  sha: string;
  timestamp: string;
}

interface Deps {
  sourceMap: Record<string, string[]>;
  readAnchor: (page: string) => Anchor | null;
  getCommitsSince: (paths: string[], sha: string) => string[] | null;
  getChangedFilesSince: (paths: string[], sha: string) => string[] | null;
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

interface PageFinding {
  page: string;
  changedFiles: string[];
}

// ─── Per-page evaluation ───────────────────────────────────────────────────────

/**
 * Evaluate a single page. Returns:
 * - "no-change"    → page has no mapped source paths at all, or has an anchor
 *                     but nothing changed in its mapped source paths since it
 * - a PageFinding  → page qualifies (first run, or mapped source paths changed)
 */
function evaluatePage(
  page: string,
  sourcePaths: string[],
  deps: Deps,
): "no-change" | PageFinding {
  // A page mapped to zero source paths (permitted by the source map's schema,
  // paired with a `_notes` entry explaining it has no repo-doc source) has
  // nothing in this repo that could make it stale. Short-circuit before the
  // git helpers: passing an empty pathspec list to `git log/diff <range> --`
  // means NO path restriction (matches every commit), not "match nothing",
  // which would flag such a page on any unrelated commit since its anchor.
  if (sourcePaths.length === 0) return "no-change";

  const anchor = deps.readAnchor(page);

  // First run — no anchor for this page yet, always worth checking
  if (anchor === null) {
    return { page, changedFiles: [] };
  }

  const commits = deps.getCommitsSince(sourcePaths, anchor.sha);

  // Git failure — unknown state, treat as qualifying (permissive)
  if (commits === null) {
    return { page, changedFiles: [] };
  }

  // No commits touching this page's mapped source paths since last sync
  if (commits.length === 0) return "no-change";

  const changedFiles = deps.getChangedFilesSince(sourcePaths, anchor.sha);

  // Git failure — unknown state, treat as qualifying (permissive)
  if (changedFiles === null) {
    return { page, changedFiles: [] };
  }

  // Commits exist but touched nothing under this page's mapped source paths
  if (changedFiles.length === 0) return "no-change";

  return { page, changedFiles };
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function run(deps: Deps): Promise<RunResult> {
  const findings: PageFinding[] = [];

  for (const [page, sourcePaths] of Object.entries(deps.sourceMap)) {
    try {
      const result = evaluatePage(page, sourcePaths, deps);
      if (result === "no-change") continue;
      findings.push(result);
    } catch (err) {
      process.stderr.write(
        `check-site-docs-freshness: evaluation failed for ${page}: ${String(err)}\n`,
      );
      // Permissive on unexpected failure — one page's error must not
      // suppress a real finding for another page, so still flag it.
      findings.push({ page, changedFiles: [] });
    }
  }

  if (findings.length === 0) return { exit: 1, output: "" };

  const lines = findings.map((f) =>
    f.changedFiles.length > 0
      ? `${f.page}:\n${f.changedFiles.join("\n")}`
      : `${f.page}: no sync anchor found — run full docs check`,
  );

  return {
    exit: 0,
    output: `Site pages with docs check needed:\n${lines.join("\n\n")}`,
  };
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  // This script lives inside the same repo whose site it checks — resolve
  // the repo root from the script's own location (scripts/ → shipwright/ →
  // plugins/ → root) rather than assuming a workspace/repos/<name> layout,
  // so it works the same whether invoked from a `repos/` clone or a
  // `worktrees/` checkout.
  const scriptDir = import.meta.dirname ?? process.cwd();
  const repoDir = join(scriptDir, "..", "..", "..");
  const sourceMapPath = join(repoDir, "site", "docs-source-map.json");
  const anchorPath = join(repoDir, "state", "site-docs-last-synced.json");

  const readSourceMap = (): Record<string, string[]> => {
    if (!existsSync(sourceMapPath)) return {};
    try {
      const data = JSON.parse(readFileSync(sourceMapPath, "utf-8")) as Record<
        string,
        unknown
      >;
      const sourceMap: Record<string, string[]> = {};
      for (const [page, value] of Object.entries(data)) {
        if (page.startsWith("_")) continue;
        if (Array.isArray(value)) sourceMap[page] = value as string[];
      }
      return sourceMap;
    } catch {
      return {};
    }
  };

  const readAllAnchors = (): Record<string, Anchor> => {
    if (!existsSync(anchorPath)) return {};
    try {
      return JSON.parse(readFileSync(anchorPath, "utf-8")) as Record<
        string,
        Anchor
      >;
    } catch {
      return {};
    }
  };
  const anchors = readAllAnchors();

  return {
    sourceMap: readSourceMap(),

    readAnchor: (page: string): Anchor | null => anchors[page] ?? null,

    getCommitsSince: (paths: string[], sha: string): string[] | null => {
      const result = spawnSync(
        "git",
        ["log", `${sha}...HEAD`, "--oneline", "--", ...paths],
        { cwd: repoDir, encoding: "utf-8" },
      );
      if (result.error || result.status !== 0) {
        process.stderr.write(
          `check-site-docs-freshness: git log failed for ${paths.join(", ")} — skipping permissively\n`,
        );
        return null;
      }
      return (result.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    },

    getChangedFilesSince: (paths: string[], sha: string): string[] | null => {
      const result = spawnSync(
        "git",
        ["diff", `${sha}...HEAD`, "--name-only", "--", ...paths],
        { cwd: repoDir, encoding: "utf-8" },
      );
      if (result.error || result.status !== 0) {
        process.stderr.write(
          `check-site-docs-freshness: git diff failed for ${paths.join(", ")} — skipping permissively\n`,
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

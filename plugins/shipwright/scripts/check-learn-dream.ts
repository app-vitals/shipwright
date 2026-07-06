#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-learn-dream.ts
 *
 * Pre-check for the learn-dream cron.
 *
 * Reads state/learn-dream-last-run.json to get the last-run timestamp.
 * - If absent → exit 0 (first run, always worth running)
 * - If no session transcript is newer than the anchor → exit 1 (nothing new to learn from)
 * - If at least one transcript is newer → exit 0 with a short summary as stdout
 *
 * This is a coarser gate than the other prechecks in this plan — it can only
 * rule out the zero-activity case, not judge whether the activity contains a
 * worthwhile learning. That judgement is left to the learn-dream skill itself.
 *
 * Exit 0 + summary → transcript activity since last run, run the dream job
 * Exit 1 + no output → nothing to do
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-learn-dream.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveWorkspacePath } from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Deps {
  readLastRunAnchor: () => string | null;
  listTranscriptMtimes: () => number[] | null;
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function run(deps: Deps): Promise<RunResult> {
  const lastRun = deps.readLastRunAnchor();

  // First run — no anchor, always worth checking
  if (lastRun === null) {
    return {
      exit: 0,
      output: "No last-run anchor found — running full learn-dream check.",
    };
  }

  const anchorMs = Date.parse(lastRun);

  const mtimes = deps.listTranscriptMtimes();

  // Read failure — unknown state, exit permissively
  if (mtimes === null) {
    return { exit: 0, output: "" };
  }

  // Anchor unparsable — unknown state, exit permissively
  if (Number.isNaN(anchorMs)) {
    return { exit: 0, output: "" };
  }

  const newerCount = mtimes.filter((mtime) => mtime > anchorMs).length;

  // No transcript activity since last run — nothing to do
  if (newerCount === 0) {
    return { exit: 1, output: "" };
  }

  return {
    exit: 0,
    output: `${newerCount} transcript file(s) newer than last run — running learn-dream check.`,
  };
}

// ─── Production deps ──────────────────────────────────────────────────────────

/**
 * Derive the Claude Code project directory name for a workspace path, the
 * same way Claude Code itself does: the absolute path with `/` replaced by
 * `-` (e.g. `/data/agent-home/workspace` → `-data-agent-home-workspace`).
 */
export function sanitizeWorkspacePathForClaudeProjects(
  workspacePath: string,
): string {
  return workspacePath.replace(/\//g, "-");
}

function buildProductionDeps(): Deps {
  const cwd = process.cwd();

  return {
    readLastRunAnchor: (): string | null => {
      const anchorPath = join(cwd, "state", "learn-dream-last-run.json");
      if (!existsSync(anchorPath)) return null;
      try {
        const data = JSON.parse(readFileSync(anchorPath, "utf-8")) as {
          lastRun?: string;
        };
        return data.lastRun ?? null;
      } catch {
        return null;
      }
    },

    listTranscriptMtimes: (): number[] | null => {
      try {
        const workspacePath = resolveWorkspacePath();
        const projectDirName =
          sanitizeWorkspacePathForClaudeProjects(workspacePath);
        const projectDir = join(
          homedir(),
          ".claude",
          "projects",
          projectDirName,
        );
        if (!existsSync(projectDir)) return null;
        const entries = readdirSync(projectDir);
        const jsonlFiles = entries.filter((entry) => entry.endsWith(".jsonl"));
        return jsonlFiles.map(
          (file) => statSync(join(projectDir, file)).mtimeMs,
        );
      } catch {
        return null;
      }
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

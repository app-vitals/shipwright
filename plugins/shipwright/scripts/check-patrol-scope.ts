#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-patrol-scope.ts
 *
 * Shared pre-check for the entropy-patrol-maintenance and
 * security-patrol-maintenance crons. Neither /shipwright:entropy-scan nor
 * /shipwright:security-scan has multi-repo handling of its own, and their
 * crons dispatch a bare prompt with no repo argument — without this
 * precheck the agent has to improvise which repo(s) to scan.
 *
 * Resolves the agent's configured repos via resolveScopedRepos() (RSF-2.1's
 * config-driven resolver — the intersection of the agent's configured
 * repos[] and what's actually cloned into the workspace), then pairs each
 * resolved repo with its local clone directory via resolveRepoDirs().
 *
 * Fails closed: if resolveScopedRepos() returns [] for any reason (missing
 * agent config env vars, a fetch failure, a non-2xx response, or simply zero
 * configured repos), this exits 1 (no-op the tick) rather than falling back
 * to an unfiltered filesystem scan — consistent with resolveScopedRepos()'s
 * own fail-closed contract. Per the preCheck contract (see
 * docs/agent-ops.md / cron-handler.ts), exit 1 with no output skips the tick
 * silently — no Claude turn is spent.
 *
 * On success, emits one section per scoped repo (org/repo + local clone
 * dir), mirroring check-docs-freshness.ts's per-repo stdout convention, so
 * entropy-scan/SKILL.md and security-scan/SKILL.md can parse the repo list
 * straight out of the invoking prompt.
 *
 * Exit 0 + repo-scoped list → at least one configured repo is in scope
 * Exit 1 + no output        → no repos resolved (unconfigured, fetch
 *                              failure, or nothing cloned) — fail closed
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-patrol-scope.ts
 */

import {
  resolveRepoDirs,
  resolveScopedRepos,
  resolveWorkspacePath,
} from "./check-helpers.ts";
import type { RepoDir } from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Deps {
  resolveScoped: () => Promise<string[]>;
  repoDirs: RepoDir[];
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function run(deps: Deps): Promise<RunResult> {
  const scopedRepos = await deps.resolveScoped();
  if (scopedRepos.length === 0) return { exit: 1, output: "" };

  const scoped = new Set(scopedRepos);
  const matched = deps.repoDirs.filter((repoDir) => scoped.has(repoDir.repo));

  if (matched.length === 0) return { exit: 1, output: "" };

  const lines = matched.map((repoDir) => `${repoDir.repo}:\n${repoDir.dir}`);

  return {
    exit: 0,
    output: `Repos in scope for this patrol:\n${lines.join("\n\n")}`,
  };
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  const workspacePath = resolveWorkspacePath();

  return {
    resolveScoped: () => resolveScopedRepos(workspacePath),
    repoDirs: resolveRepoDirs(workspacePath),
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

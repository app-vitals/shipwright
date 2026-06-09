#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-review-patch.ts
 *
 * Combined precheck for the review-patch cron.
 *
 * Runs check-review logic then check-patch logic. Exits 0 (with a one-line
 * prompt) if either sub-check would trigger. Exits 1 (silent) only when both
 * sub-checks return exit 1, meaning there is genuinely nothing to do.
 *
 * This avoids spawning the orchestrator session unnecessarily.
 *
 * Exit 0 + one-line prompt → at least one sub-check has work to do
 * Exit 1 + no output       → nothing to do (both sub-checks idle)
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-review-patch.ts
 */

import {
  type Deps as PatchDeps,
  buildProductionDeps as buildPatchProductionDeps,
  run as runPatch,
} from "./check-patch.ts";
import {
  buildProductionDeps as buildReviewProductionDeps,
  run as runReview,
} from "./check-review.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

type ReviewDeps = Awaited<ReturnType<typeof buildReviewProductionDeps>>;

export interface Deps {
  reviewDeps: ReviewDeps;
  patchDeps: PatchDeps;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

interface RunResult {
  exit: 0 | 1;
  output: string;
}

export async function run(deps: Deps): Promise<RunResult> {
  // Try review check first
  const reviewResult = await runReview(deps.reviewDeps);
  if (reviewResult.exit === 0) {
    return reviewResult;
  }

  // Fall through to patch check
  return runPatch(deps.patchDeps);
}

// ─── Production deps ──────────────────────────────────────────────────────────

async function buildProductionDeps(): Promise<Deps> {
  const [reviewDeps, patchDeps] = await Promise.all([
    buildReviewProductionDeps(),
    buildPatchProductionDeps(),
  ]);
  return { reviewDeps, patchDeps };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const deps = await buildProductionDeps();
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

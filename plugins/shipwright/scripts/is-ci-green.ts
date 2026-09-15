#!/usr/bin/env bun
// Shared CI-green classifier (CIG-1.1).
//
// Extracts the "dedup to latest run per workflow, then require every
// deduped run to be green" logic documented in
// plugins/shipwright/commands/dev-task.md's Step 9b.2 CI Gate into a pure,
// standalone function, plus a CLI entrypoint that takes the same JSON shape
// returned by `gh api repos/{owner}/{repo}/actions/runs?head_sha=...`.
//
// Deliberately has no dependency on @shipwright/lib or any other workspace
// package — plugins/shipwright must stay installable standalone into other
// repos (see plugins/shipwright/CLAUDE.md).
//
// CLI:
//   bun run plugins/shipwright/scripts/is-ci-green.ts '[{"workflow_id":1,"run_number":1,"conclusion":"success"}]'
// or pipe the same JSON array via stdin.

// ─── Types ────────────────────────────────────────────────────────────────────

export type WorkflowRun = {
  workflow_id: number;
  run_number: number;
  conclusion: string | null;
};

// ─── isCiGreen ────────────────────────────────────────────────────────────────
//
// Green conclusions: success, skipped, neutral.
// Not green: failure, cancelled, timed_out, action_required, stale,
// startup_failure, and null (not-yet-concluded — e.g. queued/in_progress).
//
// Classification:
//   1. An empty run list is fail-closed: false.
//   2. Dedup to the latest run per workflow_id (highest run_number in each
//      group) — stale reruns are discarded so a superseded failure doesn't
//      poison the result, and a superseded success doesn't mask a real
//      failure in the latest rerun.
//   3. The deduped set is green only if every run in it has a green
//      conclusion.
const GREEN_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

export function isCiGreen(runs: WorkflowRun[]): boolean {
  if (runs.length === 0) return false;

  const latestByWorkflow = new Map<number, WorkflowRun>();
  for (const run of runs) {
    const current = latestByWorkflow.get(run.workflow_id);
    if (!current || run.run_number > current.run_number) {
      latestByWorkflow.set(run.workflow_id, run);
    }
  }

  for (const run of latestByWorkflow.values()) {
    if (run.conclusion === null || !GREEN_CONCLUSIONS.has(run.conclusion)) {
      return false;
    }
  }

  return true;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseCliInput(raw: string): WorkflowRun[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Input JSON must be an array of workflow run objects");
  }
  return parsed as WorkflowRun[];
}

if (import.meta.main) {
  const arg = process.argv[2];
  const raw = arg && arg.length > 0 ? arg : await Bun.stdin.text();
  const runs = parseCliInput(raw);
  const result = isCiGreen(runs);
  console.log(result);
}

/**
 * agent/src/work-selector.ts
 *
 * Pure helper: selectNextWorkItem(tasks, prs) → WorkItem | null
 *
 * Given a list of ready tasks (aged by createdAt) and a list of ready PRs
 * (aged by COALESCE(readyForReviewAt, readyForPatchAt, readyForDeployAt),
 * already filtered by the caller to only the pipeline phases currently
 * enabled), returns the single oldest ready item across both entity types —
 * strict age-based FIFO, no phase-priority bias.
 *
 * Deliberately simple v1 prioritization, expected to evolve. Kept isolated
 * from the loop orchestrator (WL-3.3) so it stays cleanly testable via
 * fixtures.
 *
 * `tasks` is already the ready-only candidate set (task-store's ?ready=true
 * query), so dependency satisfaction is computed server-side before this
 * function ever sees the list — a task is selectable purely on
 * status === "pending" and createdAt age.
 *
 * `prs` is, likewise, already an unclaimed-only candidate set — the
 * check-review/check-patch/check-deploy collectors (LPF-2.2) request only
 * unclaimed PR records from the task-store via its `?ready=true` filter (or,
 * for check-review's specific need to distinguish "no record" from "claimed
 * record", perform an equivalent claim check inline before ever returning a
 * candidate). No local claim-filtering happens in this function — a PR
 * candidate is selectable purely on age, the same trust level task
 * candidates get above.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkTaskCandidate {
  id: string;
  createdAt: string;
}

export interface WorkPrCandidate {
  id: string;
  age: string;
  phase?: "review" | "patch" | "deploy";
}

export type WorkItem =
  | { type: "task"; task: WorkTaskCandidate }
  | { type: "pr"; pr: WorkPrCandidate };

/**
 * Select the single oldest ready item across tasks and PRs.
 * Returns null when nothing is ready.
 *
 * `tasks` is trusted as already-ready (status === "pending" and dependency
 * satisfaction both guaranteed by task-store's ?ready=true endpoint), so
 * selection here is purely age-based — no local status re-check.
 */
export function selectNextWorkItem(
  tasks: WorkTaskCandidate[],
  prs: WorkPrCandidate[],
): WorkItem | null {
  let best: { age: string; item: WorkItem } | null = null;

  for (const task of tasks) {
    if (!best || task.createdAt < best.age) {
      best = { age: task.createdAt, item: { type: "task", task } };
    }
  }

  for (const pr of prs) {
    if (!best || pr.age < best.age) {
      best = { age: pr.age, item: { type: "pr", pr } };
    }
  }

  return best ? best.item : null;
}

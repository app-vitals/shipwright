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
 * status === "pending" and createdAt age, the same trust level PR candidates
 * already get below.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkTaskCandidate {
  id: string;
  status: string;
  createdAt: string;
  branch?: string | null;
  dependencies?: string[];
}

export interface WorkPrCandidate {
  id: string;
  age: string;
  claimedBy?: string | null;
  phase?: "review" | "patch" | "deploy";
}

export type WorkItem =
  | { type: "task"; task: WorkTaskCandidate }
  | { type: "pr"; pr: WorkPrCandidate };

/**
 * Select the single oldest ready item across tasks and PRs.
 * Returns null when nothing is ready.
 */
export function selectNextWorkItem(
  tasks: WorkTaskCandidate[],
  prs: WorkPrCandidate[],
): WorkItem | null {
  let best: { age: string; item: WorkItem } | null = null;

  for (const task of tasks) {
    if (task.status !== "pending") continue;
    if (!best || task.createdAt < best.age) {
      best = { age: task.createdAt, item: { type: "task", task } };
    }
  }

  for (const pr of prs) {
    if (pr.claimedBy != null) continue;
    if (!best || pr.age < best.age) {
      best = { age: pr.age, item: { type: "pr", pr } };
    }
  }

  return best ? best.item : null;
}

/**
 * agent/src/work-selector.ts
 *
 * Pure helper: selectNextWorkItem(tasks, prs) → WorkItem | null
 *
 * Given a list of ready tasks (aged by createdAt) and a list of ready PRs
 * (aged by COALESCE(readyForReviewAt, readyForPatchAt, readyForDeployAt),
 * already filtered by the caller to only the pipeline phases currently
 * enabled), returns the single oldest ready-and-unblocked item across both
 * entity types — strict age-based FIFO, no phase-priority bias.
 *
 * Deliberately simple v1 prioritization, expected to evolve. Kept isolated
 * from the loop orchestrator (WL-3.3) so it stays cleanly testable via
 * fixtures.
 *
 * A task is only selectable when status === "pending" AND its dependencies
 * are satisfied (mirrors task-store/src/blocked-by.ts):
 *   1. dep.status ∈ { merged, done, deploying, deployed, cancelled } → satisfied
 *   2. same-branch dep with status ∈ { pr_open, approved } → satisfied (bundled)
 *   3. anything else, including a missing dependency, → not satisfied
 * This selector has no GitHub access, so a cross-branch pr_open dependency is
 * never treated as satisfied here.
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

// ─── Terminal statuses ────────────────────────────────────────────────────────

const TERMINAL_TASK_STATUSES = new Set<string>([
  "merged",
  "done",
  "deploying",
  "deployed",
  "cancelled",
]);

// ─── Core helper ─────────────────────────────────────────────────────────────

function isTaskUnblocked(
  task: WorkTaskCandidate,
  byId: Map<string, WorkTaskCandidate>,
): boolean {
  for (const depId of task.dependencies ?? []) {
    const dep = byId.get(depId);
    if (!dep) return false;

    if (TERMINAL_TASK_STATUSES.has(dep.status)) continue;

    if (
      dep.branch &&
      dep.branch === task.branch &&
      (dep.status === "pr_open" || dep.status === "approved")
    ) {
      continue;
    }

    return false;
  }

  return true;
}

/**
 * Select the single oldest ready-and-unblocked item across tasks and PRs.
 * Returns null when nothing is ready.
 */
export function selectNextWorkItem(
  tasks: WorkTaskCandidate[],
  prs: WorkPrCandidate[],
): WorkItem | null {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  let best: { age: string; item: WorkItem } | null = null;

  for (const task of tasks) {
    if (task.status !== "pending") continue;
    if (!isTaskUnblocked(task, tasksById)) continue;
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

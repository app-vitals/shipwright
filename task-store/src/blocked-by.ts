/**
 * task-store/src/blocked-by.ts
 *
 * Pure helper: computeBlockedBy(task, allTasks) → BlockedByEntry[]
 *
 * A task can be blocked by:
 *   1. An HITL gate (hitl=true AND hitlNotifiedAt is null)
 *   2. Unsatisfied dependency tasks
 *
 * Dependency-satisfied rules (mirrors ready.ts):
 *   1. dep.status ∈ { merged, done, deploying, deployed, cancelled } → satisfied
 *   2. same-branch dep with status ∈ { pr_open, approved } → satisfied (bundled)
 *   3. anything else → not satisfied (including cross-branch pr_open without a
 *      verified merge — the task-store has no GitHub access, so we never treat
 *      cross-branch pr_open as satisfied)
 */

import type { ReadyTaskLike } from "./ready.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single reason why a task is not yet ready. */
export type BlockedByEntry =
  | { type: "hitl" }
  | { type: "dependency"; id: string; status: string };

// ─── Terminal statuses (mirrors task-service.ts CLOSED_STATUSES) ──────────────

const TERMINAL_STATUSES = new Set([
  "merged",
  "done",
  "deploying",
  "deployed",
  "cancelled",
]);

// ─── Core helper ─────────────────────────────────────────────────────────────

/**
 * Compute all reasons why `task` is currently blocked.
 * Returns an empty array when nothing blocks the task.
 *
 * @param task      The task to evaluate.
 * @param allTasks  The full task list used to resolve dependency IDs.
 */
export function computeBlockedBy(
  task: ReadyTaskLike,
  allTasks: ReadyTaskLike[],
): BlockedByEntry[] {
  const blocks: BlockedByEntry[] = [];

  // HITL gate: blocked when hitl=true and the notification hasn't been sent yet.
  if (task.hitl === true && task.hitlNotifiedAt == null) {
    blocks.push({ type: "hitl" });
  }

  // Dependency gate.
  if (task.dependencies && task.dependencies.length > 0) {
    const byId = new Map(allTasks.map((t) => [t.id, t]));

    for (const depId of task.dependencies) {
      const dep = byId.get(depId);

      if (!dep) {
        // Dependency is not in the task list — treat as unknown/blocking.
        blocks.push({ type: "dependency", id: depId, status: "unknown" });
        continue;
      }

      // 1. Terminal statuses → satisfied.
      if (TERMINAL_STATUSES.has(dep.status)) {
        continue;
      }

      // 2. Same-branch pr_open / approved → bundled, satisfied.
      if (
        dep.branch &&
        dep.branch === task.branch &&
        (dep.status === "pr_open" || dep.status === "approved")
      ) {
        continue;
      }

      // 3. Everything else → not satisfied.
      blocks.push({ type: "dependency", id: depId, status: dep.status });
    }
  }

  return blocks;
}

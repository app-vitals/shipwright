/**
 * task-store/src/blocked-by.ts
 *
 * Pure helper: computeBlockedBy(task, allTasks) → BlockedByEntry[]
 *
 * A task can be blocked by:
 *   1. An HITL gate (hitl=true)
 *   2. An explicit `status: "blocked"` (surfacing task.blockedReason)
 *   3. Unsatisfied dependency tasks
 *
 * These gates are independent and accumulate: a status:"blocked" task can also
 * carry an hitl entry and/or unsatisfied dependency entries — the blocked gate
 * does not suppress the dependency gate.
 *
 * Dependency-satisfied rules (mirrors ready.ts):
 *   1. dep.status ∈ { merged, done, deploying, deployed, cancelled } → satisfied
 *   2. same-branch dep with status ∈ { pr_open, approved } → satisfied (bundled)
 *   3. anything else → not satisfied (including cross-branch pr_open without a
 *      verified merge — the task-store has no GitHub access, so we never treat
 *      cross-branch pr_open as satisfied)
 */

import type { ReadyTaskLike } from "./ready.ts";
import { CLOSED_STATUSES } from "./statuses.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single reason why a task is not yet ready.
 *
 * `{ type: "hitl" }` — the task has `hitl=true` and is gated on the
 * human-in-the-loop review; it is never considered ready. Consumers MUST NOT
 * infer that `blockedBy: []` means "this task is ready" — it only means there
 * are no recorded blocks.
 *
 * `{ type: "blocked"; reason }` — the task is at `status: "blocked"`; `reason`
 * carries `task.blockedReason` (or null when none was recorded).
 *
 * `{ type: "dependency"; id; status }` — an unsatisfied dependency task.
 */
export type BlockedByEntry =
  | { type: "hitl" }
  | { type: "dependency"; id: string; status: string }
  | { type: "blocked"; reason: string | null };

// ─── Terminal statuses ────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set<string>(CLOSED_STATUSES);

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

  // HITL gate. hitl=true tasks are never considered ready.
  if (task.hitl === true) {
    blocks.push({ type: "hitl" });
  }

  // Explicit blocked gate. A task parked at status:"blocked" surfaces its
  // recorded reason. This does not short-circuit the dependency gate below —
  // a blocked task can still separately report unsatisfied dependencies.
  if (task.status === "blocked") {
    blocks.push({ type: "blocked", reason: task.blockedReason ?? null });
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

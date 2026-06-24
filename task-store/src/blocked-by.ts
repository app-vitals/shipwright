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
import { CLOSED_STATUSES } from "./statuses.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single reason why a task is not yet ready.
 *
 * `{ type: "hitl" }` — notification has not yet been sent; task is awaiting
 * the HITL gate to be opened.
 *
 * `{ type: "hitl"; notified: true }` — notification was already sent
 * (`hitlNotifiedAt` is set) so the agent-actionable block is cleared, but the
 * task is still excluded from `listReady` because `hitl=true` tasks are never
 * considered ready. Consumers MUST NOT infer that `blockedBy: []` means
 * "this task is ready" — it only means there are no agent-actionable blocks.
 */
export type BlockedByEntry =
  | { type: "hitl"; notified?: true }
  | { type: "dependency"; id: string; status: string };

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

  // HITL gate.
  // - hitl=true, hitlNotifiedAt=null  → notification not yet sent; agent-actionable block.
  // - hitl=true, hitlNotifiedAt set   → notification already sent; passive wait.
  //   Emit { type: "hitl", notified: true } so consumers can distinguish the
  //   two states. The task is still excluded from listReady in both cases.
  if (task.hitl === true) {
    if (task.hitlNotifiedAt == null) {
      blocks.push({ type: "hitl" });
    } else {
      blocks.push({ type: "hitl", notified: true });
    }
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

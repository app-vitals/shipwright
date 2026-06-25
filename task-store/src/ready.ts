/**
 * task-store/src/ready.ts
 *
 * Ported from plugins/shipwright/scripts/store.ts `resolveReadyTasks`.
 *
 * A task is "ready" to execute when:
 *   - task.status === "pending"
 *   - task.hitl !== true
 *   - every dependency ID resolves to a known task whose status satisfies the
 *     dependency-satisfied rules below
 *
 * Dependency-satisfied rules:
 *   1. dep.status ∈ { merged, done, deploying, deployed, cancelled } → satisfied
 *   2. same-branch dep with status ∈ { pr_open, approved } → satisfied (bundled)
 *   3. cross-branch dep with status === pr_open AND dep.pr set AND isPrMerged(pr)
 *   4. anything else → not satisfied
 *
 * Operates on the Prisma `Task` shape (nullable fields) rather than the store.ts
 * interface — the dependency semantics are identical.
 */

/** The minimal Task shape resolveReadyTasks needs. */
export interface ReadyTaskLike {
  id: string;
  status: string;
  branch?: string | null;
  dependencies?: string[];
  pr?: number | null;
  hitl?: boolean | null;
  /** ISO timestamp set when HITL notification was sent; null while awaiting. */
  hitlNotifiedAt?: string | null;
}

export async function resolveReadyTasks<T extends ReadyTaskLike>(
  tasks: T[],
  isPrMerged: (prNumber: number) => Promise<boolean>,
): Promise<T[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const results: T[] = [];

  for (const task of tasks) {
    if (task.status !== "pending") continue;
    if (task.hitl === true) continue;

    let ready = true;
    for (const depId of task.dependencies ?? []) {
      const dep = byId.get(depId);
      if (!dep) {
        ready = false;
        break;
      }

      // Terminal / fully-satisfied statuses.
      if (
        dep.status === "merged" ||
        dep.status === "done" ||
        dep.status === "deploying" ||
        dep.status === "deployed" ||
        dep.status === "cancelled"
      ) {
        continue;
      }

      // Same-branch pr_open / approved → bundled, satisfies.
      if (
        dep.branch &&
        dep.branch === task.branch &&
        (dep.status === "pr_open" || dep.status === "approved")
      ) {
        continue;
      }

      // Cross-branch pr_open → check whether the PR is actually merged.
      if (dep.status === "pr_open" && dep.pr != null) {
        const merged = await isPrMerged(dep.pr);
        if (merged) continue;
      }

      // All other states → not satisfied.
      ready = false;
      break;
    }

    if (ready) results.push(task);
  }

  return results;
}

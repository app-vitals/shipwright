/**
 * task-store/src/ready.ts
 *
 * Ported from plugins/shipwright/scripts/store.ts `resolveReadyTasks`.
 *
 * A task is "ready" to execute when:
 *   - task.status === "pending"
 *   - task.hitl !== true
 *   - it has no fresh same-branch in_progress sibling (exclusivity guard, see below)
 *   - every dependency ID resolves to a known task whose status satisfies the
 *     dependency-satisfied rules below
 *
 * Dependency-satisfied rules:
 *   1. dep.status ∈ { merged, done, deploying, deployed, cancelled } → satisfied
 *   2. same-branch dep with status ∈ { pr_open, approved } → satisfied (bundled)
 *   3. cross-branch dep with status === pr_open AND dep.pr set AND isPrMerged(pr)
 *   4. anything else → not satisfied
 *
 * Same-branch exclusivity guard: a pending task is excluded from the ready set
 * if another task shares its non-null/non-empty `branch` and is `in_progress`
 * with a fresh claim — a real dev-task session is likely mid-flight on that
 * shared git branch. "Fresh" mirrors stale-claim-reaper.ts's exact two-case
 * freshness formula (heartbeatAt, falling back to claimedAt) against the
 * resolved claim TTL — `process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS ??
 * DEFAULT_CLAIM_TTL_MS`, the same operator-overridable formula used by
 * stale-claim-reaper.ts and pull-request-service.ts's claimNext — so a
 * genuinely crashed/stale sibling does not permanently starve the rest of
 * the bundle.
 *
 * Operates on the Prisma `Task` shape (nullable fields) rather than the store.ts
 * interface — the dependency semantics are identical.
 */

import { DEFAULT_CLAIM_TTL_MS } from "@shipwright/lib/claim-ttl";

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
  /** ISO timestamp when claimed. */
  claimedAt?: string | null;
  /** ISO timestamp of last heartbeat (liveness check). */
  heartbeatAt?: string | null;
}

/**
 * Mirrors stale-claim-reaper.ts's exact freshness formula: prefer
 * heartbeatAt when present, else fall back to claimedAt; a claim with
 * neither set is never fresh. The TTL itself mirrors stale-claim-reaper.ts
 * and pull-request-service.ts's claimNext: the operator-overridable
 * SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS env var, falling back to
 * DEFAULT_CLAIM_TTL_MS.
 */
function hasFreshClaim(task: ReadyTaskLike, nowMs: number): boolean {
  const effectiveTimestamp = task.heartbeatAt ?? task.claimedAt;
  if (!effectiveTimestamp) return false;
  const ttlMs = Number(
    process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS ?? DEFAULT_CLAIM_TTL_MS,
  );
  return nowMs - new Date(effectiveTimestamp).getTime() < ttlMs;
}

export async function resolveReadyTasks<T extends ReadyTaskLike>(
  tasks: T[],
  isPrMerged: (prNumber: number) => Promise<boolean>,
  now: () => Date = () => new Date(),
): Promise<T[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const results: T[] = [];
  const nowMs = now().getTime();

  for (const task of tasks) {
    if (task.status !== "pending") continue;
    if (task.hitl === true) continue;

    if (task.branch) {
      const hasFreshInProgressSibling = tasks.some(
        (other) =>
          other.id !== task.id &&
          other.branch === task.branch &&
          other.status === "in_progress" &&
          hasFreshClaim(other, nowMs),
      );
      if (hasFreshInProgressSibling) continue;
    }

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

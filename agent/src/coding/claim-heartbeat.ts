/**
 * DBH-1.1 — keeps a claimed task's `heartbeatAt` fresh while a long dev-task
 * attempt is running. The in-session `POST /tasks/{id}/heartbeat` prompt step
 * is best-effort (an LLM can skip it, and `curl -sf` hides failures), so the
 * runtime renews the claim itself on a fixed interval well under
 * DEFAULT_CLAIM_TTL_MS. A failed renewal is logged, never thrown: the next
 * tick retries and the attempt itself must not die over a task-store blip.
 */
export const CLAIM_HEARTBEAT_INTERVAL_MS = 300_000;

/** Starts the renewal interval for `taskId`; returns a function that stops it. */
export function startClaimHeartbeat(
  heartbeat: (taskId: string) => Promise<void>,
  taskId: string,
  intervalMs: number = CLAIM_HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    heartbeat(taskId).catch((err) => {
      console.warn(
        `[loop-orchestrator] periodic heartbeatTask failed for ${taskId}: ${String(err)} — will retry`,
      );
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

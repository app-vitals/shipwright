/**
 * agent/src/check-dev-task.ts
 *
 * Native, directly-importable equivalent of
 * plugins/shipwright/scripts/check-dev-task.ts — candidate provider for the
 * dev-task phase.
 *
 * Unlike the plugin script (a boolean gate that exits 0/1 for a cron
 * precheck), this function collects and returns the FULL SET of ready tasks
 * from the task store as WorkTaskCandidate[], already in the shape
 * work-selector.ts's selectNextWorkItem() expects. It does not early-return
 * after the first match — the selector needs the whole candidate set to pick
 * the globally-oldest ready item.
 *
 * Before collecting ready tasks, this still performs the same stale
 * in_progress guard as the plugin script:
 *   - Tasks with startedAt older than 45 minutes are reset to pending.
 *   - Tasks with no startedAt are stamped with the current time so they age
 *     out naturally on the next run (conservative — avoids disrupting tasks
 *     legitimately set to in_progress outside of dev-task).
 *
 * In_progress results are filtered to this agent's own `assignee`
 * (SHIPWRIGHT_AGENT_ID) before any of the above runs — the task-store list
 * endpoint does not reliably scope bare `status=` queries by assignee for
 * agent tokens with repo-level access, so unfiltered results can include
 * other agents' tasks.
 *
 * HITL-pending notification is intentionally out of scope here — it isn't a
 * ready-work candidate for the selector, and belongs to the orchestrator
 * (WL-3.3, out of scope for this port).
 */

import { type Clock, SystemClock } from "./clock.ts";
import { createTaskStoreClient } from "./check-helpers.ts";
import type { Task } from "./check-helpers.ts";
import type { WorkTaskCandidate } from "./work-selector.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 45 * 60 * 1000; // 45 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckDevTaskDeps {
  getReadyTasks: () => Promise<Task[]>;
  getInProgressTasks: () => Promise<Task[]>;
  resetTask: (id: string) => Promise<Task>;
  stampTask: (id: string, startedAt: string) => Promise<Task>;
  clock: Clock;
  /** This agent's own task-store id — used to filter out other agents' tasks. */
  agentId: string;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

function toWorkTaskCandidate(task: Task): WorkTaskCandidate {
  return {
    id: task.id,
    createdAt: task.addedAt ?? "",
  };
}

/**
 * Collect all ready dev-task candidates from the task store.
 *
 * Performs the stale in_progress guard (reset/stamp) as a side effect before
 * querying ready tasks, then returns the full ready set as
 * WorkTaskCandidate[] — never a single match, never {exit, output}.
 */
export async function getDevTaskCandidates(
  deps: CheckDevTaskDeps,
): Promise<WorkTaskCandidate[]> {
  // The task-store list endpoint does not reliably filter by assignee for
  // agent tokens with repo-level access — a bare `status=` query can return
  // tasks belonging to other agents sharing the same repo. Filter to this
  // agent's own tasks before resetting/stamping staleness, so this agent
  // never touches another agent's in-flight work.
  const allInProgressTasks = await deps.getInProgressTasks();
  const inProgressTasks = allInProgressTasks.filter(
    (t) => t.assignee === deps.agentId,
  );
  const now = deps.clock.now().getTime();

  for (const task of inProgressTasks) {
    if (task.startedAt === undefined) {
      await deps.stampTask(task.id, deps.clock.now().toISOString());
    } else if (now - new Date(task.startedAt).getTime() >= STALE_THRESHOLD_MS) {
      await deps.resetTask(task.id);
    }
  }

  const readyTasks = await deps.getReadyTasks();
  return readyTasks.map(toWorkTaskCandidate);
}

// ─── Production deps ──────────────────────────────────────────────────────────

export function buildProductionDeps(): CheckDevTaskDeps {
  const client = createTaskStoreClient();
  const agentId = (process.env.SHIPWRIGHT_AGENT_ID ?? "").trim();
  if (!agentId) {
    process.stderr.write("error: SHIPWRIGHT_AGENT_ID is required\n");
    process.exit(1);
  }

  return {
    getReadyTasks: () => client.query(new URLSearchParams({ ready: "true" })),
    getInProgressTasks: () =>
      client.query(new URLSearchParams({ status: "in_progress" })),
    resetTask: (id) =>
      client.update(id, { status: "pending", startedAt: null }),
    stampTask: (id, startedAt) => client.update(id, { startedAt }),
    clock: SystemClock(),
    agentId,
  };
}

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
 * Reclaiming stale in_progress tasks is exclusively StaleClaimReaper's
 * responsibility (task-store's own 65-minute claim-TTL reaper, wired via
 * setInterval in task-store/src/main.ts). This module does not perform any
 * stale-task guard of its own.
 *
 * HITL-pending notification is intentionally out of scope here — it isn't a
 * ready-work candidate for the selector, and belongs to the orchestrator
 * (WL-3.3, out of scope for this port).
 */

import { type Clock, SystemClock } from "./clock.ts";
import { createTaskStoreClient } from "./check-helpers.ts";
import type { Task } from "./check-helpers.ts";
import type { WorkTaskCandidate } from "./work-selector.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckDevTaskDeps {
  getReadyTasks: () => Promise<Task[]>;
  clock: Clock;
  /** This agent's own task-store id. */
  agentId: string;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

function toWorkTaskCandidate(task: Task): WorkTaskCandidate {
  return {
    id: task.id,
    createdAt: task.createdAt ?? "",
    title: task.title,
  };
}

/**
 * Collect all ready dev-task candidates from the task store.
 *
 * Returns the full ready set as WorkTaskCandidate[] — never a single match,
 * never {exit, output}.
 */
export async function getDevTaskCandidates(
  deps: CheckDevTaskDeps,
): Promise<WorkTaskCandidate[]> {
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
    clock: SystemClock(),
    agentId,
  };
}

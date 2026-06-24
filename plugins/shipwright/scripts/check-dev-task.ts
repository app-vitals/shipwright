#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-dev-task.ts
 *
 * Pre-check for the dev-task cron.
 *
 * Queries the task store for ready tasks and prints a prompt if any exist.
 * Before checking ready tasks, guards against stale in_progress tasks:
 *   - Tasks with startedAt older than 45 minutes are reset to pending.
 *   - Tasks with no startedAt are stamped with the current time so they age
 *     out naturally on the next run (conservative — avoids disrupting tasks
 *     legitimately set to in_progress outside of dev-task).
 *
 * Exit 0 + one-line prompt → work exists
 * Exit 1 + no output       → nothing to do
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-dev-task.ts
 */

import { createTaskStoreClient } from "./check-helpers.ts";
import type { Task } from "./check-helpers.ts";
import { type Clock, SystemClock } from "./clock.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 45 * 60 * 1000; // 45 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

interface Deps {
  getReadyTasks: () => Promise<Task[]>;
  getInProgressTasks: () => Promise<Task[]>;
  getHitlPendingTasks: () => Promise<Task[]>;
  resetTask: (id: string) => Promise<Task>;
  stampTask: (id: string, startedAt: string) => Promise<Task>;
  clock: Clock;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

interface RunResult {
  exit: 0 | 1;
  output: string;
}

export async function run(deps: Deps): Promise<RunResult> {
  // Reset stale in_progress tasks before checking for ready tasks
  const inProgressTasks = await deps.getInProgressTasks();
  const now = deps.clock.now().getTime();

  for (const task of inProgressTasks) {
    if (task.startedAt === undefined) {
      await deps.stampTask(task.id, deps.clock.now().toISOString());
    } else if (now - new Date(task.startedAt).getTime() >= STALE_THRESHOLD_MS) {
      await deps.resetTask(task.id);
    }
  }

  const readyTasks = await deps.getReadyTasks();

  if (readyTasks.length > 0) {
    return {
      exit: 0,
      output:
        "Pick the next ready task from the task store and execute via /shipwright:dev-task",
    };
  }

  const hitlPendingTasks = await deps.getHitlPendingTasks();
  const unnotifiedHitlTasks = hitlPendingTasks.filter(
    (t) => t.hitlNotifiedAt === undefined,
  );

  if (unnotifiedHitlTasks.length > 0) {
    const taskList = unnotifiedHitlTasks
      .map((t) => `  - ${t.id}: ${t.title}`)
      .join("\n");
    return {
      exit: 0,
      output: `The following tasks require human-in-the-loop action. Post a notification in the channel listing these tasks and ask for human attention, then stamp hitlNotifiedAt on each using the task store update command:\n${taskList}`,
    };
  }

  return { exit: 1, output: "" };
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  const client = createTaskStoreClient();

  return {
    getReadyTasks: () => client.query(new URLSearchParams({ ready: "true" })),
    getInProgressTasks: () =>
      client.query(new URLSearchParams({ status: "in_progress" })),
    getHitlPendingTasks: () =>
      client.query(new URLSearchParams({ status: "pending", hitl: "true" })),
    resetTask: (id) =>
      client.update(id, { status: "pending", startedAt: null }),
    stampTask: (id, startedAt) => client.update(id, { startedAt }),
    clock: SystemClock(),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const deps = buildProductionDeps();
  const result = await run(deps);
  if (result.exit === 0) {
    process.stdout.write(`${result.output}\n`);
  }
  process.exit(result.exit);
}

// Only run main when executed directly (not imported by tests)
if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exit(2);
  });
}

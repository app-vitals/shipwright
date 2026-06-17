#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-dev-task.ts
 *
 * Pre-check for the dev-task cron.
 *
 * Queries the task store for ready tasks and prints a prompt if any exist.
 * Before checking ready tasks, guards against stale in_progress tasks:
 *   - Tasks with startedAt older than 4 hours are reset to pending.
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

import { type Clock, SystemClock } from "./clock.ts";
import { createTaskStore, loadConfig } from "./create-task-store.ts";
import type { Task } from "./store.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

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

function resolveGhUser(): string | undefined {
  // GraphQL viewer works under both PAT and GitHub App installation tokens.
  // REST /user 403s under installation tokens. Same "name[bot]" → "app/name"
  // normalisation as getCurrentUser() in check-helpers.ts.
  const proc = Bun.spawnSync(
    ["gh", "api", "graphql", "-f", "query=query{viewer{login}}"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) return undefined;
  try {
    const data = JSON.parse(proc.stdout.toString()) as {
      data: { viewer: { login: string } };
    };
    const login = data.data.viewer.login;
    return login.endsWith("[bot]") ? `app/${login.slice(0, -5)}` : login;
  } catch {
    return undefined;
  }
}

function buildProductionDeps(): Deps {
  const { config } = loadConfig();
  const store = createTaskStore(config);
  const assignee = resolveGhUser();

  return {
    getReadyTasks: () => store.query({ ready: true, assignee }),
    getInProgressTasks: () => store.query({ status: "in_progress", assignee }),
    getHitlPendingTasks: () =>
      store.query({ status: "pending", hitl: true, assignee }),
    resetTask: (id) =>
      store.update(id, { status: "pending", startedAt: undefined }),
    stampTask: (id, startedAt) => store.update(id, { startedAt }),
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

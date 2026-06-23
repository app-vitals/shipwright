/**
 * plugins/shipwright/scripts/create-task-store.ts
 *
 * Factory for creating TaskStore instances.
 * Config is read exclusively from environment variables.
 *
 * Required:
 *   SHIPWRIGHT_TASK_STORE_URL    Base URL of the task-store service
 *   SHIPWRIGHT_TASK_STORE_TOKEN  Bearer token for authentication
 */

import { TaskStoreHttpAdapter } from "./adapters/task-store";
import type { TaskStore, TaskStoreConfig } from "./store";

export function loadConfig(): TaskStoreConfig {
  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  if (!taskStoreUrl) {
    process.stderr.write(
      "error: SHIPWRIGHT_TASK_STORE_URL is required\n",
    );
    process.exit(1);
  }
  return { taskStoreUrl };
}

export function createTaskStore(config: TaskStoreConfig): TaskStore {
  try {
    return new TaskStoreHttpAdapter(config, fetch);
  } catch (e) {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exit(1);
  }
}

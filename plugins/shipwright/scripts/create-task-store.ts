/**
 * plugins/shipwright/scripts/create-task-store.ts
 *
 * Factory for creating TaskStore instances based on SHIPWRIGHT_CONFIG.
 *
 * Usage:
 *   import { loadConfig, createTaskStore } from "./create-task-store";
 *   const { config, configSource } = loadConfig();
 *   const store = createTaskStore(config);
 */

import { existsSync, readFileSync } from "node:fs";
import { GitHubTaskStore } from "./adapters/github";
import { JsonTaskStore } from "./adapters/json";
import type { TaskStore, TaskStoreConfig } from "./store";

// ─── Config loading ───────────────────────────────────────────────────────────

export interface LoadedConfig {
  config: TaskStoreConfig;
  configSource: string;
}

/**
 * Read and parse SHIPWRIGHT_CONFIG env var to produce a TaskStoreConfig.
 *
 * - If SHIPWRIGHT_CONFIG is unset or empty: returns default JSON config.
 * - If set: reads and parses the JSON file at that path.
 * - Exits with code 1 on file-not-found or invalid JSON.
 */
export function loadConfig(): LoadedConfig {
  const cfgPath = (process.env.SHIPWRIGHT_CONFIG ?? "").trim();
  if (!cfgPath) {
    return { config: { taskStore: "json" }, configSource: "default" };
  }
  if (!existsSync(cfgPath)) {
    process.stderr.write(
      `error: SHIPWRIGHT_CONFIG file not found: ${cfgPath}\n`,
    );
    process.exit(1);
  }
  try {
    const config = JSON.parse(
      readFileSync(cfgPath, "utf-8"),
    ) as TaskStoreConfig;
    return { config, configSource: cfgPath };
  } catch (e) {
    process.stderr.write(
      `error: SHIPWRIGHT_CONFIG is not valid JSON: ${String(e)}\n`,
    );
    process.exit(1);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a TaskStore instance for the given config.
 *
 * - `taskStore: "json"` → JsonTaskStore backed by state/todos.json in process.cwd()
 * - `taskStore: "github"` → GitHubTaskStore backed by GitHub Issues via gh CLI
 */
export function createTaskStore(config: TaskStoreConfig): TaskStore {
  if (config.taskStore === "github") {
    if (!config.github) {
      process.stderr.write(
        "error: github.owner and github.repo are required when taskStore is 'github'\n",
      );
      process.exit(1);
    }
    return new GitHubTaskStore(config);
  }
  return new JsonTaskStore(process.cwd());
}

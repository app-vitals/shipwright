/**
 * plugins/shipwright/scripts/create-task-store.ts
 *
 * Factory for creating TaskStore instances based on config discovery.
 *
 * Config resolution order:
 *   0. SHIPWRIGHT_TASK_STORE env var (and related vars) — highest precedence
 *   1. Walk up from cwd to find .shipwright.json
 *   2. Fall back to SHIPWRIGHT_CONFIG env var
 *   3. Error — config is required
 *
 * Usage:
 *   import { loadConfig, createTaskStore } from "./create-task-store";
 *   const { config, configSource } = loadConfig();
 *   const store = createTaskStore(config);
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TaskStoreHttpAdapter } from "./adapters/task-store";
import type { TaskStore, TaskStoreConfig } from "./store";

// ─── Config loading ───────────────────────────────────────────────────────────

export interface LoadedConfig {
  config: TaskStoreConfig;
  configSource: string;
}

/**
 * Walk up from startDir looking for a .shipwright.json file.
 *
 * Returns the absolute path to the first .shipwright.json found, or null if
 * none is found before reaching the filesystem root.
 */
export function findShipwrightJson(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, ".shipwright.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root without finding .shipwright.json
      return null;
    }
    dir = parent;
  }
}

/**
 * Read and parse a JSON config file. Exits with code 1 on file-not-found or
 * invalid JSON.
 */
function readConfigFile(cfgPath: string): TaskStoreConfig {
  if (!existsSync(cfgPath)) {
    process.stderr.write(
      `error: SHIPWRIGHT_CONFIG file not found: ${cfgPath}\n`,
    );
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(cfgPath, "utf-8")) as TaskStoreConfig;
  } catch (e) {
    process.stderr.write(
      `error: SHIPWRIGHT_CONFIG is not valid JSON: ${String(e)}\n`,
    );
    process.exit(1);
  }
}

/**
 * Resolve the TaskStoreConfig using the discovery chain:
 *
 * 0. Check env vars (SHIPWRIGHT_TASK_STORE, etc.) → highest precedence.
 * 1. Walk up from `cwd` to find `.shipwright.json` → use it if found.
 * 2. Fall back to `SHIPWRIGHT_CONFIG` env var → use it if set and non-empty.
 * 3. Error — config is required.
 *
 * The optional `cwd` parameter exists for testability — pass a temp directory
 * in tests so the walk-up does not escape into the real filesystem.
 * In production, omit it and the process working directory is used.
 */
export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
  // Step 0: check SHIPWRIGHT_TASK_STORE env var — takes full precedence
  const taskStoreEnv = (process.env.SHIPWRIGHT_TASK_STORE ?? "").trim();
  if (taskStoreEnv === "task-store") {
    const taskStoreUrl = process.env.SHIPWRIGHT_TASK_STORE_URL ?? "";
    const config: TaskStoreConfig = { taskStore: "task-store", taskStoreUrl };
    return { config, configSource: "env" };
  }
  if (taskStoreEnv !== "") {
    process.stderr.write(
      `warning: unrecognized SHIPWRIGHT_TASK_STORE value: "${taskStoreEnv}" — expected task-store. Falling through to file config.\n`,
    );
  }

  // Step 1: walk up from cwd looking for .shipwright.json
  const discovered = findShipwrightJson(cwd);
  if (discovered !== null) {
    try {
      const config = JSON.parse(
        readFileSync(discovered, "utf-8"),
      ) as TaskStoreConfig;
      return { config, configSource: discovered };
    } catch (e) {
      process.stderr.write(
        `error: .shipwright.json is not valid JSON: ${String(e)}\n`,
      );
      process.exit(1);
    }
  }

  // Step 2: fall back to SHIPWRIGHT_CONFIG env var
  const cfgPath = (process.env.SHIPWRIGHT_CONFIG ?? "").trim();
  if (cfgPath) {
    const config = readConfigFile(cfgPath);
    return { config, configSource: cfgPath };
  }

  // Step 3: no config found — error
  process.stderr.write(
    "error: no task store config found. Set SHIPWRIGHT_TASK_STORE=task-store + SHIPWRIGHT_TASK_STORE_URL, or create a .shipwright.json with taskStore: \"task-store\".\n",
  );
  process.exit(1);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a TaskStore instance for the given config.
 *
 * - `taskStore: "task-store"` → TaskStoreHttpAdapter backed by a remote HTTP service
 */
export function createTaskStore(config: TaskStoreConfig): TaskStore {
  if (config.taskStore === "task-store") {
    const taskStoreUrl =
      (config as { taskStoreUrl?: string }).taskStoreUrl ??
      process.env.SHIPWRIGHT_TASK_STORE_URL ??
      "";
    if (!taskStoreUrl) {
      process.stderr.write(
        "error: taskStoreUrl is required when taskStore is 'task-store' (or set SHIPWRIGHT_TASK_STORE_URL)\n",
      );
      process.exit(1);
    }
    try {
      return new TaskStoreHttpAdapter({ ...config, taskStoreUrl }, fetch);
    } catch (e) {
      process.stderr.write(`error: ${String(e)}\n`);
      process.exit(1);
    }
  }
  if (
    (config.taskStore as string) === "github" ||
    (config.taskStore as string) === "jira" ||
    (config.taskStore as string) === "json"
  ) {
    process.stderr.write(
      `error: the "${config.taskStore}" task store backend has been removed. Update your .shipwright.json to use taskStore: "task-store" and set SHIPWRIGHT_TASK_STORE_URL.\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `error: unknown taskStore value: "${config.taskStore}". Expected "task-store".\n`,
  );
  process.exit(1);
}

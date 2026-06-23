/**
 * plugins/shipwright/scripts/create-task-store.ts
 *
 * Factory for creating TaskStore instances based on config discovery.
 *
 * Config resolution order:
 *   0. SHIPWRIGHT_TASK_STORE env var (and related vars) — highest precedence
 *   1. Walk up from cwd to find .shipwright.json
 *   2. Fall back to SHIPWRIGHT_CONFIG env var
 *   3. Default to JSON backend
 *
 * Usage:
 *   import { loadConfig, createTaskStore } from "./create-task-store";
 *   const { config, configSource } = loadConfig();
 *   const store = createTaskStore(config);
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JsonTaskStore } from "./adapters/json";
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
 * Resolve the TaskStoreConfig using the 4-step discovery chain:
 *
 * 0. Check env vars (SHIPWRIGHT_TASK_STORE, etc.) → highest precedence.
 * 1. Walk up from `cwd` to find `.shipwright.json` → use it if found.
 * 2. Fall back to `SHIPWRIGHT_CONFIG` env var → use it if set and non-empty.
 * 3. Default to JSON backend with no config file.
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
  if (taskStoreEnv === "json") {
    return { config: { taskStore: "json" }, configSource: "env" };
  }
  if (taskStoreEnv !== "") {
    process.stderr.write(
      `warning: unrecognized SHIPWRIGHT_TASK_STORE value: "${taskStoreEnv}" — expected task-store or json. Falling through to file config.\n`,
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

  // Step 3: default to JSON backend
  return { config: { taskStore: "json" }, configSource: "default" };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function doctorCheck(
  config: TaskStoreConfig,
  configSource: string,
  cwd: string = process.cwd(),
): void {
  const backend = config.taskStore;

  console.log(`backend: ${backend}`);
  if (configSource === "default") {
    console.log("config: default (no SHIPWRIGHT_CONFIG set)");
  } else {
    console.log(`config: ${configSource}`);
  }

  // For non-JSON backends (task-store), check for a coexisting non-empty todos.json
  if (backend !== "json") {
    const todosPath = join(cwd, "state", "todos.json");
    if (existsSync(todosPath)) {
      try {
        const content = readFileSync(todosPath, "utf-8").trim();
        if (content.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(content);
          } catch {
            parsed = null;
          }
          // Warn if it's a non-empty array (or unparseable content)
          const isNonEmptyArray =
            Array.isArray(parsed) && (parsed as unknown[]).length > 0;
          const isNonEmptyContent = !Array.isArray(parsed) && content !== "[]";
          if (isNonEmptyArray || isNonEmptyContent) {
            console.warn(
              `[warn] config: todos.json exists and is non-empty while ${backend} backend is active`,
            );
          }
        }
      } catch {
        // If we can't read the file, skip the check silently
      }
    }
  }
}

/**
 * Create a TaskStore instance for the given config.
 *
 * - `taskStore: "json"` → JsonTaskStore backed by state/todos.json in process.cwd()
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
  return new JsonTaskStore(process.cwd());
}

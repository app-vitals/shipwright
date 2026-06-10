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
import { GitHubTaskStore } from "./adapters/github";
import { JiraTaskStore } from "./adapters/jira";
import { JsonTaskStore } from "./adapters/json";
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
  if (taskStoreEnv === "github") {
    const owner = process.env.SHIPWRIGHT_GITHUB_OWNER;
    const repo = process.env.SHIPWRIGHT_GITHUB_REPO;
    // Include github sub-config only when both vars are present; otherwise let
    // createTaskStore surface the missing-fields error at instantiation time.
    const config: TaskStoreConfig =
      owner !== undefined && repo !== undefined
        ? { taskStore: "github", github: { owner, repo } }
        : { taskStore: "github" };
    return { config, configSource: "env" };
  }
  if (taskStoreEnv === "jira") {
    const baseUrl = process.env.JIRA_BASE_URL ?? "";
    const projectKey = process.env.JIRA_PROJECT_KEY ?? "";
    const config: TaskStoreConfig = {
      taskStore: "jira",
      jira: { baseUrl, projectKey },
    };
    return { config, configSource: "env" };
  }
  if (taskStoreEnv === "json") {
    return { config: { taskStore: "json" }, configSource: "env" };
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

/**
 * Create a TaskStore instance for the given config.
 *
 * - `taskStore: "json"` → JsonTaskStore backed by state/todos.json in process.cwd()
 * - `taskStore: "github"` → GitHubTaskStore backed by GitHub Issues via gh CLI
 * - `taskStore: "jira"` → JiraTaskStore backed by Jira REST API v3
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
  if (config.taskStore === "jira") {
    if (!config.jira?.baseUrl || !config.jira?.projectKey) {
      process.stderr.write(
        "error: jira.baseUrl and jira.projectKey are required when taskStore is 'jira'\n",
      );
      process.exit(1);
    }
    try {
      return new JiraTaskStore(config, fetch);
    } catch (e) {
      process.stderr.write(`error: ${String(e)}\n`);
      process.exit(1);
    }
  }
  return new JsonTaskStore(process.cwd());
}

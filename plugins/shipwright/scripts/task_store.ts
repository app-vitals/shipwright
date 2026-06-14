#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/task_store.ts
 *
 * Shipwright Task Store — CLI entrypoint (TypeScript port of task_store.py).
 *
 * Usage:
 *   bun plugins/shipwright/scripts/task_store.ts <subcommand> [options]
 *
 * Subcommands:
 *   query       Filter and return tasks as JSON array
 *   append      Upsert tasks from a JSON file (idempotent by id)
 *   update      Write specific fields to a task by ID
 *   repos       Print all org/repo strings (one per line)
 *   resolve-repo  Print first org/repo (deprecated alias for repos)
 *   setup       Create state/todos.json if missing
 *   doctor      Validate config and print diagnostics
 *
 * Environment:
 *   SHIPWRIGHT_CONFIG   Path to JSON config file (optional)
 *                       If absent or empty, defaults to JSON backend.
 */

import { existsSync, readFileSync } from "node:fs";
import { JsonTaskStore } from "./adapters/json";
import { resolveRepos } from "./check-helpers";
import { createTaskStore, loadConfig } from "./create-task-store";
import type { Task, TaskStore } from "./store";

const NUMERIC_FIELDS = new Set(["pr", "hours", "complexity"]);

function coerceValue(key: string, rawValue: string): number | string {
  if (NUMERIC_FIELDS.has(key)) {
    const n = Number(rawValue);
    return Number.isNaN(n) ? rawValue : n;
  }
  return rawValue;
}

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  flags: Map<string, string | true | string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // strip node/bun + script path
  if (args.length === 0) {
    printUsageAndExit();
  }

  const command = args[0];
  const flags = new Map<string, string | true | string[]>();

  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        if (key === "set") {
          const existing = flags.get(key);
          if (Array.isArray(existing)) {
            existing.push(next);
          } else {
            flags.set(key, [next]);
          }
        } else {
          flags.set(key, next);
        }
        i += 2;
      } else {
        flags.set(key, true);
        i++;
      }
    } else {
      i++;
    }
  }

  return { command, flags };
}

function printUsageAndExit(): never {
  process.stderr.write(
    [
      "Usage: bun task_store.ts <subcommand> [options]",
      "",
      "Subcommands:",
      "  query         Filter and return tasks as JSON array",
      "  append        Upsert tasks from a JSON file (idempotent by id)",
      "  update        Write specific fields to a task by ID",
      "  repos         Print all org/repo strings (one per line)",
      "  resolve-repo  Print first org/repo (deprecated alias for repos)",
      "  setup         Create state/todos.json if missing",
      "  cleanup       Close open GitHub issues with terminal status labels",
      "  doctor        Validate config and print diagnostics",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function getFlag(
  flags: Map<string, string | true | string[]>,
  key: string,
): string | undefined {
  const v = flags.get(key);
  if (v === undefined || v === true) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

function getBoolFlag(
  flags: Map<string, string | true | string[]>,
  key: string,
): boolean {
  return flags.get(key) === true;
}

function getArrayFlag(
  flags: Map<string, string | true | string[]>,
  key: string,
): string[] | undefined {
  const v = flags.get(key);
  if (!v) return undefined;
  if (Array.isArray(v)) return v;
  if (v === true) return [];
  return [v];
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function cmdQuery(
  adapter: TaskStore,
  flags: Map<string, string | true | string[]>,
): Promise<void> {
  const ready = getBoolFlag(flags, "ready");
  const status = getFlag(flags, "status");
  const session = getFlag(flags, "session");
  const id = getFlag(flags, "id");
  const prStr = getFlag(flags, "pr");
  const pr = prStr !== undefined ? Number.parseInt(prStr, 10) : undefined;
  const assignee = getFlag(flags, "assignee");

  const results = await adapter.query({
    ready,
    status,
    session,
    id,
    pr,
    assignee,
  });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

async function cmdAppend(
  adapter: TaskStore,
  flags: Map<string, string | true | string[]>,
): Promise<void> {
  const filePath = getFlag(flags, "file");
  if (!filePath) {
    process.stderr.write("error: --file is required\n");
    process.exit(1);
  }
  if (!existsSync(filePath)) {
    process.stderr.write(`error: file not found: ${filePath}\n`);
    process.exit(1);
  }

  let incoming: unknown;
  try {
    incoming = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (e) {
    process.stderr.write(
      `error: ${filePath} is not valid JSON: ${String(e)}\n`,
    );
    process.exit(1);
  }

  if (!Array.isArray(incoming)) {
    process.stderr.write(
      "error: input file must contain a JSON array of tasks\n",
    );
    process.exit(1);
  }

  const result = await adapter.append(incoming as never);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function cmdUpdate(
  adapter: TaskStore,
  flags: Map<string, string | true | string[]>,
): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    process.stderr.write("error: --id is required\n");
    process.exit(1);
  }

  const setArgs = getArrayFlag(flags, "set");
  if (!setArgs || setArgs.length === 0) {
    process.stderr.write("error: at least one --set key=value required\n");
    process.exit(1);
  }

  // Parse --set key=value pairs
  const nonStatusFields: Record<string, string | number> = {};
  let statusValue: string | undefined;

  for (const kv of setArgs) {
    if (!kv.includes("=")) {
      process.stderr.write(
        `error: --set value must be in key=value format: ${kv}\n`,
      );
      process.exit(1);
    }
    const eqIdx = kv.indexOf("=");
    const key = kv.slice(0, eqIdx);
    const rawVal = kv.slice(eqIdx + 1);
    const coerced = coerceValue(key, rawVal);
    if (key === "status") {
      statusValue = String(coerced);
    } else {
      nonStatusFields[key] = coerced;
    }
  }

  const fields: Record<string, unknown> = { ...nonStatusFields };
  if (statusValue !== undefined) fields.status = statusValue;

  try {
    const updated = await adapter.update(id, fields as Partial<Task>);
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exit(1);
  }
}

/**
 * Resolve the list of known repos for the configured store.
 *
 * Queries the configured adapter first (the GitHub backend resolves its
 * org/repo from config; the JSON backend reads repo fields off tasks). If the
 * adapter yields nothing, falls back to scanning workspace/repos/ or
 * SHIPWRIGHT_REPOS_DIR so a filesystem-only workspace still resolves.
 */
async function resolveReposForStore(adapter: TaskStore): Promise<string[]> {
  const repos = await adapter.resolveRepos();
  if (repos.length > 0) return repos;
  return resolveRepos(process.cwd());
}

/**
 * repos subcommand — prints all known repos (one per line). Queries the
 * configured store's adapter, falling back to scanning workspace/repos/ or
 * SHIPWRIGHT_REPOS_DIR.
 */
async function cmdRepos(adapter: TaskStore): Promise<void> {
  const repos = await resolveReposForStore(adapter);
  for (const repo of repos) {
    process.stdout.write(`${repo}\n`);
  }
}

/**
 * resolve-repo subcommand — deprecated alias for `repos`, prints only the
 * first repo. Exits non-zero if no repos are found.
 */
async function cmdResolveRepo(adapter: TaskStore): Promise<void> {
  const repos = await resolveReposForStore(adapter);
  if (repos.length === 0) {
    process.stderr.write(
      "error: no repos found — add git clones to workspace/repos/ or set SHIPWRIGHT_REPOS_DIR\n",
    );
    process.exit(1);
  }
  process.stdout.write(`${repos[0]}\n`);
}

async function cmdSetup(adapter: TaskStore): Promise<void> {
  await adapter.setup();
}

async function cmdCleanup(adapter: TaskStore): Promise<void> {
  if (
    !("cleanup" in adapter) ||
    typeof (adapter as { cleanup?: unknown }).cleanup !== "function"
  ) {
    process.stderr.write("error: cleanup is not supported by this adapter\n");
    process.exit(1);
  }
  const result = await (
    adapter as {
      cleanup: () => Promise<{ closed: number; milestonesClosed: number }>;
    }
  ).cleanup();
  process.stdout.write(`Closed ${result.closed} stale open issue(s).\n`);
  process.stdout.write(
    `Closed ${result.milestonesClosed} empty milestone(s).\n`,
  );
}

function cmdDoctor(adapter: TaskStore, configSource: string): void {
  if (adapter instanceof JsonTaskStore) {
    adapter.doctor(configSource);
  } else {
    console.log("backend: github");
    if (configSource === "default") {
      console.log("config: default (no SHIPWRIGHT_CONFIG set)");
    } else {
      console.log(`config: ${configSource}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SUBCOMMANDS = new Set([
  "query",
  "append",
  "update",
  "resolve-repo",
  "repos",
  "setup",
  "cleanup",
  "doctor",
]);

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  if (!SUBCOMMANDS.has(command)) {
    process.stderr.write(`error: unknown subcommand: ${command}\n`);
    printUsageAndExit();
  }

  const { config, configSource } = loadConfig();

  const adapter = createTaskStore(config);

  switch (command) {
    case "query":
      await cmdQuery(adapter, flags);
      break;
    case "append":
      await cmdAppend(adapter, flags);
      break;
    case "update":
      await cmdUpdate(adapter, flags);
      break;
    case "repos":
      await cmdRepos(adapter);
      break;
    case "resolve-repo":
      await cmdResolveRepo(adapter);
      break;
    case "setup":
      await cmdSetup(adapter);
      break;
    case "cleanup":
      await cmdCleanup(adapter);
      break;
    case "doctor":
      cmdDoctor(adapter, configSource);
      break;
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${String(e)}\n`);
  process.exit(1);
});

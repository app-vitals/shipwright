/**
 * plugins/shipwright/scripts/adapters/json.ts
 *
 * JSON file backend for the Shipwright task store.
 * Reads/writes state/todos.json atomically via temp-file rename.
 *
 * Ported from task_store.py — all dep_satisfied / is_ready logic is identical.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveReadyTasks } from "../store";
import type { QueryFilters, Task, TaskStore } from "../store";
import {
  type AuditResult,
  checkCrossRepoOrphans,
  checkDanglingDeps,
  checkDuplicateIds,
} from "./audit";
import { warnMissingFields } from "./validation";

const NUMERIC_FIELDS = new Set(["pr", "hours", "complexity"]);

const TERMINAL_STATUSES = new Set<string>([
  "merged",
  "done",
  "deployed",
  "cancelled",
]);

function parseIssueUrl(url: string): { repo: string; number: number } | null {
  const match = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(url);
  if (!match) return null;
  return { repo: match[1], number: Number.parseInt(match[2], 10) };
}

export class JsonTaskStore implements TaskStore {
  private readonly warn: (msg: string) => void;

  constructor(
    private rootDir: string = process.cwd(),
    warn?: (msg: string) => void,
  ) {
    this.warn = warn ?? console.warn;
  }

  private get ghCmd(): string {
    return process.env.GH_CMD ?? "gh";
  }

  private async runGh(args: string[]): Promise<string> {
    const proc = Bun.spawn([this.ghCmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(
        `gh command failed (exit ${exitCode}): ${[this.ghCmd, ...args].join(" ")}\n${stderr}`,
      );
    }
    return stdout.trim();
  }

  private async resolveCurrentGhUser(): Promise<string | undefined> {
    try {
      const login = await this.runGh(["api", "user", "--jq", ".login"]);
      return login || undefined;
    } catch {
      return undefined;
    }
  }

  private todosPath(): string {
    return join(this.rootDir, "state", "todos.json");
  }

  private readTodos(): Task[] {
    const path = this.todosPath();
    if (!existsSync(path)) {
      throw new Error(`${path} not found — run setup first`);
    }
    return JSON.parse(readFileSync(path, "utf-8")) as Task[];
  }

  private atomicWriteJson(filePath: string, data: unknown): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.tmp_${randomBytes(8).toString("hex")}`);
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, filePath);
  }

  private writeTodos(tasks: Task[]): void {
    this.atomicWriteJson(this.todosPath(), tasks);
  }

  coerceValue(key: string, rawValue: string): number | string {
    if (NUMERIC_FIELDS.has(key)) {
      const n = Number(rawValue);
      return Number.isNaN(n) ? rawValue : n;
    }
    return rawValue;
  }

  async query(filters: QueryFilters): Promise<Task[]> {
    const tasks = this.readTodos();

    if (filters.ready) {
      // JSON backend has no GitHub access — cross-branch pr_open deps are conservatively unsatisfied.
      // Resolve readiness against the full task list so cross-session dependencies satisfy
      // correctly, then filter the output by session when --session is also provided.
      const ready = await resolveReadyTasks(tasks, async () => false);
      let result = ready;
      if (filters.session !== undefined) {
        result = result.filter((t) => t.session === filters.session);
      }
      if (filters.assignee !== undefined) {
        result = result.filter((t) => t.assignee === filters.assignee);
      }
      return result;
    }

    let result = tasks;
    if (filters.status !== undefined)
      result = result.filter((t) => t.status === filters.status);
    if (filters.session !== undefined)
      result = result.filter((t) => t.session === filters.session);
    if (filters.id !== undefined)
      result = result.filter((t) => t.id === filters.id);
    if (filters.pr !== undefined)
      result = result.filter((t) => t.pr === filters.pr);
    if (filters.assignee !== undefined)
      result = result.filter((t) => t.assignee === filters.assignee);
    if (filters.branch !== undefined)
      result = result.filter((t) => t.branch === filters.branch);
    return result;
  }

  async append(tasks: Task[]): Promise<{ inserted: number; updated: number }> {
    const existing = this.readTodos();
    const byId = new Map(existing.map((t, i) => [t.id, i]));
    let inserted = 0;
    let updated = 0;
    const currentUser = await this.resolveCurrentGhUser();

    for (const task of tasks) {
      if (!task.id) {
        console.warn("warning: task missing 'id' field — skipped");
        continue;
      }
      const idx = byId.get(task.id);
      if (idx !== undefined) {
        existing[idx] = { ...existing[idx], ...task };
        updated++;
      } else {
        const resolved =
          currentUser && !task.assignee
            ? { ...task, assignee: currentUser }
            : task;
        byId.set(resolved.id, existing.length);
        existing.push(resolved);
        inserted++;
      }
    }

    this.writeTodos(existing);
    return { inserted, updated };
  }

  async update(id: string, fields: Partial<Task>): Promise<Task> {
    const tasks = this.readTodos();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`task not found: ${id}`);

    const currentStatus = tasks[idx].status;

    // Apply non-status fields first, then status last
    const { status, ...nonStatus } = fields;
    tasks[idx] = { ...tasks[idx], ...nonStatus };
    if (status !== undefined) tasks[idx].status = status;

    warnMissingFields(currentStatus, status, tasks[idx], this.warn);

    this.writeTodos(tasks);

    if (
      status !== undefined &&
      TERMINAL_STATUSES.has(status) &&
      tasks[idx].issue
    ) {
      const parsed = parseIssueUrl(tasks[idx].issue as string);
      if (parsed) {
        try {
          const state = await this.runGh([
            "issue",
            "view",
            String(parsed.number),
            "--repo",
            parsed.repo,
            "--json",
            "state",
            "--jq",
            ".state",
          ]);
          if (state.trim().toUpperCase() === "OPEN") {
            await this.runGh([
              "issue",
              "close",
              String(parsed.number),
              "--repo",
              parsed.repo,
            ]);
          }
        } catch (e) {
          this.warn(
            `[shipwright] failed to close issue ${tasks[idx].issue}: ${String(e)}`,
          );
        }
      }
    }

    return tasks[idx];
  }

  async cleanup(): Promise<{
    closed: number;
    milestonesClosed: number;
    plansClosed: number;
  }> {
    const tasks = this.readTodos();
    let closed = 0;

    for (const task of tasks) {
      if (!TERMINAL_STATUSES.has(task.status)) continue;
      if (!task.issue) continue;

      const parsed = parseIssueUrl(task.issue);
      if (!parsed) continue;

      try {
        const state = await this.runGh([
          "issue",
          "view",
          String(parsed.number),
          "--repo",
          parsed.repo,
          "--json",
          "state",
          "--jq",
          ".state",
        ]);
        if (state.trim().toUpperCase() !== "OPEN") continue;

        await this.runGh([
          "issue",
          "close",
          String(parsed.number),
          "--repo",
          parsed.repo,
        ]);
        closed++;
      } catch (e) {
        this.warn(
          `[shipwright] cleanup: failed to close issue ${task.issue}: ${String(e)}`,
        );
      }
    }

    return { closed, milestonesClosed: 0, plansClosed: 0 };
  }

  async setup(): Promise<void> {
    const path = this.todosPath();
    if (existsSync(path)) {
      console.log("state/todos.json already exists — nothing to do");
      return;
    }
    this.atomicWriteJson(path, []);
    console.log(`Created ${path} with empty task list.`);
  }

  async resolveRepo(): Promise<string> {
    const tasks = this.readTodos();
    for (const task of tasks) {
      if (task.repo) return task.repo;
    }
    throw new Error(
      "could not resolve repo — ensure state/todos.json has at least one task with a 'repo' field",
    );
  }

  async resolveRepos(): Promise<string[]> {
    const tasks = this.readTodos();
    const seen = new Set<string>();
    for (const task of tasks) {
      if (task.repo) seen.add(task.repo);
    }
    return [...seen];
  }

  async dataDoctor(): Promise<AuditResult[]> {
    let tasks: Task[];
    try {
      tasks = this.readTodos();
    } catch {
      // If todos.json is missing, only the storage check in doctor() will surface it.
      return [];
    }

    const allIds = new Set(tasks.map((t) => t.id));
    const results: AuditResult[] = [
      ...checkDuplicateIds(tasks),
      ...checkDanglingDeps(tasks, allIds),
    ];

    // Cross-repo orphan check: use the first task's repo as the configured repo.
    // If no tasks have a repo field, emit an explicit N/A result and skip.
    const configuredRepo = tasks.find((t) => t.repo)?.repo;
    if (configuredRepo !== undefined) {
      results.push(...checkCrossRepoOrphans(tasks, configuredRepo));
    } else {
      results.push({
        level: "ok",
        check: "cross-repo-orphans",
        message: "N/A (no tasks have a repo field)",
      });
    }

    return results;
  }

  doctor(configSource: string): void {
    console.log("backend: json");
    if (configSource === "default") {
      console.log("config: default (no SHIPWRIGHT_CONFIG set)");
    } else {
      console.log(`config: ${configSource}`);
    }
    console.log("token scope: N/A (JSON backend)");

    const path = this.todosPath();
    if (existsSync(path)) {
      console.log(`[ok]  storage: ${path} present`);
    } else {
      console.warn(`[warn] storage: ${path} not found — run setup`);
    }
  }
}

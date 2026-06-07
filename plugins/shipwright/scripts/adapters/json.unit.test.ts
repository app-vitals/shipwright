/**
 * Tests for plugins/shipwright/scripts/adapters/json.ts
 *
 * Tests the JsonTaskStore class directly (not via subprocess) for speed
 * and to avoid process isolation issues.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonTaskStore } from "./json";

// ─── fake-gh helpers ─────────────────────────────────────────────────────────

/** Write a minimal fake gh script that records calls to a log file. */
function writeFakeGh(
  dir: string,
  responses: Record<string, string | "__exit0__">,
): { scriptPath: string; logPath: string } {
  const scriptPath = join(dir, "fake-gh");
  const logPath = join(dir, "gh-calls.log");
  const script = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "node:fs";
const args = argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
const responses = ${JSON.stringify(responses)};
function find(args) {
  const key = args.join(" ");
  if (key in responses) return responses[key];
  for (let l = args.length; l >= 1; l--) {
    const k = args.slice(0, l).join(" ");
    if (k in responses) return responses[k];
  }
  return null;
}
const r = find(args);
if (r === null) { console.error("fake-gh: no response for:", args.join(" ")); process.exit(1); }
if (r === "__exit0__") process.exit(0);
console.log(r);
`;
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
  return { scriptPath, logPath };
}

describe("JsonTaskStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "json-adapter-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTodos(tasks: unknown[]): void {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "todos.json"),
      JSON.stringify(tasks, null, 2),
    );
  }

  function readTodos(): unknown[] {
    return JSON.parse(
      readFileSync(join(tmpDir, "state", "todos.json"), "utf-8"),
    ) as unknown[];
  }

  // ─── query ───────────────────────────────────────────────────────────────────

  describe("query", () => {
    test("--ready returns only pending tasks with all deps satisfied", async () => {
      writeTodos([
        { id: "T-1", title: "No deps", status: "pending", dependencies: [] },
        {
          id: "T-2",
          title: "In progress",
          status: "in_progress",
          dependencies: [],
        },
        {
          id: "T-3",
          title: "Pending blocked",
          status: "pending",
          dependencies: ["T-2"],
        },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ ready: true });
      expect(results.map((t) => t.id)).toEqual(["T-1"]);
    });

    test("--ready with dep status merged is satisfied", async () => {
      writeTodos([
        { id: "D-1", title: "Dep", status: "merged" },
        { id: "T-1", title: "Task", status: "pending", dependencies: ["D-1"] },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ ready: true });
      expect(results.map((t) => t.id)).toContain("T-1");
      expect(results.map((t) => t.id)).not.toContain("D-1");
    });

    test("--ready with dep status done is satisfied (legacy)", async () => {
      writeTodos([
        { id: "D-1", title: "Dep", status: "done" },
        { id: "T-1", title: "Task", status: "pending", dependencies: ["D-1"] },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ ready: true });
      expect(results.map((t) => t.id)).toContain("T-1");
    });

    test("--ready with dep sharing same branch + status pr_open is satisfied", async () => {
      const branch = "feat/shared-branch";
      writeTodos([
        { id: "D-1", title: "Dep", status: "pr_open", branch },
        {
          id: "T-1",
          title: "Task",
          status: "pending",
          branch,
          dependencies: ["D-1"],
        },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ ready: true });
      expect(results.map((t) => t.id)).toContain("T-1");
    });

    test("--ready with dep sharing same branch + status approved is satisfied", async () => {
      const branch = "feat/shared-branch";
      writeTodos([
        { id: "D-1", title: "Dep", status: "approved", branch },
        {
          id: "T-1",
          title: "Task",
          status: "pending",
          branch,
          dependencies: ["D-1"],
        },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ ready: true });
      expect(results.map((t) => t.id)).toContain("T-1");
    });

    test("--ready treats deployed dep as satisfied", async () => {
      writeTodos([
        { id: "D-1", title: "Dep", status: "deployed" },
        { id: "T-1", title: "Task", status: "pending", dependencies: ["D-1"] },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ ready: true });
      expect(results.map((t) => t.id)).toContain("T-1");
    });

    test("--ready with dep status pending is NOT satisfied", async () => {
      const branch = "feat/shared-branch";
      writeTodos([
        { id: "D-1", title: "Dep", status: "pending", branch },
        {
          id: "T-1",
          title: "Task",
          status: "pending",
          branch,
          dependencies: ["D-1"],
        },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ ready: true });
      expect(results.map((t) => t.id)).not.toContain("T-1");
    });

    test("--ready with dep on different branch and in_progress is NOT satisfied", async () => {
      writeTodos([
        { id: "D-1", title: "Dep", status: "in_progress", branch: "feat/dep" },
        {
          id: "T-1",
          title: "Task",
          status: "pending",
          branch: "feat/task",
          dependencies: ["D-1"],
        },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ ready: true });
      expect(results.map((t) => t.id)).not.toContain("T-1");
    });

    test("--ready with unknown dep ID is NOT satisfied (conservative)", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task",
          status: "pending",
          dependencies: ["UNKNOWN-DEP"],
        },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ ready: true });
      expect(results).toHaveLength(0);
    });

    test("--ready --session returns only ready tasks from the specified session", async () => {
      writeTodos([
        {
          id: "A-1",
          title: "Alpha ready",
          status: "pending",
          session: "alpha",
          dependencies: [],
        },
        {
          id: "B-1",
          title: "Beta ready",
          status: "pending",
          session: "beta",
          dependencies: [],
        },
        {
          id: "B-2",
          title: "Beta blocked",
          status: "pending",
          session: "beta",
          dependencies: ["B-3"],
        },
        {
          id: "B-3",
          title: "Beta dep",
          status: "in_progress",
          session: "beta",
          dependencies: [],
        },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ ready: true, session: "beta" });
      expect(results.map((t) => t.id)).toEqual(["B-1"]);
      expect(results.map((t) => t.id)).not.toContain("A-1");
      expect(results.map((t) => t.id)).not.toContain("B-2");
    });

    test("--ready --session resolves cross-session deps against full task list", async () => {
      // A-1 (session alpha, merged) satisfies B-1's dependency
      writeTodos([
        {
          id: "A-1",
          title: "Alpha dep",
          status: "merged",
          session: "alpha",
          dependencies: [],
        },
        {
          id: "B-1",
          title: "Beta task",
          status: "pending",
          session: "beta",
          dependencies: ["A-1"],
        },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ ready: true, session: "beta" });
      // B-1 should be ready: its dep A-1 is merged (cross-session dep satisfied)
      expect(results.map((t) => t.id)).toContain("B-1");
    });

    test("--status filters by exact status", async () => {
      writeTodos([
        { id: "T-1", title: "Pending", status: "pending" },
        { id: "T-2", title: "In progress", status: "in_progress" },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ status: "pending" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("T-1");
    });

    test("--session filters by session", async () => {
      writeTodos([
        { id: "T-1", title: "Alpha", status: "pending", session: "alpha" },
        { id: "T-2", title: "Beta", status: "pending", session: "beta" },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ session: "alpha" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("T-1");
    });

    test("--id filters by id", async () => {
      writeTodos([
        { id: "T-1", title: "First", status: "pending" },
        { id: "T-2", title: "Second", status: "pending" },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ id: "T-2" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("T-2");
    });

    test("--pr filters by pr number", async () => {
      writeTodos([
        { id: "T-1", title: "With PR", status: "pr_open", pr: 42 },
        { id: "T-2", title: "No PR", status: "pending" },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({ pr: 42 });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("T-1");
    });

    test("no filters returns all tasks", async () => {
      writeTodos([
        { id: "T-1", title: "First", status: "pending" },
        { id: "T-2", title: "Second", status: "merged" },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const results = await adapter.query({});
      expect(results).toHaveLength(2);
    });
  });

  // ─── append ──────────────────────────────────────────────────────────────────

  describe("append", () => {
    test("fresh append: returns inserted=N, updated=0", async () => {
      writeTodos([]);
      const adapter = new JsonTaskStore(tmpDir);
      const result = await adapter.append([
        { id: "T-1", title: "First", status: "pending" },
        { id: "T-2", title: "Second", status: "pending" },
      ]);
      expect(result.inserted).toBe(2);
      expect(result.updated).toBe(0);
      const todos = readTodos() as Array<{ id: string }>;
      expect(todos).toHaveLength(2);
    });

    test("idempotent: re-running same tasks returns inserted=0, updated=N", async () => {
      writeTodos([]);
      const adapter = new JsonTaskStore(tmpDir);
      const tasks = [
        { id: "T-1", title: "First", status: "pending" as const },
        { id: "T-2", title: "Second", status: "pending" as const },
      ];
      await adapter.append(tasks);
      const result = await adapter.append(tasks);
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(2);
      const todos = readTodos() as Array<{ id: string }>;
      expect(todos).toHaveLength(2);
    });

    test("append merges new fields over existing", async () => {
      writeTodos([{ id: "T-1", title: "Old title", status: "pending" }]);
      const adapter = new JsonTaskStore(tmpDir);
      await adapter.append([
        { id: "T-1", title: "New title", status: "pending" },
      ]);
      const todos = readTodos() as Array<{ id: string; title: string }>;
      expect(todos[0].title).toBe("New title");
    });

    test("task missing id is skipped", async () => {
      writeTodos([]);
      const adapter = new JsonTaskStore(tmpDir);
      // Cast to bypass TS requirement for id field
      const result = await adapter.append([
        { title: "No id", status: "pending" } as never,
      ]);
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(0);
      const todos = readTodos();
      expect(todos).toHaveLength(0);
    });

    test("mixed insert and update", async () => {
      writeTodos([{ id: "T-1", title: "Existing", status: "pending" }]);
      const adapter = new JsonTaskStore(tmpDir);
      const result = await adapter.append([
        { id: "T-1", title: "Updated", status: "pending" },
        { id: "T-2", title: "New", status: "pending" },
      ]);
      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(1);
      const todos = readTodos() as Array<{ id: string; title: string }>;
      expect(todos).toHaveLength(2);
      expect(todos.find((t) => t.id === "T-1")?.title).toBe("Updated");
    });

    test("auto-assigns current GH user to inserted tasks", async () => {
      const { scriptPath } = writeFakeGh(tmpDir, {
        "api user --jq .login": "autobot",
      });
      process.env.GH_CMD = scriptPath;
      writeTodos([]);
      const adapter = new JsonTaskStore(tmpDir);
      await adapter.append([{ id: "T-1", title: "Task", status: "pending" }]);
      const todos = readTodos() as Array<{ id: string; assignee?: string }>;
      expect(todos[0].assignee).toBe("autobot");
      process.env.GH_CMD = undefined;
    });

    test("preserves explicit assignee over current GH user", async () => {
      const { scriptPath } = writeFakeGh(tmpDir, {
        "api user --jq .login": "autobot",
      });
      process.env.GH_CMD = scriptPath;
      writeTodos([]);
      const adapter = new JsonTaskStore(tmpDir);
      await adapter.append([
        { id: "T-1", title: "Task", status: "pending", assignee: "octocat" },
      ]);
      const todos = readTodos() as Array<{ id: string; assignee?: string }>;
      expect(todos[0].assignee).toBe("octocat");
      process.env.GH_CMD = undefined;
    });

    test("does not auto-assign when gh user resolution fails", async () => {
      const { scriptPath } = writeFakeGh(tmpDir, {});
      process.env.GH_CMD = scriptPath;
      writeTodos([]);
      const adapter = new JsonTaskStore(tmpDir);
      await adapter.append([{ id: "T-1", title: "Task", status: "pending" }]);
      const todos = readTodos() as Array<{ id: string; assignee?: string }>;
      expect(todos[0].assignee).toBeUndefined();
      process.env.GH_CMD = undefined;
    });
  });

  // ─── update ──────────────────────────────────────────────────────────────────

  describe("update", () => {
    test("updates specific fields on a task", async () => {
      writeTodos([{ id: "T-1", title: "Original", status: "pending" }]);
      const adapter = new JsonTaskStore(tmpDir);
      const updated = await adapter.update("T-1", { status: "in_progress" });
      expect(updated.status).toBe("in_progress");
      const todos = readTodos() as Array<{ id: string; status: string }>;
      expect(todos[0].status).toBe("in_progress");
    });

    test("pr field is coerced to number", async () => {
      writeTodos([{ id: "T-1", title: "Task", status: "pending" }]);
      const adapter = new JsonTaskStore(tmpDir);
      // coerceValue is used by the CLI wrapper; test it directly
      expect(adapter.coerceValue("pr", "99")).toBe(99);
      expect(typeof adapter.coerceValue("pr", "99")).toBe("number");
    });

    test("hours field is coerced to number", async () => {
      const adapter = new JsonTaskStore(tmpDir);
      expect(adapter.coerceValue("hours", "3.5")).toBe(3.5);
      expect(typeof adapter.coerceValue("hours", "3.5")).toBe("number");
    });

    test("non-numeric fields remain as strings", async () => {
      const adapter = new JsonTaskStore(tmpDir);
      expect(adapter.coerceValue("title", "some title")).toBe("some title");
      expect(typeof adapter.coerceValue("title", "some title")).toBe("string");
      expect(adapter.coerceValue("status", "pending")).toBe("pending");
    });

    test("status is written last (non-status fields first)", async () => {
      writeTodos([{ id: "T-1", title: "Original", status: "pending" }]);
      const adapter = new JsonTaskStore(tmpDir);
      const updated = await adapter.update("T-1", {
        status: "pr_open",
        title: "Updated",
      });
      expect(updated.status).toBe("pr_open");
      expect(updated.title).toBe("Updated");
    });

    test("throws if task id not found", async () => {
      writeTodos([{ id: "T-1", title: "Task", status: "pending" }]);
      const adapter = new JsonTaskStore(tmpDir);
      await expect(
        adapter.update("NOPE", { status: "merged" }),
      ).rejects.toThrow("task not found: NOPE");
    });

    test("update does not touch other tasks", async () => {
      writeTodos([
        { id: "T-1", title: "First", status: "pending" },
        { id: "T-2", title: "Second", status: "pending" },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      await adapter.update("T-1", { status: "in_progress" });
      const todos = readTodos() as Array<{ id: string; status: string }>;
      expect(todos.find((t) => t.id === "T-2")?.status).toBe("pending");
    });
  });

  // ─── setup ───────────────────────────────────────────────────────────────────

  describe("setup", () => {
    test("creates state/todos.json with empty array if missing", async () => {
      // Don't pre-create state/ directory
      const adapter = new JsonTaskStore(tmpDir);
      await adapter.setup();
      const path = join(tmpDir, "state", "todos.json");
      expect(existsSync(path)).toBe(true);
      const data = JSON.parse(readFileSync(path, "utf-8"));
      expect(data).toEqual([]);
    });

    test("no-op if todos.json already exists", async () => {
      writeTodos([{ id: "T-1", title: "Existing", status: "pending" }]);
      const adapter = new JsonTaskStore(tmpDir);
      await adapter.setup();
      // Should still have the original task (not overwritten)
      const todos = readTodos() as Array<{ id: string }>;
      expect(todos).toHaveLength(1);
      expect(todos[0].id).toBe("T-1");
    });
  });

  // ─── resolveRepo ─────────────────────────────────────────────────────────────

  describe("resolveRepo", () => {
    test("returns first task repo field", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task",
          status: "pending",
          repo: "app-vitals/vitals-os",
        },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const repo = await adapter.resolveRepo();
      expect(repo).toBe("app-vitals/vitals-os");
    });

    test("throws if no task has a repo field", async () => {
      writeTodos([{ id: "T-1", title: "Task", status: "pending" }]);
      const adapter = new JsonTaskStore(tmpDir);
      await expect(adapter.resolveRepo()).rejects.toThrow(
        "could not resolve repo",
      );
    });

    test("throws if todos is empty", async () => {
      writeTodos([]);
      const adapter = new JsonTaskStore(tmpDir);
      await expect(adapter.resolveRepo()).rejects.toThrow(
        "could not resolve repo",
      );
    });
  });

  // ─── resolveRepos ────────────────────────────────────────────────────────────

  describe("resolveRepos", () => {
    test("returns all unique repos from tasks", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task 1",
          status: "pending",
          repo: "app-vitals/vitals-os",
        },
        {
          id: "T-2",
          title: "Task 2",
          status: "pending",
          repo: "app-vitals/marketplace",
        },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const repos = await adapter.resolveRepos();
      expect(repos).toHaveLength(2);
      expect(repos).toContain("app-vitals/vitals-os");
      expect(repos).toContain("app-vitals/marketplace");
    });

    test("deduplicates repos across tasks", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task 1",
          status: "pending",
          repo: "app-vitals/vitals-os",
        },
        {
          id: "T-2",
          title: "Task 2",
          status: "pending",
          repo: "app-vitals/vitals-os",
        },
        {
          id: "T-3",
          title: "Task 3",
          status: "pending",
          repo: "app-vitals/marketplace",
        },
      ]);
      const adapter = new JsonTaskStore(tmpDir);
      const repos = await adapter.resolveRepos();
      expect(repos).toHaveLength(2);
    });

    test("returns [] for empty todos", async () => {
      writeTodos([]);
      const adapter = new JsonTaskStore(tmpDir);
      const repos = await adapter.resolveRepos();
      expect(repos).toEqual([]);
    });

    test("returns [] when no tasks have repo field", async () => {
      writeTodos([{ id: "T-1", title: "Task 1", status: "pending" }]);
      const adapter = new JsonTaskStore(tmpDir);
      const repos = await adapter.resolveRepos();
      expect(repos).toEqual([]);
    });
  });

  // ─── doctor ──────────────────────────────────────────────────────────────────

  describe("doctor", () => {
    test("prints backend: json and config source (default)", () => {
      const adapter = new JsonTaskStore(tmpDir);
      const output: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => output.push(args.join(" "));
      try {
        adapter.doctor("default");
      } finally {
        console.log = origLog;
      }
      expect(output.join("\n")).toContain("backend: json");
      expect(output.join("\n")).toContain("default");
    });

    test("ok message if todos.json exists", () => {
      writeTodos([]);
      const adapter = new JsonTaskStore(tmpDir);
      const output: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => output.push(args.join(" "));
      try {
        adapter.doctor("default");
      } finally {
        console.log = origLog;
      }
      expect(output.join("\n")).toContain("[ok]");
    });

    test("warn message if todos.json missing", () => {
      const adapter = new JsonTaskStore(tmpDir);
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
      try {
        adapter.doctor("default");
      } finally {
        console.warn = origWarn;
      }
      expect(warnings.join("\n")).toContain("[warn]");
    });

    test("prints config source path when not default", () => {
      writeTodos([]);
      const adapter = new JsonTaskStore(tmpDir);
      const output: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => output.push(args.join(" "));
      try {
        adapter.doctor("/path/to/config.json");
      } finally {
        console.log = origLog;
      }
      expect(output.join("\n")).toContain("/path/to/config.json");
    });
  });

  // ─── update field enforcement warnings ───────────────────────────────────────

  describe("update field enforcement warnings", () => {
    test("warns when prCreatedAt missing on pr_open transition", async () => {
      writeTodos([{ id: "T-1", title: "Task", status: "in_progress" }]);
      const warnings: string[] = [];
      const adapter = new JsonTaskStore(tmpDir, (msg) => warnings.push(msg));
      await adapter.update("T-1", {
        status: "pr_open",
        pr: 42,
        prUrl: "https://example.com/pr/42",
      });
      expect(warnings.some((w) => w.includes("prCreatedAt"))).toBe(true);
    });

    test("warns when pr missing on pr_open transition (with no prUrl either)", async () => {
      writeTodos([{ id: "T-1", title: "Task", status: "in_progress" }]);
      const warnings: string[] = [];
      const adapter = new JsonTaskStore(tmpDir, (msg) => warnings.push(msg));
      await adapter.update("T-1", {
        status: "pr_open",
        prCreatedAt: "2026-01-01T00:00:00Z",
      });
      expect(
        warnings.some((w) => w.includes("pr") || w.includes("prUrl")),
      ).toBe(true);
    });

    test("does NOT warn when pr is present on pr_open transition", async () => {
      writeTodos([{ id: "T-1", title: "Task", status: "in_progress" }]);
      const warnings: string[] = [];
      const adapter = new JsonTaskStore(tmpDir, (msg) => warnings.push(msg));
      await adapter.update("T-1", {
        status: "pr_open",
        pr: 42,
        prCreatedAt: "2026-01-01T00:00:00Z",
      });
      expect(
        warnings.some((w) => w.includes("pr") || w.includes("prUrl")),
      ).toBe(false);
    });

    test("does NOT warn when prUrl is present on pr_open transition (pr missing but prUrl present)", async () => {
      writeTodos([{ id: "T-1", title: "Task", status: "in_progress" }]);
      const warnings: string[] = [];
      const adapter = new JsonTaskStore(tmpDir, (msg) => warnings.push(msg));
      await adapter.update("T-1", {
        status: "pr_open",
        prUrl: "https://example.com/pr/42",
        prCreatedAt: "2026-01-01T00:00:00Z",
      });
      expect(
        warnings.some((w) => w.includes("pr") || w.includes("prUrl")),
      ).toBe(false);
    });

    test("warns when ciFixAttempts missing on approved transition (from pr_open)", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task",
          status: "pr_open",
          pr: 42,
          prCreatedAt: "2026-01-01T00:00:00Z",
        },
      ]);
      const warnings: string[] = [];
      const adapter = new JsonTaskStore(tmpDir, (msg) => warnings.push(msg));
      await adapter.update("T-1", { status: "approved" });
      expect(warnings.some((w) => w.includes("ciFixAttempts"))).toBe(true);
    });

    test("warns when ciFixAttempts missing on merged transition (from pr_open)", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task",
          status: "pr_open",
          pr: 42,
          prCreatedAt: "2026-01-01T00:00:00Z",
        },
      ]);
      const warnings: string[] = [];
      const adapter = new JsonTaskStore(tmpDir, (msg) => warnings.push(msg));
      await adapter.update("T-1", { status: "merged" });
      expect(warnings.some((w) => w.includes("ciFixAttempts"))).toBe(true);
    });

    test("does NOT warn when ciFixAttempts is present", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task",
          status: "pr_open",
          pr: 42,
          prCreatedAt: "2026-01-01T00:00:00Z",
        },
      ]);
      const warnings: string[] = [];
      const adapter = new JsonTaskStore(tmpDir, (msg) => warnings.push(msg));
      await adapter.update("T-1", { status: "approved", ciFixAttempts: 0 });
      expect(warnings.some((w) => w.includes("ciFixAttempts"))).toBe(false);
    });

    test("does NOT warn for transitions to other statuses (e.g., in_progress)", async () => {
      writeTodos([{ id: "T-1", title: "Task", status: "pending" }]);
      const warnings: string[] = [];
      const adapter = new JsonTaskStore(tmpDir, (msg) => warnings.push(msg));
      await adapter.update("T-1", { status: "in_progress" });
      expect(warnings).toHaveLength(0);
    });

    test("update still succeeds (writes) even when warnings fire", async () => {
      writeTodos([{ id: "T-1", title: "Task", status: "in_progress" }]);
      const warnings: string[] = [];
      const adapter = new JsonTaskStore(tmpDir, (msg) => warnings.push(msg));
      const result = await adapter.update("T-1", { status: "pr_open" });
      expect(result?.status).toBe("pr_open");
      const todos = readTodos() as Array<{ id: string; status: string }>;
      expect(todos[0].status).toBe("pr_open");
    });
  });

  // ─── terminal status closes GitHub issue ─────────────────────────────────────

  describe("update closes GitHub issue on terminal status transition", () => {
    test("closes issue when transitioning to merged", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task",
          status: "pr_open",
          issue: "https://github.com/app-vitals/vitals-os/issues/42",
        },
      ]);
      const { scriptPath, logPath } = writeFakeGh(tmpDir, {
        "issue view 42 --repo app-vitals/vitals-os --json state --jq .state":
          "OPEN",
        "issue close 42 --repo app-vitals/vitals-os": "__exit0__",
      });
      process.env.GH_CMD = scriptPath;
      try {
        const adapter = new JsonTaskStore(tmpDir);
        await adapter.update("T-1", { status: "merged" });
        const calls = readFileSync(logPath, "utf-8").trim();
        expect(calls).toContain("issue close 42 --repo app-vitals/vitals-os");
      } finally {
        process.env.GH_CMD = undefined;
      }
    });

    test("closes issue when transitioning to deployed", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task",
          status: "merged",
          issue: "https://github.com/app-vitals/vitals-os/issues/99",
        },
      ]);
      const { scriptPath, logPath } = writeFakeGh(tmpDir, {
        "issue view 99 --repo app-vitals/vitals-os --json state --jq .state":
          "OPEN",
        "issue close 99 --repo app-vitals/vitals-os": "__exit0__",
      });
      process.env.GH_CMD = scriptPath;
      try {
        const adapter = new JsonTaskStore(tmpDir);
        await adapter.update("T-1", { status: "deployed" });
        const calls = readFileSync(logPath, "utf-8").trim();
        expect(calls).toContain("issue close 99 --repo app-vitals/vitals-os");
      } finally {
        process.env.GH_CMD = undefined;
      }
    });

    test("skips gh issue close when issue is already closed", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task",
          status: "merged",
          issue: "https://github.com/app-vitals/vitals-os/issues/55",
        },
      ]);
      const { scriptPath, logPath } = writeFakeGh(tmpDir, {
        "issue view 55 --repo app-vitals/vitals-os --json state --jq .state":
          "CLOSED",
      });
      process.env.GH_CMD = scriptPath;
      try {
        const adapter = new JsonTaskStore(tmpDir);
        await adapter.update("T-1", { status: "deployed" });
        const calls = readFileSync(logPath, "utf-8").trim();
        expect(calls).not.toContain("issue close");
      } finally {
        process.env.GH_CMD = undefined;
      }
    });

    test("does NOT call gh when task has no issue field", async () => {
      writeTodos([{ id: "T-1", title: "Task", status: "pr_open" }]);
      const { scriptPath, logPath } = writeFakeGh(tmpDir, {});
      process.env.GH_CMD = scriptPath;
      try {
        const adapter = new JsonTaskStore(tmpDir);
        await adapter.update("T-1", { status: "merged" });
        expect(existsSync(logPath)).toBe(false);
      } finally {
        process.env.GH_CMD = undefined;
      }
    });

    test("does NOT call gh for non-terminal status transitions", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task",
          status: "pending",
          issue: "https://github.com/app-vitals/vitals-os/issues/7",
        },
      ]);
      const { scriptPath, logPath } = writeFakeGh(tmpDir, {});
      process.env.GH_CMD = scriptPath;
      try {
        const adapter = new JsonTaskStore(tmpDir);
        await adapter.update("T-1", { status: "in_progress" });
        expect(existsSync(logPath)).toBe(false);
      } finally {
        process.env.GH_CMD = undefined;
      }
    });

    test("warns but does not throw when gh fails", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Task",
          status: "pr_open",
          issue: "https://github.com/app-vitals/vitals-os/issues/5",
        },
      ]);
      // No fake-gh — GH_CMD points to a nonexistent binary
      process.env.GH_CMD = join(tmpDir, "no-such-gh");
      const warnings: string[] = [];
      try {
        const adapter = new JsonTaskStore(tmpDir, (msg) => warnings.push(msg));
        const result = await adapter.update("T-1", { status: "merged" });
        // Write still succeeds
        expect(result.status).toBe("merged");
        expect(warnings.some((w) => w.includes("failed to close issue"))).toBe(
          true,
        );
      } finally {
        process.env.GH_CMD = undefined;
      }
    });
  });

  // ─── cleanup ─────────────────────────────────────────────────────────────────

  describe("cleanup", () => {
    test("closes open issues for terminal-status tasks", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Merged",
          status: "merged",
          issue: "https://github.com/app-vitals/vitals-os/issues/10",
        },
        {
          id: "T-2",
          title: "Pending",
          status: "pending",
          issue: "https://github.com/app-vitals/vitals-os/issues/11",
        },
      ]);
      const { scriptPath, logPath } = writeFakeGh(tmpDir, {
        "issue view 10 --repo app-vitals/vitals-os --json state --jq .state":
          "OPEN",
        "issue close 10 --repo app-vitals/vitals-os": "__exit0__",
      });
      process.env.GH_CMD = scriptPath;
      try {
        const adapter = new JsonTaskStore(tmpDir);
        const result = await adapter.cleanup();
        expect(result.closed).toBe(1);
        const calls = readFileSync(logPath, "utf-8");
        expect(calls).toContain("issue close 10");
        expect(calls).not.toContain("issue close 11");
      } finally {
        process.env.GH_CMD = undefined;
      }
    });

    test("skips already-closed issues", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Merged",
          status: "merged",
          issue: "https://github.com/app-vitals/vitals-os/issues/20",
        },
      ]);
      const { scriptPath, logPath } = writeFakeGh(tmpDir, {
        "issue view 20 --repo app-vitals/vitals-os --json state --jq .state":
          "CLOSED",
      });
      process.env.GH_CMD = scriptPath;
      try {
        const adapter = new JsonTaskStore(tmpDir);
        const result = await adapter.cleanup();
        expect(result.closed).toBe(0);
        const calls = readFileSync(logPath, "utf-8");
        expect(calls).not.toContain("issue close");
      } finally {
        process.env.GH_CMD = undefined;
      }
    });

    test("skips tasks with no issue URL", async () => {
      writeTodos([{ id: "T-1", title: "Merged no issue", status: "merged" }]);
      const { scriptPath, logPath } = writeFakeGh(tmpDir, {});
      process.env.GH_CMD = scriptPath;
      try {
        const adapter = new JsonTaskStore(tmpDir);
        const result = await adapter.cleanup();
        expect(result.closed).toBe(0);
        expect(existsSync(logPath)).toBe(false);
      } finally {
        process.env.GH_CMD = undefined;
      }
    });

    test("warns and continues when gh fails for one issue", async () => {
      writeTodos([
        {
          id: "T-1",
          title: "Merged",
          status: "merged",
          issue: "https://github.com/app-vitals/vitals-os/issues/30",
        },
        {
          id: "T-2",
          title: "Deployed",
          status: "deployed",
          issue: "https://github.com/app-vitals/vitals-os/issues/31",
        },
      ]);
      const { scriptPath } = writeFakeGh(tmpDir, {
        // T-1 view fails (bad gh), T-2 view + close succeeds
        "issue view 30 --repo app-vitals/vitals-os --json state --jq .state":
          "OPEN",
        // issue close 30 is missing → gh exits 1
        "issue view 31 --repo app-vitals/vitals-os --json state --jq .state":
          "OPEN",
        "issue close 31 --repo app-vitals/vitals-os": "__exit0__",
      });
      process.env.GH_CMD = scriptPath;
      const warnings: string[] = [];
      try {
        const adapter = new JsonTaskStore(tmpDir, (msg) => warnings.push(msg));
        const result = await adapter.cleanup();
        // T-2 was closed; T-1 close failed but was warned
        expect(result.closed).toBe(1);
        expect(
          warnings.some((w) => w.includes("cleanup: failed to close issue")),
        ).toBe(true);
      } finally {
        process.env.GH_CMD = undefined;
      }
    });
  });
});

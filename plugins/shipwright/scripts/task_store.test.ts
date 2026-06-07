/**
 * plugins/shipwright/scripts/task_store.test.ts
 *
 * Black-box CLI tests for task_store.ts — invoked via Bun.spawnSync subprocess.
 * Ported from test_task_store.py (JSON backend only; GitHub classes dropped).
 *
 * Strategy: set spawnSync cwd to a per-test temp dir so that JsonTaskStore
 * (which uses process.cwd() as rootDir) reads/writes <tmpdir>/state/todos.json.
 * The script path is absolute so it resolves correctly from any cwd.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Task } from "./store";

// ---------------------------------------------------------------------------
// Git clone fixture helper
// ---------------------------------------------------------------------------

/** Create a fake git clone with a remote origin URL in dir/repoName. */
function makeGitClone(
  parentDir: string,
  repoName: string,
  remoteUrl: string,
): void {
  const repoDir = join(parentDir, repoName);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  const gitConfig = `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  writeFileSync(join(repoDir, ".git", "config"), gitConfig);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCRIPT = join(REPO_ROOT, "plugins/shipwright/scripts/task_store.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a base task (mirrors Python make_task). */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "TS-1.1",
    source: "shipwright",
    session: "test-session",
    repo: "vitals-os",
    title: "Test task",
    description: "A test task",
    acceptanceCriteria: [],
    layer: "Shared",
    branch: "feat/ts-1",
    dependencies: [],
    hours: 2,
    status: "pending",
    pr: undefined,
    addedAt: "2026-01-01T00:00:00Z",
    startedAt: undefined,
    prCreatedAt: undefined,
    mergedAt: undefined,
    ...overrides,
  } as Task;
}

/**
 * Run the CLI via subprocess.
 * cwd defaults to the test's temp dir — JsonTaskStore uses process.cwd() as rootDir.
 * SHIPWRIGHT_CONFIG is cleared by default so the JSON backend is always used.
 */
function run(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
) {
  const result = Bun.spawnSync(["bun", SCRIPT, ...args], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      SHIPWRIGHT_CONFIG: "",
      ...(opts.env ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/** Write state/todos.json in tmpDir. */
function writeTodos(tmpDir: string, tasks: unknown[]): void {
  mkdirSync(join(tmpDir, "state"), { recursive: true });
  writeFileSync(
    join(tmpDir, "state", "todos.json"),
    JSON.stringify(tasks, null, 2),
  );
}

/** Read state/todos.json from tmpDir. */
function readTodos(tmpDir: string): unknown[] {
  return JSON.parse(
    readFileSync(join(tmpDir, "state", "todos.json"), "utf-8"),
  ) as unknown[];
}

/** Write a JSON file and return its path. */
function writeJsonFile(tmpDir: string, name: string, data: unknown): string {
  const path = join(tmpDir, name);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// describe("query --ready")
// ---------------------------------------------------------------------------

describe("query --ready", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
    mkdirSync(join(tmpDir, "state"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("pending task with no dependencies is ready", () => {
    const task = makeTask({
      id: "TS-1.1",
      status: "pending",
      dependencies: [],
    });
    writeTodos(tmpDir, [task]);
    const { code, stdout, stderr } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as Array<{ id: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("TS-1.1");
    void stderr;
  });

  test("merged dep is satisfied — task appears in --ready", () => {
    const dep = makeTask({
      id: "TS-0.1",
      status: "merged",
      branch: "feat/ts-0",
    });
    const task = makeTask({
      id: "TS-1.1",
      status: "pending",
      branch: "feat/ts-1",
      dependencies: ["TS-0.1"],
    });
    writeTodos(tmpDir, [dep, task]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const ids = (JSON.parse(stdout) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain("TS-1.1");
    expect(ids).not.toContain("TS-0.1");
  });

  test("done dep is satisfied (legacy status)", () => {
    const dep = makeTask({ id: "TS-0.1", status: "done", branch: "feat/ts-0" });
    const task = makeTask({
      id: "TS-1.1",
      status: "pending",
      branch: "feat/ts-1",
      dependencies: ["TS-0.1"],
    });
    writeTodos(tmpDir, [dep, task]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const ids = (JSON.parse(stdout) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain("TS-1.1");
  });

  test("in_progress dep on different branch — task NOT ready", () => {
    const dep = makeTask({
      id: "TS-0.1",
      status: "in_progress",
      branch: "feat/ts-0",
    });
    const task = makeTask({
      id: "TS-1.1",
      status: "pending",
      branch: "feat/ts-1",
      dependencies: ["TS-0.1"],
    });
    writeTodos(tmpDir, [dep, task]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const ids = (JSON.parse(stdout) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).not.toContain("TS-1.1");
  });

  test("same-branch dep at pr_open satisfies dependency", () => {
    const branch = "feat/ts-bundle";
    const dep = makeTask({ id: "TS-1.1", status: "pr_open", branch });
    const task = makeTask({
      id: "TS-1.2",
      status: "pending",
      branch,
      dependencies: ["TS-1.1"],
    });
    writeTodos(tmpDir, [dep, task]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const ids = (JSON.parse(stdout) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain("TS-1.2");
  });

  test("same-branch dep at approved satisfies dependency", () => {
    const branch = "feat/ts-bundle";
    const dep = makeTask({ id: "TS-1.1", status: "approved", branch });
    const task = makeTask({
      id: "TS-1.2",
      status: "pending",
      branch,
      dependencies: ["TS-1.1"],
    });
    writeTodos(tmpDir, [dep, task]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const ids = (JSON.parse(stdout) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain("TS-1.2");
  });

  test("same-branch dep at pending does NOT satisfy dependency", () => {
    const branch = "feat/ts-bundle";
    const dep = makeTask({ id: "TS-1.1", status: "pending", branch });
    const task = makeTask({
      id: "TS-1.2",
      status: "pending",
      branch,
      dependencies: ["TS-1.1"],
    });
    writeTodos(tmpDir, [dep, task]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const ids = (JSON.parse(stdout) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).not.toContain("TS-1.2");
  });

  test("in_progress task is NOT in --ready results", () => {
    const task = makeTask({
      id: "TS-1.1",
      status: "in_progress",
      dependencies: [],
    });
    writeTodos(tmpDir, [task]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as unknown[];
    expect(result).toEqual([]);
  });

  test("unknown dep ID — task NOT ready (conservative)", () => {
    const task = makeTask({
      id: "TS-1.1",
      status: "pending",
      dependencies: ["GHOST"],
    });
    writeTodos(tmpDir, [task]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as unknown[];
    expect(result).toHaveLength(0);
  });

  test("chain: A merged, B pending dep A, C pending dep B — B is ready but C is NOT ready (C's dep unmet)", () => {
    // A merged → B ready; B not merged → C not ready
    const a = makeTask({ id: "A", status: "merged", branch: "feat/a" });
    const b = makeTask({
      id: "B",
      status: "pending",
      branch: "feat/b",
      dependencies: ["A"],
    });
    const c = makeTask({
      id: "C",
      status: "pending",
      branch: "feat/c",
      dependencies: ["B"],
    });
    writeTodos(tmpDir, [a, b, c]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const ids = (JSON.parse(stdout) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain("B");
    expect(ids).not.toContain("C");
    expect(ids).not.toContain("A");
  });

  test("multi-dep fan-in: both deps merged → task appears in --ready", () => {
    const depA = makeTask({ id: "A", status: "merged", branch: "feat/a" });
    const depB = makeTask({ id: "B", status: "merged", branch: "feat/b" });
    const task = makeTask({
      id: "TS-1.1",
      status: "pending",
      branch: "feat/ts-1",
      dependencies: ["A", "B"],
    });
    writeTodos(tmpDir, [depA, depB, task]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const ids = (JSON.parse(stdout) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain("TS-1.1");
  });

  test("multi-dep fan-in: one dep in_progress → task NOT in --ready", () => {
    const depA = makeTask({ id: "A", status: "merged", branch: "feat/a" });
    const depB = makeTask({
      id: "B",
      status: "in_progress",
      branch: "feat/b",
    });
    const task = makeTask({
      id: "TS-1.1",
      status: "pending",
      branch: "feat/ts-1",
      dependencies: ["A", "B"],
    });
    writeTodos(tmpDir, [depA, depB, task]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const ids = (JSON.parse(stdout) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).not.toContain("TS-1.1");
  });

  test("multiple independent ready tasks are all returned", () => {
    writeTodos(tmpDir, [
      makeTask({ id: "X", status: "pending", dependencies: [] }),
      makeTask({ id: "Y", status: "pending", dependencies: [] }),
      makeTask({ id: "Z", status: "in_progress", dependencies: [] }),
    ]);
    const { code, stdout } = run(["query", "--ready"], { cwd: tmpDir });
    expect(code).toBe(0);
    const ids = (JSON.parse(stdout) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain("X");
    expect(ids).toContain("Y");
    expect(ids).not.toContain("Z");
  });
});

// ---------------------------------------------------------------------------
// describe("query filters")
// ---------------------------------------------------------------------------

describe("query filters", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
    mkdirSync(join(tmpDir, "state"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("no flags returns all tasks", () => {
    writeTodos(tmpDir, [
      makeTask({ id: "TS-1.1" }),
      makeTask({ id: "TS-1.2" }),
    ]);
    const { code, stdout } = run(["query"], { cwd: tmpDir });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as unknown[];
    expect(result).toHaveLength(2);
  });

  test("--status filters by exact status", () => {
    writeTodos(tmpDir, [
      makeTask({ id: "TS-1.1", status: "pending" }),
      makeTask({ id: "TS-1.2", status: "in_progress" }),
    ]);
    const { code, stdout } = run(["query", "--status", "pending"], {
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as Array<{ id: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("TS-1.1");
  });

  test("--id returns exactly one matching task", () => {
    writeTodos(tmpDir, [
      makeTask({ id: "TS-1.1" }),
      makeTask({ id: "TS-1.2" }),
    ]);
    const { code, stdout } = run(["query", "--id", "TS-1.2"], { cwd: tmpDir });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as Array<{ id: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("TS-1.2");
  });

  test("--session filters by session field", () => {
    writeTodos(tmpDir, [
      makeTask({ id: "TS-1.1", session: "alpha" }),
      makeTask({ id: "TS-1.2", session: "beta" }),
    ]);
    const { code, stdout } = run(["query", "--session", "alpha"], {
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as Array<{ id: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("TS-1.1");
  });

  test("--pr filters by PR number", () => {
    writeTodos(tmpDir, [
      makeTask({ id: "TS-1.1", status: "pr_open", pr: 42 }),
      makeTask({ id: "TS-1.2", status: "pending" }),
    ]);
    const { code, stdout } = run(["query", "--pr", "42"], { cwd: tmpDir });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as Array<{ id: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("TS-1.1");
  });

  test("--assignee filters tasks by assignee", () => {
    writeTodos(tmpDir, [
      makeTask({ id: "TS-1.1", status: "pending", assignee: "alice" }),
      makeTask({ id: "TS-1.2", status: "pending", assignee: "bob" }),
      makeTask({ id: "TS-1.3", status: "pending" }),
    ]);
    const { code, stdout } = run(["query", "--assignee", "alice"], {
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as Array<{ id: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("TS-1.1");
  });

  test("--assignee with --ready filters ready tasks by assignee", () => {
    writeTodos(tmpDir, [
      makeTask({ id: "TS-1.1", status: "pending", assignee: "alice" }),
      makeTask({ id: "TS-1.2", status: "pending", assignee: "bob" }),
    ]);
    const { code, stdout } = run(["query", "--ready", "--assignee", "alice"], {
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as Array<{ id: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("TS-1.1");
  });

  test("--assignee excludes tasks with no assignee field", () => {
    writeTodos(tmpDir, [
      makeTask({ id: "TS-1.1", status: "pending", assignee: "alice" }),
      makeTask({ id: "TS-1.2", status: "pending" }), // no assignee field
    ]);
    const { code, stdout } = run(["query", "--assignee", "alice"], {
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as Array<{ id: string }>;
    expect(result.map((t) => t.id)).not.toContain("TS-1.2");
    expect(result.map((t) => t.id)).toContain("TS-1.1");
  });

  test("--status with no matching tasks returns empty array", () => {
    writeTodos(tmpDir, [makeTask({ id: "TS-1.1", status: "pending" })]);
    const { code, stdout } = run(["query", "--status", "merged"], {
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as unknown[];
    expect(result).toHaveLength(0);
  });

  test("--id with no matching id returns empty array", () => {
    writeTodos(tmpDir, [makeTask({ id: "TS-1.1" })]);
    const { code, stdout } = run(["query", "--id", "DOES-NOT-EXIST"], {
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as unknown[];
    expect(result).toHaveLength(0);
  });

  test("output is valid JSON array", () => {
    writeTodos(tmpDir, [makeTask({ id: "TS-1.1" })]);
    const { code, stdout } = run(["query"], { cwd: tmpDir });
    expect(code).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe("append")
// ---------------------------------------------------------------------------

describe("append", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
    writeTodos(tmpDir, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("inserts new tasks and returns inserted count", () => {
    const tasks = [makeTask({ id: "TS-1.1" }), makeTask({ id: "TS-1.2" })];
    const file = writeJsonFile(tmpDir, "tasks.json", tasks);
    const { code, stdout, stderr } = run(["append", "--file", file], {
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { inserted: number; updated: number };
    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(readTodos(tmpDir)).toHaveLength(2);
    void stderr;
  });

  test("idempotent: re-running same file produces inserted=0, updated=N", () => {
    const tasks = [makeTask({ id: "TS-1.1" }), makeTask({ id: "TS-1.2" })];
    const file = writeJsonFile(tmpDir, "tasks.json", tasks);
    run(["append", "--file", file], { cwd: tmpDir });
    const { code, stdout } = run(["append", "--file", file], { cwd: tmpDir });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { inserted: number; updated: number };
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(2);
    expect(readTodos(tmpDir)).toHaveLength(2);
  });

  test("upserts an existing task (matched by id)", () => {
    writeTodos(tmpDir, [makeTask({ id: "TS-1.1", title: "Old title" })]);
    const file = writeJsonFile(tmpDir, "update.json", [
      makeTask({ id: "TS-1.1", title: "New title" }),
    ]);
    const { code, stdout } = run(["append", "--file", file], { cwd: tmpDir });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { inserted: number; updated: number };
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);
    const todos = readTodos(tmpDir) as Array<{ title: string }>;
    expect(todos[0].title).toBe("New title");
  });

  test("mixed insert and update", () => {
    writeTodos(tmpDir, [makeTask({ id: "TS-1.1", title: "Old" })]);
    const incoming = [
      makeTask({ id: "TS-1.1", title: "Updated" }),
      makeTask({ id: "TS-1.2" }),
    ];
    const file = writeJsonFile(tmpDir, "mixed.json", incoming);
    const { code, stdout } = run(["append", "--file", file], { cwd: tmpDir });
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { inserted: number; updated: number };
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(1);
    expect(readTodos(tmpDir)).toHaveLength(2);
  });

  test("missing --file flag exits non-zero with error message", () => {
    const { code, stderr } = run(["append"], { cwd: tmpDir });
    expect(code).not.toBe(0);
    expect(stderr).toContain("--file");
  });

  test("nonexistent file path exits non-zero", () => {
    const { code, stderr } = run(["append", "--file", "/no/such/file.json"], {
      cwd: tmpDir,
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("not found");
  });

  test("input file with JSON object (not array) exits non-zero", () => {
    const file = writeJsonFile(tmpDir, "bad.json", { id: "TS-1.1" });
    const { code, stderr } = run(["append", "--file", file], { cwd: tmpDir });
    expect(code).not.toBe(0);
    expect(stderr).toContain("array");
  });
});

// ---------------------------------------------------------------------------
// describe("update")
// ---------------------------------------------------------------------------

describe("update", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
    writeTodos(tmpDir, [
      makeTask({
        id: "TS-1.1",
        status: "pending",
        title: "Original",
        hours: 2,
      }),
    ]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("updates status field", () => {
    const { code, stdout } = run(
      ["update", "--id", "TS-1.1", "--set", "status=in_progress"],
      { cwd: tmpDir },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { status: string };
    expect(result.status).toBe("in_progress");
    const todos = readTodos(tmpDir) as Array<{ status: string }>;
    expect(todos[0].status).toBe("in_progress");
  });

  test("updates non-status field (title)", () => {
    const { code, stdout } = run(
      ["update", "--id", "TS-1.1", "--set", "title=New title"],
      { cwd: tmpDir },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { title: string };
    expect(result.title).toBe("New title");
    const todos = readTodos(tmpDir) as Array<{ title: string }>;
    expect(todos[0].title).toBe("New title");
  });

  test("updates multiple fields with multiple --set flags", () => {
    const { code, stdout } = run(
      [
        "update",
        "--id",
        "TS-1.1",
        "--set",
        "status=in_progress",
        "--set",
        "title=Changed",
      ],
      { cwd: tmpDir },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { status: string; title: string };
    expect(result.status).toBe("in_progress");
    expect(result.title).toBe("Changed");
  });

  test("coerces pr field to number", () => {
    const { code, stdout } = run(
      ["update", "--id", "TS-1.1", "--set", "pr=99"],
      { cwd: tmpDir },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { pr: unknown };
    expect(result.pr).toBe(99);
    expect(typeof result.pr).toBe("number");
  });

  test("coerces hours field to number", () => {
    const { code, stdout } = run(
      ["update", "--id", "TS-1.1", "--set", "hours=3.5"],
      { cwd: tmpDir },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { hours: unknown };
    expect(result.hours).toBe(3.5);
    expect(typeof result.hours).toBe("number");
  });

  test("status and other fields together — final state has both correct", () => {
    const { code, stdout } = run(
      [
        "update",
        "--id",
        "TS-1.1",
        "--set",
        "status=pr_open",
        "--set",
        "title=PR ready",
      ],
      { cwd: tmpDir },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { status: string; title: string };
    expect(result.status).toBe("pr_open");
    expect(result.title).toBe("PR ready");
  });

  test("nonexistent id exits non-zero", () => {
    const { code, stderr } = run(
      ["update", "--id", "TS-NOPE", "--set", "status=in_progress"],
      { cwd: tmpDir },
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("error");
  });

  test("does not modify other tasks", () => {
    writeTodos(tmpDir, [
      makeTask({ id: "TS-1.1", status: "pending" }),
      makeTask({ id: "TS-1.2", status: "pending", title: "Other" }),
    ]);
    run(["update", "--id", "TS-1.1", "--set", "status=in_progress"], {
      cwd: tmpDir,
    });
    const todos = readTodos(tmpDir) as Array<{ id: string; status: string }>;
    const other = todos.find((t) => t.id === "TS-1.2");
    expect(other?.status).toBe("pending");
  });

  test("missing --id flag exits non-zero", () => {
    const { code, stderr } = run(["update", "--set", "status=in_progress"], {
      cwd: tmpDir,
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("--id");
  });

  test("missing --set flag exits non-zero", () => {
    const { code, stderr } = run(["update", "--id", "TS-1.1"], { cwd: tmpDir });
    expect(code).not.toBe(0);
    expect(stderr).toContain("--set");
  });

  test("--set value missing = separator exits non-zero", () => {
    const { code, stderr } = run(
      ["update", "--id", "TS-1.1", "--set", "nostatus"],
      { cwd: tmpDir },
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("key=value");
  });
});

// ---------------------------------------------------------------------------
// describe("setup")
// ---------------------------------------------------------------------------

describe("setup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates state/todos.json with empty array when missing", () => {
    const { code } = run(["setup"], { cwd: tmpDir });
    expect(code).toBe(0);
    const todos = readTodos(tmpDir);
    expect(todos).toEqual([]);
  });

  test("no-op if todos.json already exists — does not overwrite", () => {
    writeTodos(tmpDir, [makeTask({ id: "TS-1.1" })]);
    const { code } = run(["setup"], { cwd: tmpDir });
    expect(code).toBe(0);
    const todos = readTodos(tmpDir) as Array<{ id: string }>;
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe("TS-1.1");
  });

  test("exits 0 on both runs (idempotent)", () => {
    const first = run(["setup"], { cwd: tmpDir });
    expect(first.code).toBe(0);
    const second = run(["setup"], { cwd: tmpDir });
    expect(second.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe("doctor")
// ---------------------------------------------------------------------------

describe("doctor", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
    writeTodos(tmpDir, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("prints 'backend: json' on stdout", () => {
    const { code, stdout } = run(["doctor"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: "" },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("backend: json");
  });

  test("prints 'config: default' when SHIPWRIGHT_CONFIG is empty", () => {
    const { code, stdout } = run(["doctor"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: "" },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("config: default");
  });

  test("prints config file path when SHIPWRIGHT_CONFIG points to a file", () => {
    const cfgPath = writeJsonFile(tmpDir, "shipwright.json", {
      taskStore: "json",
    });
    const { code, stdout } = run(["doctor"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: cfgPath },
    });
    expect(code).toBe(0);
    expect(stdout).toContain(cfgPath);
  });

  test("prints 'token scope' line", () => {
    const { code, stdout } = run(["doctor"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: "" },
    });
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toContain("token scope");
  });

  test("exits 0 when JSON backend with todos.json present", () => {
    const { code } = run(["doctor"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: "" },
    });
    expect(code).toBe(0);
  });

  test("prints [ok] when todos.json exists", () => {
    const { stdout } = run(["doctor"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: "" },
    });
    expect(stdout).toContain("[ok]");
  });

  test("prints [warn] when todos.json is missing", () => {
    // Remove the todos.json created in beforeEach
    rmSync(join(tmpDir, "state", "todos.json"));
    const { stdout, stderr } = run(["doctor"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: "" },
    });
    // [warn] comes via console.warn which goes to stderr in Bun
    expect(stdout + stderr).toContain("[warn]");
  });

  test("doctor reports github backend when .shipwright.json is present in cwd", () => {
    // Write .shipwright.json with github taskStore config in cwd
    const shipwrightJsonPath = join(tmpDir, ".shipwright.json");
    writeFileSync(
      shipwrightJsonPath,
      JSON.stringify({
        taskStore: "github",
        github: { owner: "example-org", repo: "example-repo" },
      }),
    );
    // Run doctor with cwd=tmpDir and no SHIPWRIGHT_CONFIG — auto-discovery should kick in
    const result = Bun.spawnSync(["bun", SCRIPT, "doctor"], {
      cwd: tmpDir,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== "SHIPWRIGHT_CONFIG"),
        ),
        // Inject a fake gh that fails fast so doctor doesn't hang on auth
        GH_CMD: "/no/such/gh-binary",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const combined =
      new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    // The doctor command should report the github backend from the discovered config
    expect(combined).toContain("backend: github");
    // configSource should be the discovered .shipwright.json path
    expect(combined).toContain(shipwrightJsonPath);
  });
});

// ---------------------------------------------------------------------------
// describe("no SHIPWRIGHT_CONFIG")
// ---------------------------------------------------------------------------

describe("no SHIPWRIGHT_CONFIG", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
    writeTodos(tmpDir, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("query runs without error when SHIPWRIGHT_CONFIG is not set", () => {
    // Strip SHIPWRIGHT_CONFIG from env entirely
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== "SHIPWRIGHT_CONFIG"),
    ) as Record<string, string>;
    const result = Bun.spawnSync(["bun", SCRIPT, "query"], {
      cwd: tmpDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const out = new TextDecoder().decode(result.stdout);
    expect(JSON.parse(out)).toEqual([]);
  });

  test("query runs without error when SHIPWRIGHT_CONFIG is empty string", () => {
    const { code, stdout } = run(["query"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: "" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// describe("resolve-repo") — deprecated alias, prints first repo from resolveRepos()
// ---------------------------------------------------------------------------

describe("resolve-repo", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
    writeTodos(tmpDir, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("prints first repo from repos/ dir", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "vitals-os",
      "https://github.com/app-vitals/vitals-os.git",
    );
    const { code, stdout } = run(["resolve-repo"], { cwd: tmpDir });
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toContain("app-vitals/vitals-os");
    expect(lines).toHaveLength(1);
  });

  test("falls back to SHIPWRIGHT_REPOS_DIR when repos/ is missing", () => {
    const envReposDir = join(tmpDir, "env-repos");
    mkdirSync(envReposDir, { recursive: true });
    makeGitClone(
      envReposDir,
      "vitals-os",
      "https://github.com/app-vitals/vitals-os.git",
    );
    const { code, stdout } = run(["resolve-repo"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_REPOS_DIR: envReposDir },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("app-vitals/vitals-os");
  });

  test("exits non-zero when no repos found", () => {
    const { code, stderr } = run(["resolve-repo"], { cwd: tmpDir });
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("error");
  });

  test("output has no trailing whitespace beyond newline", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "vitals-os",
      "https://github.com/app-vitals/vitals-os.git",
    );
    const { code, stdout } = run(["resolve-repo"], { cwd: tmpDir });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("app-vitals/vitals-os");
  });
});

// ---------------------------------------------------------------------------
// describe("repos") — prints all repos, one per line
// ---------------------------------------------------------------------------

describe("repos", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
    writeTodos(tmpDir, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("prints one org/repo per line from repos/ dir", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "vitals-os",
      "https://github.com/app-vitals/vitals-os.git",
    );
    makeGitClone(
      reposDir,
      "patrol",
      "https://github.com/example-org/example-repo.git",
    );
    const { code, stdout } = run(["repos"], { cwd: tmpDir });
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toContain("app-vitals/vitals-os");
    expect(lines).toContain("example-org/example-repo");
    expect(lines).toHaveLength(2);
  });

  test("prints repos from SHIPWRIGHT_REPOS_DIR when repos/ is missing", () => {
    const envReposDir = join(tmpDir, "env-repos");
    mkdirSync(envReposDir, { recursive: true });
    makeGitClone(
      envReposDir,
      "vitals-os",
      "git@github.com:app-vitals/vitals-os.git",
    );
    const { code, stdout } = run(["repos"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_REPOS_DIR: envReposDir },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("app-vitals/vitals-os");
  });

  test("exits 0 with empty output when no repos found", () => {
    const { code, stdout } = run(["repos"], { cwd: tmpDir });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("single repo prints one line with no extra whitespace", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "vitals-os",
      "https://github.com/app-vitals/vitals-os.git",
    );
    const { code, stdout } = run(["repos"], { cwd: tmpDir });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("app-vitals/vitals-os");
  });
});

// ---------------------------------------------------------------------------
// describe("error handling / edge cases")
// ---------------------------------------------------------------------------

describe("error handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("unknown subcommand exits non-zero with error message", () => {
    writeTodos(tmpDir, []);
    const { code, stderr } = run(["notacommand"], { cwd: tmpDir });
    expect(code).not.toBe(0);
    expect(stderr).toContain("notacommand");
  });

  test("no subcommand exits non-zero with usage message", () => {
    const { code, stderr } = run([], { cwd: tmpDir });
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("usage");
  });

  test("SHIPWRIGHT_CONFIG pointing to nonexistent file exits non-zero", () => {
    writeTodos(tmpDir, []);
    const { code, stderr } = run(["query"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: "/no/such/config.json" },
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("not found");
  });

  test("SHIPWRIGHT_CONFIG pointing to invalid JSON exits non-zero", () => {
    const badCfg = join(tmpDir, "bad.json");
    writeFileSync(badCfg, "{ not json !!!");
    writeTodos(tmpDir, []);
    const { code, stderr } = run(["query"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: badCfg },
    });
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("json");
  });

  test("SHIPWRIGHT_CONFIG pointing to github taskStore uses GitHubTaskStore (exits non-zero without gh CLI)", () => {
    const cfgPath = writeJsonFile(tmpDir, "gh.json", {
      taskStore: "github",
      github: { owner: "org", repo: "repo" },
    });
    writeTodos(tmpDir, []);
    // GH_CMD is not set; gh CLI is not available in test env — expect failure
    const { code, stderr } = run(["query"], {
      cwd: tmpDir,
      env: {
        SHIPWRIGHT_CONFIG: cfgPath,
        GH_CMD: "/no/such/gh-binary",
      },
    });
    expect(code).not.toBe(0);
    expect(stderr).toBeTruthy();
  });

  test("query when todos.json is missing exits non-zero", () => {
    // Don't call writeTodos — state/todos.json doesn't exist
    const { code, stderr } = run(["query"], { cwd: tmpDir });
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("setup");
  });

  test("append file containing invalid JSON exits non-zero", () => {
    writeTodos(tmpDir, []);
    const badFile = join(tmpDir, "invalid.json");
    writeFileSync(badFile, "not json at all");
    const { code, stderr } = run(["append", "--file", badFile], {
      cwd: tmpDir,
    });
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("json");
  });
});

// ---------------------------------------------------------------------------
// describe("cleanup")
// ---------------------------------------------------------------------------

describe("cleanup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
    writeTodos(tmpDir, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("JSON adapter cleanup exits zero and reports 0 closed when no terminal tasks have issue URLs", () => {
    writeTodos(tmpDir, [{ id: "T-1", title: "Pending", status: "pending" }]);
    const { code, stdout } = run(["cleanup"], { cwd: tmpDir });
    expect(code).toBe(0);
    expect(stdout).toContain("0");
  });

  test("GitHub adapter closes open issues with terminal status labels", () => {
    const cfgPath = writeJsonFile(tmpDir, "gh.json", {
      taskStore: "github",
      github: { owner: "org", repo: "repo" },
    });

    const issues = [
      {
        number: 1,
        title: "TSR-1.1: Merged open",
        body: "",
        labels: [{ name: "status:merged" }],
        state: "OPEN",
        url: "",
        milestone: null,
      },
      {
        number: 2,
        title: "TSR-1.2: Pending open",
        body: "",
        labels: [{ name: "status:pending" }],
        state: "OPEN",
        url: "",
        milestone: null,
      },
    ];

    const fakeGhPath = join(tmpDir, "fake-gh");
    writeFileSync(
      fakeGhPath,
      `#!/usr/bin/env bun
import { argv } from "process";
const args = argv.slice(2);
if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "close") {
  process.exit(0);
}
if (args[0] === "api") {
  console.log("[]");
  process.exit(0);
}
process.exit(0);
`,
    );
    Bun.spawnSync(["chmod", "755", fakeGhPath]);

    const { code, stdout } = run(["cleanup"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: cfgPath, GH_CMD: fakeGhPath },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Closed 1 stale open issue");
  });

  test("GitHub adapter prints zero closed when no stale open issues", () => {
    const cfgPath = writeJsonFile(tmpDir, "gh.json", {
      taskStore: "github",
      github: { owner: "org", repo: "repo" },
    });

    const issues = [
      {
        number: 3,
        title: "TSR-2.1: Pending open",
        body: "",
        labels: [{ name: "status:pending" }],
        state: "OPEN",
        url: "",
        milestone: null,
      },
      {
        number: 4,
        title: "TSR-2.2: In progress open",
        body: "",
        labels: [{ name: "status:in_progress" }],
        state: "OPEN",
        url: "",
        milestone: null,
      },
    ];

    const fakeGhPath = join(tmpDir, "fake-gh-zero");
    writeFileSync(
      fakeGhPath,
      `#!/usr/bin/env bun
import { argv } from "process";
const args = argv.slice(2);
if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}
if (args[0] === "api") {
  console.log("[]");
  process.exit(0);
}
process.exit(0);
`,
    );
    Bun.spawnSync(["chmod", "755", fakeGhPath]);

    const { code, stdout } = run(["cleanup"], {
      cwd: tmpDir,
      env: { SHIPWRIGHT_CONFIG: cfgPath, GH_CMD: fakeGhPath },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Closed 0 stale open issue");
  });
});

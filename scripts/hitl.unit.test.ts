/**
 * scripts/hitl.unit.test.ts
 * Unit tests for the pure logic in scripts/hitl.ts — command selection,
 * task-store response parsing, workspace-provisioning idempotency planning,
 * and the env built for the spawned Claude process. Everything with a real
 * I/O boundary (fs, fetch, Bun.spawn) is exercised through injected doubles
 * or by construction, never mocked globally.
 */

import { describe, expect, test } from "bun:test";
import {
  buildClaudeSpawnEnv,
  buildTaskCommand,
  computeProvisionPlan,
  parseTasksResponse,
  type Task,
} from "./hitl.ts";

describe("buildTaskCommand", () => {
  test("routes hitl tasks to /shipwright:hitl", () => {
    expect(buildTaskCommand({ id: "HTC-1.1", hitl: true })).toBe(
      "/shipwright:hitl HTC-1.1",
    );
  });

  test("routes non-hitl tasks to /shipwright:dev-task", () => {
    expect(buildTaskCommand({ id: "PV-1.2", hitl: false })).toBe(
      "/shipwright:dev-task PV-1.2",
    );
  });

  test("treats a missing hitl field as non-hitl", () => {
    expect(buildTaskCommand({ id: "PV-1.2" })).toBe(
      "/shipwright:dev-task PV-1.2",
    );
  });
});

describe("parseTasksResponse", () => {
  test("returns the tasks array when present", () => {
    const tasks: Task[] = [
      { id: "PV-1.2", title: "Do the thing", status: "pending" },
    ];
    expect(parseTasksResponse({ tasks })).toEqual(tasks);
  });

  test("returns [] when tasks is missing", () => {
    expect(parseTasksResponse({})).toEqual([]);
  });

  test("returns [] when tasks is not an array", () => {
    expect(parseTasksResponse({ tasks: "nope" })).toEqual([]);
  });

  test("returns [] for null", () => {
    expect(parseTasksResponse(null)).toEqual([]);
  });

  test("returns [] for a non-object", () => {
    expect(parseTasksResponse("not json")).toEqual([]);
  });
});

describe("computeProvisionPlan", () => {
  test("reports all dirs missing and CLAUDE.md needed on a fresh workspace", () => {
    const plan = computeProvisionPlan(
      ["/ws", "/ws/repos", "/ws/worktrees"],
      "/ws/CLAUDE.md",
      () => false,
    );
    expect(plan.missingDirs).toEqual(["/ws", "/ws/repos", "/ws/worktrees"]);
    expect(plan.needsClaudeMd).toBe(true);
  });

  test("reports nothing missing when everything already exists", () => {
    const plan = computeProvisionPlan(
      ["/ws", "/ws/repos"],
      "/ws/CLAUDE.md",
      () => true,
    );
    expect(plan.missingDirs).toEqual([]);
    expect(plan.needsClaudeMd).toBe(false);
  });

  test("reports only the dirs that don't yet exist", () => {
    const existing = new Set(["/ws"]);
    const plan = computeProvisionPlan(
      ["/ws", "/ws/repos", "/ws/worktrees"],
      "/ws/CLAUDE.md",
      (path) => existing.has(path),
    );
    expect(plan.missingDirs).toEqual(["/ws/repos", "/ws/worktrees"]);
    expect(plan.needsClaudeMd).toBe(true);
  });

  test("CLAUDE.md need is independent of dir existence", () => {
    const plan = computeProvisionPlan(["/ws"], "/ws/CLAUDE.md", (path) =>
      path === "/ws",
    );
    expect(plan.missingDirs).toEqual([]);
    expect(plan.needsClaudeMd).toBe(true);
  });
});

describe("buildClaudeSpawnEnv", () => {
  test("overlays task-store and workspace dir vars onto the base env", () => {
    const base = { PATH: "/usr/bin", SOME_OTHER_VAR: "keep-me" };
    const env = buildClaudeSpawnEnv(base);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.SOME_OTHER_VAR).toBe("keep-me");
    expect(env.SHIPWRIGHT_TASK_STORE_URL).toMatch(/^http:\/\//);
    expect(typeof env.SHIPWRIGHT_TASK_STORE_TOKEN).toBe("string");
    expect(typeof env.SHIPWRIGHT_REPO_DIR).toBe("string");
    expect(typeof env.SHIPWRIGHT_WORKTREE_DIR).toBe("string");
  });

  test("does not mutate the base env object", () => {
    const base = { PATH: "/usr/bin" };
    buildClaudeSpawnEnv(base);
    expect(Object.keys(base)).toEqual(["PATH"]);
  });
});

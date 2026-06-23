import { describe, expect, test } from "bun:test";
import type { Task } from "../store";
import {
  checkCrossRepoOrphans,
  checkDanglingDeps,
  checkDuplicateIds,
} from "./audit";

describe("checkDuplicateIds", () => {
  test("returns ok when no duplicate IDs", () => {
    const tasks: Task[] = [
      { id: "T-1", title: "Task 1", status: "pending" },
      { id: "T-2", title: "Task 2", status: "pending" },
      { id: "T-3", title: "Task 3", status: "pending" },
    ];
    const result = checkDuplicateIds(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
    expect(result[0].check).toBe("duplicate-ids");
    expect(result[0].message).toContain("No duplicate IDs");
  });

  test("returns fail for each duplicated ID", () => {
    const tasks: Task[] = [
      { id: "T-1", title: "Task 1", status: "pending" },
      { id: "T-1", title: "Task 1 duplicate", status: "pending" },
      { id: "T-2", title: "Task 2", status: "pending" },
      { id: "T-2", title: "Task 2 duplicate", status: "pending" },
    ];
    const result = checkDuplicateIds(tasks);
    const failures = result.filter((r) => r.level === "fail");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.message.includes("T-1"))).toBe(true);
    expect(failures.some((f) => f.message.includes("T-2"))).toBe(true);
  });

  test("returns fail with duplicate count in message", () => {
    const tasks: Task[] = [
      { id: "T-1", title: "Task 1", status: "pending" },
      { id: "T-1", title: "Task 1 copy 1", status: "pending" },
      { id: "T-1", title: "Task 1 copy 2", status: "pending" },
    ];
    const result = checkDuplicateIds(tasks);
    const failure = result.find(
      (r) => r.level === "fail" && r.message.includes("T-1"),
    );
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("3");
  });

  test("returns ok for empty task list", () => {
    const tasks: Task[] = [];
    const result = checkDuplicateIds(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
  });

  test("returns fail with check='duplicate-ids'", () => {
    const tasks: Task[] = [
      { id: "T-1", title: "Task 1", status: "pending" },
      { id: "T-1", title: "Task 1 duplicate", status: "pending" },
    ];
    const result = checkDuplicateIds(tasks);
    const failures = result.filter((r) => r.level === "fail");
    expect(failures.every((f) => f.check === "duplicate-ids")).toBe(true);
  });
});

describe("checkDanglingDeps", () => {
  test("returns ok when all dependencies are known", () => {
    const tasks: Task[] = [
      { id: "T-1", title: "Task 1", status: "pending", dependencies: ["T-2"] },
      { id: "T-2", title: "Task 2", status: "pending" },
    ];
    const allKnownIds = new Set(["T-1", "T-2"]);
    const result = checkDanglingDeps(tasks, allKnownIds);
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
    expect(result[0].check).toBe("dangling-deps");
    expect(result[0].message).toContain("No dangling dependencies");
  });

  test("returns fail when a dependency ID is unknown", () => {
    const tasks: Task[] = [
      {
        id: "T-1",
        title: "Task 1",
        status: "pending",
        dependencies: ["UNKNOWN-DEP"],
      },
    ];
    const allKnownIds = new Set(["T-1"]);
    const result = checkDanglingDeps(tasks, allKnownIds);
    const failures = result.filter((r) => r.level === "fail");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].message).toContain("UNKNOWN-DEP");
  });

  test("returns one fail per dangling dependency", () => {
    const tasks: Task[] = [
      {
        id: "T-1",
        title: "Task 1",
        status: "pending",
        dependencies: ["UNKNOWN-1", "UNKNOWN-2"],
      },
    ];
    const allKnownIds = new Set(["T-1"]);
    const result = checkDanglingDeps(tasks, allKnownIds);
    const failures = result.filter((r) => r.level === "fail");
    expect(failures).toHaveLength(2);
    const messages = failures.map((f) => f.message);
    expect(messages.some((m) => m.includes("UNKNOWN-1"))).toBe(true);
    expect(messages.some((m) => m.includes("UNKNOWN-2"))).toBe(true);
  });

  test("returns fail for multiple tasks with dangling deps", () => {
    const tasks: Task[] = [
      {
        id: "T-1",
        title: "Task 1",
        status: "pending",
        dependencies: ["UNKNOWN-1"],
      },
      {
        id: "T-2",
        title: "Task 2",
        status: "pending",
        dependencies: ["UNKNOWN-2"],
      },
    ];
    const allKnownIds = new Set(["T-1", "T-2"]);
    const result = checkDanglingDeps(tasks, allKnownIds);
    const failures = result.filter((r) => r.level === "fail");
    expect(failures.length).toBe(2);
  });

  test("ignores tasks with no dependencies", () => {
    const tasks: Task[] = [
      { id: "T-1", title: "Task 1", status: "pending" },
      { id: "T-2", title: "Task 2", status: "pending", dependencies: [] },
    ];
    const allKnownIds = new Set(["T-1", "T-2"]);
    const result = checkDanglingDeps(tasks, allKnownIds);
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
  });

  test("returns fail with check='dangling-deps'", () => {
    const tasks: Task[] = [
      {
        id: "T-1",
        title: "Task 1",
        status: "pending",
        dependencies: ["UNKNOWN"],
      },
    ];
    const allKnownIds = new Set(["T-1"]);
    const result = checkDanglingDeps(tasks, allKnownIds);
    const failures = result.filter((r) => r.level === "fail");
    expect(failures.every((f) => f.check === "dangling-deps")).toBe(true);
  });

  test("returns ok for empty task list", () => {
    const result = checkDanglingDeps([], new Set());
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
  });

  test("returns ok when no tasks have dangling deps", () => {
    const tasks: Task[] = [
      {
        id: "T-1",
        title: "Task 1",
        status: "pending",
        dependencies: ["T-2", "T-3"],
      },
      { id: "T-2", title: "Task 2", status: "pending" },
      { id: "T-3", title: "Task 3", status: "pending" },
    ];
    const allKnownIds = new Set(["T-1", "T-2", "T-3"]);
    const result = checkDanglingDeps(tasks, allKnownIds);
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
  });
});

describe("checkCrossRepoOrphans", () => {
  test("returns ok when all tasks match configured repo", () => {
    const tasks: Task[] = [
      { id: "T-1", title: "Task 1", status: "pending", repo: "acme/repo" },
      { id: "T-2", title: "Task 2", status: "pending", repo: "acme/repo" },
    ];
    const result = checkCrossRepoOrphans(tasks, "acme/repo");
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
    expect(result[0].check).toBe("cross-repo-orphans");
    expect(result[0].message).toContain("No cross-repo orphans");
  });

  test("returns warn for each task with mismatched repo", () => {
    const tasks: Task[] = [
      { id: "T-1", title: "Task 1", status: "pending", repo: "acme/repo" },
      {
        id: "T-2",
        title: "Task 2",
        status: "pending",
        repo: "other/repo",
      },
      {
        id: "T-3",
        title: "Task 3",
        status: "pending",
        repo: "another/repo",
      },
    ];
    const result = checkCrossRepoOrphans(tasks, "acme/repo");
    const warnings = result.filter((r) => r.level === "warn");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.message.includes("T-2"))).toBe(true);
    expect(warnings.some((w) => w.message.includes("T-3"))).toBe(true);
  });

  test("skips tasks without repo field", () => {
    const tasks: Task[] = [
      { id: "T-1", title: "Task 1", status: "pending", repo: "acme/repo" },
      { id: "T-2", title: "Task 2", status: "pending" },
    ];
    const result = checkCrossRepoOrphans(tasks, "acme/repo");
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
  });

  test("returns warn with task ID in message", () => {
    const tasks: Task[] = [
      {
        id: "T-1",
        title: "Task 1",
        status: "pending",
        repo: "other/repo",
      },
    ];
    const result = checkCrossRepoOrphans(tasks, "acme/repo");
    const warnings = result.filter((r) => r.level === "warn");
    expect(warnings[0].message).toContain("T-1");
  });

  test("returns warn with check='cross-repo-orphans'", () => {
    const tasks: Task[] = [
      {
        id: "T-1",
        title: "Task 1",
        status: "pending",
        repo: "other/repo",
      },
    ];
    const result = checkCrossRepoOrphans(tasks, "acme/repo");
    const warnings = result.filter((r) => r.level === "warn");
    expect(warnings.every((w) => w.check === "cross-repo-orphans")).toBe(true);
  });

  test("returns ok for empty task list", () => {
    const result = checkCrossRepoOrphans([], "acme/repo");
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
  });

  test("returns ok when no mismatches", () => {
    const tasks: Task[] = [
      { id: "T-1", title: "Task 1", status: "pending", repo: "acme/repo" },
      { id: "T-2", title: "Task 2", status: "pending", repo: "acme/repo" },
      { id: "T-3", title: "Task 3", status: "pending" },
    ];
    const result = checkCrossRepoOrphans(tasks, "acme/repo");
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("ok");
  });

  test("handles case sensitivity in repo names", () => {
    const tasks: Task[] = [
      {
        id: "T-1",
        title: "Task 1",
        status: "pending",
        repo: "ACME/Repo",
      },
    ];
    const result = checkCrossRepoOrphans(tasks, "acme/repo");
    const warnings = result.filter((r) => r.level === "warn");
    expect(warnings.length).toBeGreaterThan(0);
  });
});

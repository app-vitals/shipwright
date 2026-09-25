// Unit tests for run-with-budget.ts — spawns real short-lived processes
// (no mocking: this script's whole job is orchestrating real subprocesses,
// so the tests exercise the real setsid/timeout/kill toolchain directly).
//
// Covers the enforced, process-group-aware timeout wrapper duplicated as
// inline bash across plugins/shipwright/commands/dev-task.md's Step 8 and
// patch.md's Steps 4b/5b/6c, plus the live correctness bug that duplication
// had (bare `setsid` without `--wait` reports a false EXIT=0 for a command
// that is still running) — see run-with-budget.ts's top comment for the
// full explanation.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithBudget } from "./run-with-budget";

function isPidAlive(pid: number): boolean {
  // Signal 0 would report "alive" for a zombie (a process that has already
  // been killed but not yet reaped by its parent) — not good enough here,
  // since a killed-but-unreaped grandchild is exactly what a successful
  // process-group kill produces. Read /proc's state field instead: "Z"
  // means already terminated, just pending reap.
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const stateLine = status.split("\n").find((line) => line.startsWith("State:"));
    return !!stateLine && !/State:\s*Z/.test(stateLine);
  } catch {
    return false;
  }
}

describe("runWithBudget", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pass — a fast command that exits 0 within budget", async () => {
    const result = await runWithBudget(["true"], {
      budgetSeconds: 5,
      killAfterSeconds: 2,
    });

    expect(result.status).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fail — a command that exits non-zero", async () => {
    const result = await runWithBudget(["sh", "-c", "exit 3"], {
      budgetSeconds: 5,
      killAfterSeconds: 2,
    });

    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(3);
  });

  it("timeout — a command that runs longer than the budget", async () => {
    const result = await runWithBudget(["sleep", "5"], {
      budgetSeconds: 1,
      killAfterSeconds: 1,
    });

    expect(result.status).toBe("timeout");
    expect(result.exitCode).toBe(124);
  }, 10_000);

  it("process-group-kill-on-timeout — a backgrounded grandchild is also killed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-with-budget-test-"));
    tempDirs.push(dir);
    const pidFile = join(dir, "child.pid");

    // The shell backgrounds `sleep 10`, records its PID, then waits on it.
    // `timeout` only signals the shell it directly execs (sh) — the
    // backgrounded `sleep` grandchild survives the shell's own SIGTERM
    // death unless the whole process group is killed as a backstop.
    const result = await runWithBudget(
      ["sh", "-c", `sleep 10 & echo $! > ${pidFile}; wait`],
      { budgetSeconds: 1, killAfterSeconds: 1 },
    );

    expect(result.status).toBe("timeout");
    expect(existsSync(pidFile)).toBe(true);
    const childPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    expect(Number.isNaN(childPid)).toBe(false);

    // Give the OS a brief moment to finish reaping after our kill calls.
    await Bun.sleep(200);

    expect(isPidAlive(childPid)).toBe(false);
  }, 10_000);
});

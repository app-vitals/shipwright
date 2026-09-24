/**
 * Integration tests for agent/src/process-tree-kill.ts
 *
 * Real dependency under test: the Linux kernel's procfs
 * (/proc/<pid>/task/<tid>/children) and real signal delivery. These spawn
 * genuine short-lived subprocesses that fork their own children — the exact
 * shape the timeout path has to clean up (a `claude` CLI that spawned an
 * install/build). No DB, no network, no mock.module().
 *
 * Linux-only: procfs's `children` file has no portable equivalent, and the
 * agent only ever runs on Linux (agent/Dockerfile). The suite self-skips
 * elsewhere rather than failing.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const { collectDescendantPids, killTree } = await import(
  "./process-tree-kill.ts"
);

const onLinux = process.platform === "linux" && existsSync("/proc/self/task");

/**
 * True unless the pid is gone OR is an unreaped zombie. A SIGKILLed process
 * whose parent died too lingers as a zombie until init reaps it — `kill(pid,
 * 0)` still succeeds for a zombie, so it alone would be a false "alive".
 */
function isAlive(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  // "<pid> (comm) <state> ..." — comm can contain spaces/parens, so slice
  // from the LAST ')' to find the state field.
  const state = stat.slice(
    stat.lastIndexOf(")") + 2,
    stat.lastIndexOf(")") + 3,
  );
  return state !== "Z";
}

async function waitUntilDead(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(10);
  }
  return !isAlive(pid);
}

/**
 * Spawns `sh` which forks a long-lived grandchild and prints its pid, then
 * waits. Returns the direct child proc plus the grandchild's pid.
 */
async function spawnWithGrandchild(): Promise<{
  proc: Bun.Subprocess;
  grandchildPid: number;
}> {
  const proc = Bun.spawn(["sh", "-c", 'sleep 300 & echo "$!"; wait'], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const deadline = Date.now() + 5000;
  let buffered = "";
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  try {
    while (!buffered.includes("\n") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buffered += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const grandchildPid = Number.parseInt(buffered.trim(), 10);
  return { proc, grandchildPid };
}

describe.if(onLinux)("collectDescendantPids (real processes)", () => {
  test("finds a grandchild the direct child forked", async () => {
    const { proc, grandchildPid } = await spawnWithGrandchild();
    try {
      expect(Number.isInteger(grandchildPid)).toBe(true);
      const descendants = collectDescendantPids(proc.pid);
      expect(descendants).toContain(grandchildPid);
    } finally {
      killTree(proc);
      await waitUntilDead(grandchildPid);
    }
  });
});

describe.if(onLinux)("killTree (real processes, procfs fallback)", () => {
  test("terminates the direct child AND its forked descendant", async () => {
    const { proc, grandchildPid } = await spawnWithGrandchild();
    expect(isAlive(grandchildPid)).toBe(true);

    killTree(proc);

    await proc.exited;
    expect(await waitUntilDead(proc.pid)).toBe(true);
    expect(await waitUntilDead(grandchildPid)).toBe(true);
  });

  test("a plain proc.kill() leaves the descendant alive — the regression this guards", async () => {
    // Pins the *reason* killTree exists: signalling only the direct child is
    // demonstrably insufficient. If this ever starts failing, the kernel/shell
    // stopped reparenting orphans and killTree's whole premise changed.
    const { proc, grandchildPid } = await spawnWithGrandchild();
    try {
      proc.kill();
      await proc.exited;
      await Bun.sleep(50);
      expect(isAlive(grandchildPid)).toBe(true);
    } finally {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  test("is a no-op that does not throw when the process already exited", async () => {
    const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    expect(() => killTree(proc)).not.toThrow();
  });
});

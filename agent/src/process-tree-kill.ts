/**
 * Process-tree termination for the spawned `claude` CLI.
 *
 * Why this exists: `Subprocess.kill()` signals exactly one process — the
 * direct child. A Claude Code session routinely forks its own children
 * (installs, builds, test runs, dev servers). When the agent's timeout /
 * abort path signalled only the CLI, those grandchildren were reparented to
 * init and kept running — burning CPU, holding ports and lockfiles, and
 * occasionally outliving the agent process itself.
 *
 * Two strategies, chosen at runtime:
 *
 *  1. **cgroup v2 (preferred).** Each invocation gets its own cgroup
 *     directory; `Bun.spawn`'s `cgroup` option puts the CLI inside it before
 *     its first instruction, so everything it forks is a member too. Writing
 *     `1` to the cgroup's `cgroup.kill` then SIGKILLs the entire membership
 *     atomically, with no PID-reuse or reparenting races.
 *
 *  2. **procfs walk (fallback).** Container runtimes commonly mount
 *     /sys/fs/cgroup read-only with no delegation — that is the case in this
 *     project's own agent image (`oven/bun:1-slim` under a Kubernetes
 *     securityContext with no privileged/cgroup-namespace grant: `mount`
 *     reports `cgroup2 (ro,…)` and `mkdir` under it fails with EROFS). So
 *     cgroup mode can never be assumed. When it is unavailable we snapshot
 *     the descendant pids from `/proc/<pid>/task/<tid>/children` *before*
 *     signalling the root (once the root dies, those parent→child links are
 *     gone) and SIGKILL them individually. Known limitation, accepted: a
 *     process that deliberately double-forks to detach *before* the kill has
 *     already been reparented to init, so it no longer appears anywhere in
 *     the tree and survives. Only cgroup membership catches that case; the
 *     CLI's own children (installs, builds, test runs) do not double-fork.
 *
 * The choice is made by probing at runtime and caching the answer, rather
 * than by a deploy-time flag — a container that does delegate cgroups gets
 * the stronger guarantee for free, and one that doesn't degrades silently to
 * the fallback. `agent/scripts/verify-cgroup-delegation.ts` prints the
 * resolved mode from inside the real built image on every CI build.
 *
 * Every entry point here is best-effort and never throws: a failure to clean
 * up a child process must not take down the agent process that was trying to
 * clean it up.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Where the cgroup v2 unified hierarchy is mounted on Linux. */
export const CGROUP_MOUNT_ROOT = "/sys/fs/cgroup";

export interface CgroupSupport {
  usable: boolean;
  /** The delegated directory new run-cgroups are created under. */
  base?: string;
  /** Human-readable explanation, surfaced by the CI verify script. */
  reason: string;
}

export interface KillableProcess {
  readonly pid?: number;
  kill: (signal?: number | NodeJS.Signals) => void;
}

/**
 * The cgroup directory this process itself lives in, per the unified
 * hierarchy line of /proc/self/cgroup (`0::<path>`). Run-cgroups are created
 * as CHILDREN of it rather than at the mount root: that is the shape cgroup
 * delegation actually grants (a container is handed its own subtree, not the
 * whole hierarchy), so it's the only location that can work unprivileged.
 */
export function resolveCgroupBase(
  mountRoot: string = CGROUP_MOUNT_ROOT,
  procSelfCgroupPath = "/proc/self/cgroup",
): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(procSelfCgroupPath, "utf8");
  } catch {
    return undefined;
  }
  const line = raw.split("\n").find((l) => l.startsWith("0::"));
  // No `0::` line means a cgroup v1-only host — there is no cgroup.kill
  // interface there, so the procfs fallback is the only option.
  if (!line) return undefined;
  const rel = line.slice(3).trim();
  return rel === "" || rel === "/" ? mountRoot : join(mountRoot, rel);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Probe, for real, whether we can create child cgroups. Creates a throwaway
 * directory and removes it again — the only way to tell a delegated subtree
 * from a read-only mount without guessing at securityContext.
 */
export function probeCgroupDelegation(base?: string): CgroupSupport {
  if (process.platform !== "linux") {
    return { usable: false, reason: `not linux (${process.platform})` };
  }
  const resolved = base ?? resolveCgroupBase();
  if (!resolved) {
    return {
      usable: false,
      reason: "no cgroup v2 unified hierarchy in /proc/self/cgroup",
    };
  }
  // A directory without cgroup.procs isn't a cgroup at all (e.g. the mount is
  // missing entirely, or points at a plain directory) — creating run dirs
  // there would silently do nothing useful.
  if (!existsSync(join(resolved, "cgroup.procs"))) {
    return {
      usable: false,
      reason: `${resolved} is not a cgroup v2 directory (no cgroup.procs)`,
    };
  }
  const probeDir = join(
    resolved,
    `shipwright-probe-${process.pid}-${Date.now()}`,
  );
  try {
    mkdirSync(probeDir);
  } catch (err) {
    return {
      usable: false,
      reason: `cgroup delegation not writable at ${resolved}: ${describe(err)}`,
    };
  }
  try {
    rmdirSync(probeDir);
  } catch {
    // Leaving the probe dir behind is harmless; delegation clearly works.
  }
  return {
    usable: true,
    base: resolved,
    reason: `cgroup v2 delegation writable at ${resolved}`,
  };
}

let cachedSupport: CgroupSupport | undefined;
let runCounter = 0;

/** Probe once per process, then reuse the answer. */
export function cgroupSupport(base?: string): CgroupSupport {
  cachedSupport ??= probeCgroupDelegation(base);
  return cachedSupport;
}

/** Test seam, and the reset used after a transient probe failure. */
export function resetCgroupSupportCache(): void {
  cachedSupport = undefined;
}

/**
 * Latch cgroup mode off for the rest of this process. Called when creating or
 * joining a cgroup fails at runtime (delegation revoked, hierarchy moved), so
 * later invocations go straight to the procfs fallback instead of retrying a
 * syscall we already know fails.
 */
export function markCgroupUnavailable(reason: string): void {
  cachedSupport = { usable: false, reason };
}

/**
 * Create a dedicated cgroup for one invocation, or return undefined if this
 * container doesn't delegate cgroups (the common case) — in which case the
 * caller spawns normally and `killTree` uses the procfs fallback.
 */
export function createRunCgroup(base?: string): string | undefined {
  const support = cgroupSupport(base);
  if (!support.usable || !support.base) return undefined;
  runCounter += 1;
  const dir = join(
    support.base,
    `shipwright-run-${process.pid}-${runCounter}-${Date.now()}`,
  );
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    markCgroupUnavailable(
      `run cgroup creation failed under ${support.base}: ${describe(err)}`,
    );
    return undefined;
  }
}

/**
 * SIGKILL every process in the cgroup, atomically. Returns false (never
 * throws) when the write fails — the cgroup was already removed, the kernel
 * is too old for cgroup.kill (< 5.14), or delegation went away — so callers
 * can fall through to the per-process path.
 */
export function killCgroup(path: string): boolean {
  try {
    writeFileSync(join(path, "cgroup.kill"), "1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort cleanup of a run cgroup once its process has exited. rmdir
 * fails with EBUSY while members remain, so a failure is retried once after
 * killing whatever is still inside — that leftover membership IS the process
 * leak this module exists to prevent.
 */
export function removeRunCgroup(path: string): void {
  try {
    rmdirSync(path);
    return;
  } catch {
    // Fall through to the kill-then-retry below.
  }
  killCgroup(path);
  try {
    rmdirSync(path);
  } catch {
    // Give up silently: an orphan cgroup directory is inert, and throwing
    // from a cleanup path would surface as an unhandled rejection.
  }
}

function readChildPids(pid: number, procRoot: string): number[] {
  // Children are tracked per-THREAD, not per-process: a multi-threaded parent
  // records each fork under the thread that made it, so every tid under
  // /proc/<pid>/task must be read, not just the main one.
  const taskDir = join(procRoot, String(pid), "task");
  let tids: string[];
  try {
    tids = readdirSync(taskDir);
  } catch {
    return [];
  }
  const children: number[] = [];
  for (const tid of tids) {
    let raw: string;
    try {
      raw = readFileSync(join(taskDir, tid, "children"), "utf8");
    } catch {
      continue; // thread exited mid-walk
    }
    for (const token of raw.split(/\s+/)) {
      const parsed = Number.parseInt(token, 10);
      if (Number.isInteger(parsed) && parsed > 0) children.push(parsed);
    }
  }
  return children;
}

/**
 * Every transitive descendant of `pid`, breadth-first. A `seen` set guards
 * against the (pathological, but cheap to rule out) case of a cycle from a
 * recycled pid appearing in its own ancestor's children list.
 */
export function collectDescendantPids(
  pid: number,
  procRoot = "/proc",
): number[] {
  const descendants: number[] = [];
  const seen = new Set<number>([pid]);
  const queue: number[] = [pid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of readChildPids(current, procRoot)) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

/**
 * Terminate a spawned process and everything it spawned.
 *
 * Replaces a bare `proc.kill()` at every timeout/abort call site. Never
 * throws: a process that already exited, a vanished cgroup, and a
 * non-Linux/procfs-less host are all normal outcomes here.
 */
export function killTree(proc: KillableProcess, cgroupPath?: string): void {
  try {
    // cgroup.kill covers the CLI itself as well as its descendants, so an
    // additional signal to the direct child would be redundant.
    if (cgroupPath && killCgroup(cgroupPath)) return;

    const pid =
      typeof proc.pid === "number" && proc.pid > 0 ? proc.pid : undefined;
    // Snapshot BEFORE signalling the root: the moment it exits, /proc/<pid>
    // disappears and its children are reparented to init, erasing the only
    // link back to them.
    const descendants = pid ? collectDescendantPids(pid) : [];

    try {
      // Root gets the caller's default signal (SIGTERM) so the CLI can still
      // flush and exit 143, preserving the existing timeout/abort semantics.
      proc.kill();
    } catch {
      // Already exited — the descendants below are what matter now.
    }

    for (const descendant of descendants) {
      try {
        // SIGKILL, not SIGTERM: these are arbitrary orphaned build/install
        // processes with no cleanup contract worth waiting on.
        process.kill(descendant, "SIGKILL");
      } catch {
        // Already gone, or not ours to signal.
      }
    }
  } catch {
    // Defense in depth: nothing in a kill path may escape as an unhandled
    // rejection and take down the agent.
  }
}

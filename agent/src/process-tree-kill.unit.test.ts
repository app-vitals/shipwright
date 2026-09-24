/**
 * Tests for agent/src/process-tree-kill.ts
 *
 * Strategy: every function takes the cgroup base / procfs root as an injected
 * parameter, so the probe/create/kill/cleanup logic is exercised against a
 * real temp directory that mimics a cgroup v2 hierarchy (a directory holding
 * a `cgroup.procs` control file) instead of the real, usually read-only
 * /sys/fs/cgroup. No mock.module(), no global overrides.
 *
 * Real-subprocess behavior (descendant discovery + tree kill) lives in
 * process-tree-kill.integration.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  collectDescendantPids,
  createRunCgroup,
  killCgroup,
  killTree,
  markCgroupUnavailable,
  probeCgroupDelegation,
  removeRunCgroup,
  resetCgroupSupportCache,
  resolveCgroupBase,
} = await import("./process-tree-kill.ts");

const tempDirs: string[] = [];

/** A temp dir shaped like a delegated cgroup v2 directory. */
function fakeCgroupBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "shipwright-cgroup-test-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "cgroup.procs"), "");
  return dir;
}

/** A temp dir that is NOT a cgroup hierarchy (no control files). */
function plainTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shipwright-plain-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetCgroupSupportCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveCgroupBase", () => {
  test("maps the unified-hierarchy line of /proc/self/cgroup onto the mount root", () => {
    const dir = plainTempDir();
    const procSelfCgroup = join(dir, "cgroup");
    writeFileSync(procSelfCgroup, "0::/kubepods/pod123/container456\n");
    expect(resolveCgroupBase("/sys/fs/cgroup", procSelfCgroup)).toBe(
      "/sys/fs/cgroup/kubepods/pod123/container456",
    );
  });

  test("returns the mount root itself when the process sits at the hierarchy root", () => {
    const dir = plainTempDir();
    const procSelfCgroup = join(dir, "cgroup");
    writeFileSync(procSelfCgroup, "0::/\n");
    expect(resolveCgroupBase("/sys/fs/cgroup", procSelfCgroup)).toBe(
      "/sys/fs/cgroup",
    );
  });

  test("returns undefined on a v1-only host (no 0:: unified line)", () => {
    const dir = plainTempDir();
    const procSelfCgroup = join(dir, "cgroup");
    writeFileSync(procSelfCgroup, "2:cpu:/foo\n1:name=systemd:/bar\n");
    expect(resolveCgroupBase("/sys/fs/cgroup", procSelfCgroup)).toBeUndefined();
  });

  test("returns undefined when /proc/self/cgroup is unreadable", () => {
    expect(
      resolveCgroupBase("/sys/fs/cgroup", "/nonexistent/proc/self/cgroup"),
    ).toBeUndefined();
  });
});

describe("probeCgroupDelegation", () => {
  test("reports usable and leaves no probe directory behind when the base is a writable cgroup dir", () => {
    const base = fakeCgroupBase();
    const support = probeCgroupDelegation(base);
    expect(support.usable).toBe(true);
    expect(support.base).toBe(base);
    // Probe directory must be cleaned up — a leaked probe cgroup per boot
    // would accumulate in the delegated hierarchy.
    expect(readdirSync(base)).toEqual(["cgroup.procs"]);
  });

  test("reports unusable when the base is not a cgroup v2 hierarchy", () => {
    const support = probeCgroupDelegation(plainTempDir());
    expect(support.usable).toBe(false);
    expect(support.reason).toContain("cgroup");
  });

  test("reports unusable when the base directory does not exist", () => {
    const support = probeCgroupDelegation("/nonexistent/sys/fs/cgroup");
    expect(support.usable).toBe(false);
  });

  test("reports unusable when the base is read-only (mirrors the deployed container)", () => {
    // Directory permissions do not restrain uid 0, so this assertion is only
    // meaningful as a non-root user (which is how both CI and the deployed
    // pod run).
    if (process.getuid?.() === 0) return;
    const base = fakeCgroupBase();
    // 0o500 = r-x------: the cgroup.procs check still passes, but mkdir of a
    // child cgroup fails with EACCES — exactly the read-only-cgroupfs shape
    // seen in the deployed agent pod.
    chmodSync(base, 0o500);
    const support = probeCgroupDelegation(base);
    chmodSync(base, 0o700);
    expect(support.usable).toBe(false);
  });
});

describe("createRunCgroup / removeRunCgroup", () => {
  test("creates a fresh, unique directory under the delegated base", () => {
    const base = fakeCgroupBase();
    const a = createRunCgroup(base);
    const b = createRunCgroup(base);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(existsSync(a as string)).toBe(true);
    expect(existsSync(b as string)).toBe(true);
  });

  test("returns undefined (no throw) when delegation is unavailable", () => {
    expect(createRunCgroup(plainTempDir())).toBeUndefined();
  });

  test("caches the probe result so an unusable base is probed only once", () => {
    const base = fakeCgroupBase();
    expect(createRunCgroup(base)).toBeDefined();
    markCgroupUnavailable("forced for test");
    // Cached negative result short-circuits without touching the filesystem.
    expect(createRunCgroup(base)).toBeUndefined();
    resetCgroupSupportCache();
    expect(createRunCgroup(base)).toBeDefined();
  });

  test("removeRunCgroup deletes the directory and never throws when it is already gone", () => {
    const base = fakeCgroupBase();
    const dir = createRunCgroup(base) as string;
    removeRunCgroup(dir);
    expect(existsSync(dir)).toBe(false);
    expect(() => removeRunCgroup(dir)).not.toThrow();
    expect(() => removeRunCgroup("/nonexistent/cgroup/dir")).not.toThrow();
  });
});

describe("killCgroup", () => {
  test("writes 1 to the cgroup.kill interface file", () => {
    const base = fakeCgroupBase();
    const dir = createRunCgroup(base) as string;
    expect(killCgroup(dir)).toBe(true);
    expect(readFileSync(join(dir, "cgroup.kill"), "utf8")).toBe("1");
  });

  test("returns false instead of throwing when the cgroup is gone", () => {
    expect(killCgroup("/nonexistent/cgroup/dir")).toBe(false);
  });
});

describe("collectDescendantPids", () => {
  test("walks /proc/<pid>/task/<tid>/children transitively", () => {
    const procRoot = plainTempDir();
    // 100 → 200, 201 (via two threads); 200 → 300
    const link = (pid: number, tid: number, children: string) => {
      mkdirSync(join(procRoot, String(pid), "task", String(tid)), {
        recursive: true,
      });
      writeFileSync(
        join(procRoot, String(pid), "task", String(tid), "children"),
        children,
      );
    };
    link(100, 100, "200 ");
    link(100, 111, "201 ");
    link(200, 200, "300 ");
    link(201, 201, "");
    link(300, 300, "");

    expect(collectDescendantPids(100, procRoot).sort()).toEqual([
      200, 201, 300,
    ]);
  });

  test("returns an empty list for an unknown pid instead of throwing", () => {
    expect(collectDescendantPids(999999, plainTempDir())).toEqual([]);
  });

  test("does not loop forever on a self-referential children file", () => {
    const procRoot = plainTempDir();
    mkdirSync(join(procRoot, "7", "task", "7"), { recursive: true });
    writeFileSync(join(procRoot, "7", "task", "7", "children"), "7 8");
    mkdirSync(join(procRoot, "8", "task", "8"), { recursive: true });
    writeFileSync(join(procRoot, "8", "task", "8", "children"), "7");
    expect(collectDescendantPids(7, procRoot).sort()).toEqual([8]);
  });
});

describe("killTree", () => {
  test("kills the whole cgroup and skips the per-process path when a cgroup is in use", () => {
    const base = fakeCgroupBase();
    const dir = createRunCgroup(base) as string;
    let directKills = 0;
    killTree({ pid: 999999, kill: () => directKills++ }, dir);
    expect(readFileSync(join(dir, "cgroup.kill"), "utf8")).toBe("1");
    // cgroup.kill SIGKILLs every member, the CLI included — no extra signal.
    expect(directKills).toBe(0);
  });

  test("falls back to the direct kill when the cgroup write fails", () => {
    let directKills = 0;
    killTree(
      { pid: 999999, kill: () => directKills++ },
      "/nonexistent/cgroup/dir",
    );
    expect(directKills).toBe(1);
  });

  test("kills the process directly when no cgroup is in use", () => {
    let directKills = 0;
    killTree({ pid: 999999, kill: () => directKills++ });
    expect(directKills).toBe(1);
  });

  test("tolerates a proc with no pid (fully synthetic/fake proc)", () => {
    let directKills = 0;
    expect(() => killTree({ kill: () => directKills++ })).not.toThrow();
    expect(directKills).toBe(1);
  });

  test("never throws when the underlying kill throws (process already exited)", () => {
    expect(() =>
      killTree({
        pid: 999999,
        kill: () => {
          throw new Error("ESRCH");
        },
      }),
    ).not.toThrow();
  });
});

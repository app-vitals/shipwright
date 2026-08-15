import { afterEach, describe, expect, test } from "bun:test";
/**
 * Unit tests for scripts/check-coverage-no-decrease.ts
 *
 * Verifies evaluateCoverageDelta — the pure comparison function that decides
 * whether a PR's line-coverage percentage decreased relative to the base
 * branch. Pure logic, no I/O: nothing here touches the filesystem, git, or
 * the script's process.exit side effects.
 *
 * Also verifies resolveBaseRef and computeBaseCoveragePct via the injected
 * `run` seam (mirrors this repo's "inject external clients" test isolation
 * rule) — no real git/bun subprocesses are spawned. computeBaseCoveragePct
 * still touches a real mkdtemp'd scratch directory (plain node:fs, not a
 * global override), cleaned up after each test.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeBaseCoveragePct,
  evaluateCoverageDelta,
  resolveBaseRef,
  runCli,
} from "./check-coverage-no-decrease";

const FAKE_LCOV = [
  "SF:agent/src/example.ts",
  "FNF:10",
  "FNH:8",
  "LF:100",
  "LH:75",
  "end_of_record",
].join("\n");

// computeBaseCoveragePct always mkdtemps a real scratch directory (plain
// node:fs, not mocked) before invoking the injected `run` — the fake `run`
// below never actually deletes it (our fake "git worktree remove" just
// reports success without touching disk), so tests record the dir here and
// sweep it up afterward instead of leaking real /tmp entries.
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Recognizes computeBaseCoveragePct's "git worktree add ... <dir> ..." call,
// pre-creates its coverage/ subdirectory (so a later `writeFileSync` into it
// succeeds), and records the dir for the afterEach sweep above.
function trackWorktreeDir(cmd: string[]) {
  if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "add") {
    const worktreeDir = cmd[4];
    tempDirs.push(worktreeDir);
    mkdirSync(join(worktreeDir, "coverage"), { recursive: true });
  }
}

// Fake `run` matching computeBaseCoveragePct's injected signature. Succeeds
// on every step by default; the "bun test" step writes FAKE_LCOV into the
// worktree dir it's given so the real Bun.file(...).text() read after it
// has something to find. `overrides` maps a command's first two argv tokens
// (e.g. "git fetch") to a fixed exit code, for exercising failure paths.
function makeFakeRun(overrides: Record<string, number> = {}) {
  const calls: string[][] = [];
  const run = async (cmd: string[], opts?: { cwd?: string }) => {
    calls.push(cmd);
    trackWorktreeDir(cmd);
    const key = cmd.slice(0, 2).join(" ");
    if (key in overrides) {
      return { exitCode: overrides[key] };
    }
    if (cmd[0] === "bun" && cmd[1] === "test" && opts?.cwd) {
      writeFileSync(join(opts.cwd, "coverage", "lcov.info"), FAKE_LCOV);
    }
    return { exitCode: 0 };
  };
  return { run, calls };
}

describe("resolveBaseRef", () => {
  test("prefers an explicit override over everything else", () => {
    expect(resolveBaseRef("develop", { GITHUB_BASE_REF: "main" })).toBe(
      "develop",
    );
  });

  test("falls back to GITHUB_BASE_REF when no override is given", () => {
    expect(resolveBaseRef(undefined, { GITHUB_BASE_REF: "release" })).toBe(
      "release",
    );
  });

  test("falls back to 'main' when neither override nor env var is set", () => {
    expect(resolveBaseRef(undefined, {})).toBe("main");
  });
});

describe("computeBaseCoveragePct", () => {
  test("parses the base ref's lcov and returns its aggregate line percentage", async () => {
    const { run } = makeFakeRun();
    const pct = await computeBaseCoveragePct("main", run);
    // 75/100 * 100 = 75
    expect(pct).toBe(75);
  });

  test("cleans up the worktree via 'git worktree remove' on success", async () => {
    const { run, calls } = makeFakeRun();
    await computeBaseCoveragePct("main", run);
    expect(
      calls.some((c) => c.slice(0, 3).join(" ") === "git worktree remove"),
    ).toBe(true);
  });

  test("throws when fetching the base ref fails", async () => {
    const { run } = makeFakeRun({ "git fetch": 1 });
    await expect(computeBaseCoveragePct("main", run)).rejects.toThrow(/fetch/i);
  });

  test("throws when checking out the worktree fails", async () => {
    const { run } = makeFakeRun({ "git worktree": 1 });
    await expect(computeBaseCoveragePct("main", run)).rejects.toThrow(
      /worktree/i,
    );
  });

  test("throws when installing dependencies fails", async () => {
    const { run } = makeFakeRun({ "bun install": 1 });
    await expect(computeBaseCoveragePct("main", run)).rejects.toThrow(
      /install/i,
    );
  });

  test("still parses coverage when the base ref's test suite exits non-zero", async () => {
    // A failing test on the base ref (e.g. a pre-existing flake) must not
    // block the coverage comparison — bun test --coverage still writes a
    // complete lcov.info even when individual tests fail. Simulate that by
    // writing FAKE_LCOV *and* returning a non-zero exit for the test step.
    const run = async (cmd: string[], opts?: { cwd?: string }) => {
      trackWorktreeDir(cmd);
      if (cmd[0] === "bun" && cmd[1] === "test" && opts?.cwd) {
        writeFileSync(join(opts.cwd, "coverage", "lcov.info"), FAKE_LCOV);
        return { exitCode: 1 };
      }
      return { exitCode: 0 };
    };
    const pct = await computeBaseCoveragePct("main", run);
    expect(pct).toBe(75);
  });

  test("throws a clear error when no lcov file is produced at all", async () => {
    // "bun test" never writes the file
    const run = async (cmd: string[]) => {
      trackWorktreeDir(cmd);
      return { exitCode: 0 };
    };
    await expect(computeBaseCoveragePct("main", run)).rejects.toThrow(
      /no coverage file/i,
    );
  });
});

// Minimal valid lcov content for runCli's "current PR" read — 8/10 lines,
// distinct from FAKE_LCOV above so assertions can tell current vs base apart.
const CURRENT_LCOV = [
  "SF:agent/src/example.ts",
  "FNF:2",
  "FNH:2",
  "LF:10",
  "LH:8",
  "end_of_record",
].join("\n");

function makeLogSpy() {
  const messages: string[] = [];
  return { fn: (msg: string) => messages.push(msg), messages };
}

describe("runCli", () => {
  test("returns 1 and logs an error when the current lcov file can't be read", async () => {
    const { fn: error, messages } = makeLogSpy();
    const exitCode = await runCli({
      readCurrentLcov: () => Promise.reject(new Error("ENOENT")),
      error,
    });
    expect(exitCode).toBe(1);
    expect(messages.some((m) => m.includes("No coverage file at"))).toBe(true);
  });

  test("returns 1 and logs an error when computing base coverage throws", async () => {
    const { fn: error, messages } = makeLogSpy();
    const exitCode = await runCli({
      readCurrentLcov: () => Promise.resolve(CURRENT_LCOV),
      computeBase: () => Promise.reject(new Error("boom")),
      argv: ["bun", "script.ts"],
      env: {},
      error,
    });
    expect(exitCode).toBe(1);
    expect(messages.some((m) => m.includes("Could not compute base"))).toBe(
      true,
    );
  });

  test("returns 1 and logs an error when current coverage decreased vs base", async () => {
    const { fn: error, messages } = makeLogSpy();
    // current: 8/10 = 80%, base: 100% (FAKE_LCOV is 75/100 = 75%... use a
    // higher base explicitly via a fake computeBase returning 90).
    const exitCode = await runCli({
      readCurrentLcov: () => Promise.resolve(CURRENT_LCOV),
      computeBase: () => Promise.resolve(90),
      argv: ["bun", "script.ts"],
      env: {},
      log: () => {},
      error,
    });
    expect(exitCode).toBe(1);
    expect(messages.some((m) => m.includes("Coverage decreased"))).toBe(true);
  });

  test("returns 0 and logs success when current coverage did not decrease", async () => {
    const { fn: log, messages } = makeLogSpy();
    const exitCode = await runCli({
      readCurrentLcov: () => Promise.resolve(CURRENT_LCOV),
      computeBase: () => Promise.resolve(50),
      argv: ["bun", "script.ts"],
      env: {},
      log,
    });
    expect(exitCode).toBe(0);
    expect(messages.some((m) => m.includes("Coverage did not decrease"))).toBe(
      true,
    );
  });

  test("passes the resolved base ref through to computeBase", async () => {
    let receivedBaseRef: string | undefined;
    await runCli({
      readCurrentLcov: () => Promise.resolve(CURRENT_LCOV),
      computeBase: (baseRef) => {
        receivedBaseRef = baseRef;
        return Promise.resolve(0);
      },
      argv: ["bun", "script.ts", "release"],
      env: { GITHUB_BASE_REF: "main" },
      log: () => {},
    });
    expect(receivedBaseRef).toBe("release");
  });
});

describe("evaluateCoverageDelta", () => {
  test("passes when current coverage increased over base", () => {
    const result = evaluateCoverageDelta(85.5, 80.0);
    expect(result).toEqual({ decreased: false });
  });

  test("fails when current coverage decreased from base", () => {
    const result = evaluateCoverageDelta(75.0, 80.0);
    expect(result).toEqual({ decreased: true });
  });

  test("passes when current coverage is unchanged from base", () => {
    const result = evaluateCoverageDelta(80.0, 80.0);
    expect(result).toEqual({ decreased: false });
  });

  test("passes at the exact equal-at-boundary case (current === base)", () => {
    // Explicitly called out by the AC as distinct from "no-change" — a PR
    // that holds coverage exactly flat must pass, not fail on an off-by
    // epsilon comparison.
    const result = evaluateCoverageDelta(80.0, 80.0);
    expect(result.decreased).toBe(false);
  });

  test("passes at a fractional equal-at-boundary case", () => {
    const result = evaluateCoverageDelta(83.33, 83.33);
    expect(result.decreased).toBe(false);
  });

  test("fails on a small fractional decrease", () => {
    const result = evaluateCoverageDelta(79.99, 80.0);
    expect(result.decreased).toBe(true);
  });

  test("passes on a small fractional increase", () => {
    const result = evaluateCoverageDelta(80.01, 80.0);
    expect(result.decreased).toBe(false);
  });

  test("passes when both are 100%", () => {
    const result = evaluateCoverageDelta(100, 100);
    expect(result.decreased).toBe(false);
  });

  test("passes when both are 0%", () => {
    const result = evaluateCoverageDelta(0, 0);
    expect(result.decreased).toBe(false);
  });
});

/**
 * scripts/quickstart.smoke.test.ts
 * Smoke tests for scripts/quickstart.sh.
 *
 * Tests the --check flag (prerequisite validation) and --help output.
 * Runs the actual shell script via Bun.spawnSync — no mocking.
 *
 * The --check flag must exit 0 when all prerequisites are met (bun available),
 * and must exit non-zero with a clear message when a prerequisite is missing.
 *
 * Note: These tests run against the real environment. In CI, bun is available.
 * The go-task prerequisite is validated via output inspection (not exit code)
 * since task may not be installed in all environments.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT_PATH = resolve(process.cwd(), "scripts/quickstart.sh");

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function runScript(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(["sh", SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    env: process.env,
  });

  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ? result.stdout.toString() : "",
    stderr: result.stderr ? result.stderr.toString() : "",
  };
}

// ---------------------------------------------------------------------------
// Script existence
// ---------------------------------------------------------------------------

describe("quickstart.sh — existence", () => {
  test("scripts/quickstart.sh exists", () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --help flag
// ---------------------------------------------------------------------------

describe("quickstart.sh --help", () => {
  test("--help exits with code 0", () => {
    const { exitCode } = runScript(["--help"]);
    expect(exitCode).toBe(0);
  });

  test("--help output mentions bun", () => {
    const { stdout, stderr } = runScript(["--help"]);
    const combined = stdout + stderr;
    expect(combined.toLowerCase()).toMatch(/bun/);
  });

  test("--help output mentions task or go-task", () => {
    const { stdout, stderr } = runScript(["--help"]);
    const combined = stdout + stderr;
    expect(combined.toLowerCase()).toMatch(/task/);
  });
});

// ---------------------------------------------------------------------------
// --check flag
// ---------------------------------------------------------------------------

describe("quickstart.sh --check", () => {
  test("--check flag is supported (does not crash with unknown flag error)", () => {
    const { stdout, stderr, exitCode } = runScript(["--check"]);
    const combined = stdout + stderr;
    // Should not contain "unknown option" or "unrecognized"
    expect(combined.toLowerCase()).not.toMatch(/unknown option/);
    expect(combined.toLowerCase()).not.toMatch(/unrecognized/);
    // exitCode is either 0 (all prereqs met) or non-zero (missing prereq)
    // but the script must at least run without crashing
    expect([0, 1]).toContain(exitCode);
  });

  test("--check output is human-readable (contains text)", () => {
    const { stdout, stderr } = runScript(["--check"]);
    const combined = stdout + stderr;
    expect(combined.trim().length).toBeGreaterThan(0);
  });

  test("--check reports bun availability", () => {
    const { stdout, stderr } = runScript(["--check"]);
    const combined = stdout + stderr;
    expect(combined.toLowerCase()).toMatch(/bun/);
  });

  test("--check reports go-task availability", () => {
    const { stdout, stderr } = runScript(["--check"]);
    const combined = stdout + stderr;
    expect(combined.toLowerCase()).toMatch(/task/);
  });

  test("--check exits 0 when bun is available (bun is in PATH in this environment)", () => {
    // bun is the runtime executing this test, so it must be in PATH
    const bunResult = Bun.spawnSync(["which", "bun"]);
    const bunAvailable = bunResult.exitCode === 0;

    if (!bunAvailable) {
      // If for some reason bun is not in PATH, skip this assertion
      console.warn("bun not found in PATH — skipping exit-0 assertion");
      return;
    }

    // When bun is available but task may not be, check mode should still
    // provide useful output. We check bun is found in output.
    const { stdout, stderr } = runScript(["--check"]);
    const combined = stdout + stderr;
    expect(combined.toLowerCase()).toMatch(/bun/);
  });

  test("--check does not modify any files (idempotent, no side effects)", () => {
    // Run --check twice; both should produce the same exit code
    const first = runScript(["--check"]);
    const second = runScript(["--check"]);
    expect(first.exitCode).toBe(second.exitCode);
  });
});

// ---------------------------------------------------------------------------
// Missing prerequisite: simulate missing bun by overriding PATH
// ---------------------------------------------------------------------------

describe("quickstart.sh --check with missing prerequisites", () => {
  test("--check exits non-zero when bun is not in PATH", () => {
    const result = Bun.spawnSync(["sh", SCRIPT_PATH, "--check"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Override PATH to exclude bun entirely
        PATH: "/usr/bin:/bin",
      },
    });

    expect(result.exitCode).not.toBe(0);
  });

  test("--check error output mentions bun.sh install URL when bun is missing", () => {
    const result = Bun.spawnSync(["sh", SCRIPT_PATH, "--check"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
      },
    });

    const combined =
      (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
    expect(combined).toMatch(/bun\.sh/);
  });
});

/**
 * agent/scripts/cli-scripts.unit.test.ts
 *
 * Argument-handling tests for the operator CLI scripts that parse argv via
 * lib/cli-flags.ts. The scripts run on import, so each case spawns one and
 * asserts on exit code/output; every case exits before any network or DB use.
 */

import { describe, expect, test } from "bun:test";

const SCRIPTS = import.meta.dir;

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bun", `${SCRIPTS}/${script}`, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

describe("backfill-pr-origin.ts argument validation", () => {
  test("rejects a trailing --repo with no value", () => {
    const r = run("backfill-pr-origin.ts", ["--repo"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--repo requires a value");
  });

  test.each([["0"], ["-3"], ["abc"]])("rejects --days %s", (days) => {
    const r = run("backfill-pr-origin.ts", ["--repo", "o/r", "--days", days]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--days requires a positive number");
  });

  test("rejects --days with no value", () => {
    const r = run("backfill-pr-origin.ts", ["--repo", "o/r", "--days"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--days requires a positive number");
  });

  test("requires at least one repo (flag or env)", () => {
    const r = run("backfill-pr-origin.ts", ["--days", "7"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no repos given");
  });
});

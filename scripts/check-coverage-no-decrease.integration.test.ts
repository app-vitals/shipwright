/**
 * Integration tests for scripts/check-coverage-no-decrease.ts
 *
 * Verifies defaultRun — the real Bun.spawn-backed implementation of
 * computeBaseCoveragePct's injectable `run` dependency. Real subprocess
 * behavior, not mocked: spawns actual short-lived `bun -e` processes and
 * checks the returned exit code passes through correctly.
 */
import { describe, expect, test } from "bun:test";
import { defaultRun } from "./check-coverage-no-decrease";

describe("defaultRun", () => {
  test("returns exit code 0 for a successful command", async () => {
    const result = await defaultRun(["bun", "-e", "process.exit(0)"]);
    expect(result).toEqual({ exitCode: 0 });
  });

  test("returns the process's non-zero exit code", async () => {
    const result = await defaultRun(["bun", "-e", "process.exit(7)"]);
    expect(result).toEqual({ exitCode: 7 });
  });
});

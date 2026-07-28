/**
 * scripts/test-env-preload.unit.test.ts
 *
 * Regression coverage for SEN-4.2: `scripts/test-env-preload.ts` is wired into
 * bunfig.toml's `[test]` preload array so `process.env.NODE_ENV` is forced to
 * "test" before any test file loads, regardless of what the invoking shell
 * already exports. This supersedes the SEN-3.1-era approach of prefixing
 * individual `bun test` invocation sites with `NODE_ENV=test` — that pattern
 * left every subpackage's own test script and any single-file invocation
 * unprotected, which is exactly the gap this test guards against.
 *
 * Unlike the string-match test it replaces (scripts/test-env-guard.unit.test.ts,
 * which only asserted a literal `NODE_ENV=test` prefix existed in Taskfile.yml/
 * package.json and never exercised the actual invariant), this test invokes
 * the preload's exported logic directly and asserts the real outcome: NODE_ENV
 * becomes "test" even when a parent process already exported something else.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setTestEnv } from "./test-env-preload.ts";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe("setTestEnv", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    // Restore so this test doesn't leak NODE_ENV state to sibling suites
    // sharing the Bun test process.
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  test("forces NODE_ENV to 'test' even when already set to something else", () => {
    expect(process.env.NODE_ENV).toBe("production");
    setTestEnv();
    expect(process.env.NODE_ENV).toBe("test");
  });
});

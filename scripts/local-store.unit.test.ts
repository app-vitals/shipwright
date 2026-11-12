/**
 * scripts/local-store.unit.test.ts
 * Content + error-path tests for scripts/local-store.sh. No Docker needed: the
 * real boot is covered by the CI smoke job; here we exercise flag parsing and
 * the "Docker missing" path by running the script with an empty PATH-only bash.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT_PATH = resolve(process.cwd(), "scripts/local-store.sh");
const BASH = Bun.which("bash") ?? "bash";

function run(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "local-store-"));
  return spawnSync(BASH, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: { HOME: dir, PATH: dir, ...env },
  });
}

describe("scripts/local-store.sh", () => {
  test("is executable and has a bash shebang", () => {
    expect(statSync(SCRIPT_PATH).mode & 0o111).not.toBe(0);
    expect(readFileSync(SCRIPT_PATH, "utf8").startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  test("--help prints usage and exits 0", () => {
    const r = spawnSync("bash", [SCRIPT_PATH, "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--down");
  });

  test("unknown flag exits 2 with usage", () => {
    const r = spawnSync("bash", [SCRIPT_PATH, "--bogus"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unknown option: --bogus");
  });

  test("missing Docker fails with a clear error (boot)", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker is not installed");
  });

  test("missing Docker fails with a clear error (--down)", () => {
    const r = run(["--down"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker is not installed");
  });

  test("script wires compose, readiness, token mint, and exports", () => {
    const src = readFileSync(SCRIPT_PATH, "utf8");
    expect(src).toContain("/health/ready");
    expect(src).toContain("POST");
    expect(src).toContain("export SHIPWRIGHT_TASK_STORE_URL=");
    expect(src).toContain("export SHIPWRIGHT_TASK_STORE_TOKEN=");
    expect(src).toContain("SHIPWRIGHT_LOCAL_STORE_PORT");
    expect(src).toContain("already in use");
  });
});

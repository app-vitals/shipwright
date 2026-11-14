/**
 * scripts/local-store.unit.test.ts
 * Content + error-path tests for scripts/local-store.sh. No Docker needed: the
 * real boot is covered by the CI smoke job; here we exercise flag parsing and
 * the "Docker missing" path by running the script with an empty PATH-only bash.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/** Fake docker/curl/nc so the boot path runs end to end without Docker. */
function fakeStack() {
  const home = mkdtempSync(join(tmpdir(), "local-store-home-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("docker", "exit 0");
  stub("nc", "exit 1");
  stub("curl", 'case "$*" in *tokens*) echo \'{"rawToken":"tok-secret-123"}\' ;; esac; exit 0');
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const envFile = join(home, ".shipwright", "local-store.env");
  const exec = (args: string[] = []) =>
    spawnSync(BASH, [SCRIPT_PATH, ...args], { encoding: "utf8", env });
  return { exec, envFile };
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

  test("boot writes a mode-600 env file and ends with a source line, hiding the token", () => {
    const { exec, envFile } = fakeStack();
    const r = exec();
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[lines.length - 1]).toBe(`source ${envFile}`);
    expect(r.stdout).not.toContain("tok-secret-123");
    expect(r.stderr).not.toContain("tok-secret-123");
    expect(readFileSync(envFile, "utf8")).toBe(
      "export SHIPWRIGHT_TASK_STORE_URL=http://localhost:3002\nexport SHIPWRIGHT_TASK_STORE_TOKEN=tok-secret-123\n",
    );
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  test("--show-token prints the raw token; re-run rewrites the env file", () => {
    const { exec, envFile } = fakeStack();
    exec();
    writeFileSync(envFile, "stale");
    const r = exec(["--show-token"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tok-secret-123");
    expect(r.stdout.trim().split("\n").pop()).toBe(`source ${envFile}`);
    expect(readFileSync(envFile, "utf8")).toContain("export SHIPWRIGHT_TASK_STORE_TOKEN=tok-secret-123");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  test("--down removes the env file", () => {
    const { exec, envFile } = fakeStack();
    exec();
    expect(existsSync(envFile)).toBe(true);
    const r = exec(["--down"]);
    expect(r.status).toBe(0);
    expect(existsSync(envFile)).toBe(false);
  });
});

/**
 * scripts/doctor.unit.test.ts
 * Unit tests for scripts/doctor.sh. PATH is stubbed with fake bun/gh shims and
 * git runs against throwaway repos with global/system config isolated.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT_PATH = resolve(process.cwd(), "scripts/doctor.sh");
const BASH = Bun.which("bash") ?? "bash";
// Prefer the system git: a PATH-resident wrapper may need tools the stubbed PATH lacks.
const GIT = existsSync("/usr/bin/git")
  ? "/usr/bin/git"
  : (Bun.which("git") ?? "git");

interface Opts {
  bun?: boolean;
  gh?: "ok" | "unauth" | "missing";
  repo?: boolean;
  remote?: string | null;
  name?: string | null;
  email?: string | null;
  env?: Record<string, string>;
  args?: string[];
}

function run(o: Opts = {}) {
  const {
    bun = true,
    gh = "ok",
    repo = true,
    remote = "https://github.com/acme/app.git",
    name = "Ada",
    email = "ada@example.com",
    env = {
      SHIPWRIGHT_TASK_STORE_URL: "http://x",
      SHIPWRIGHT_TASK_STORE_TOKEN: "t",
    },
    args = [],
  } = o;
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  stub("git", `exec "${GIT}" "$@"`);
  if (bun) stub("bun", "exit 0");
  if (gh !== "missing") stub("gh", gh === "ok" ? "exit 0" : "exit 1");
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const gitEnv = {
    GIT_CONFIG_GLOBAL: join(root, "nogc"),
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: root,
    PATH: bin,
  };
  if (repo) {
    const g = (...a: string[]) =>
      spawnSync(GIT, a, { cwd, env: gitEnv, encoding: "utf8" });
    g("init", "-q");
    if (remote) g("remote", "add", "origin", remote);
    if (name) g("config", "user.name", name);
    if (email) g("config", "user.email", email);
  }
  return spawnSync(BASH, [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...gitEnv, ...env },
  });
}

const lines = (s: string) => s.split("\n").filter(Boolean);

describe("scripts/doctor.sh", () => {
  test("is executable with a bash shebang", () => {
    expect(statSync(SCRIPT_PATH).mode & 0o111).not.toBe(0);
  });

  test("all pass: no output, exit 0", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("missing bun", () => {
    const r = run({ bun: false });
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toHaveLength(1);
    expect(r.stderr).toContain("bun");
  });

  test("gh not signed in", () => {
    const r = run({ gh: "unauth" });
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toHaveLength(1);
    expect(r.stderr).toContain("gh auth login");
  });

  test("gh missing", () => {
    const r = run({ gh: "missing" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("gh is not installed");
  });

  test("not a git repo", () => {
    const r = run({ repo: false });
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toHaveLength(1);
    expect(r.stderr).toContain("not a git repo");
  });

  test("no origin remote", () => {
    const r = run({ remote: null });
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toHaveLength(1);
    expect(r.stderr).toContain("no origin remote");
  });

  test("non-GitHub origin", () => {
    const r = run({ remote: "https://example.com/a/b.git" });
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toHaveLength(1);
    expect(r.stderr).toContain("not on github.com");
  });

  test("missing git user.name", () => {
    const r = run({ name: null });
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toHaveLength(1);
    expect(r.stderr).toContain("user.name");
  });

  test("missing git user.email", () => {
    const r = run({ email: null });
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toHaveLength(1);
    expect(r.stderr).toContain("user.email");
  });

  test("missing task-store env names scripts/local-store.sh", () => {
    const r = run({ env: {} });
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toHaveLength(1);
    expect(r.stderr).toContain("scripts/local-store.sh");
  });

  test("only one of the env vars set still fails", () => {
    const r = run({ env: { SHIPWRIGHT_TASK_STORE_URL: "http://x" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("SHIPWRIGHT_TASK_STORE_TOKEN");
  });

  test("--skip-task-store skips the env check", () => {
    const r = run({ env: {}, args: ["--skip-task-store"] });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  test("--skip-task-store still reports other failures", () => {
    const r = run({ env: {}, bun: false, args: ["--skip-task-store"] });
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toHaveLength(1);
  });

  test("multiple failures give one line each", () => {
    const r = run({ bun: false, gh: "unauth", name: null, env: {} });
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toHaveLength(4);
  });

  test("unknown flag exits 2", () => {
    const r = run({ args: ["--bogus"] });
    expect(r.status).toBe(2);
  });
});

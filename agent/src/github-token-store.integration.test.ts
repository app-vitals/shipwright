/**
 * agent/src/github-token-store.integration.test.ts
 *
 * Integration tests for github-token-store — real file I/O to unique tmp paths.
 * Strategy: pass explicit paths/env to the module functions so we never mutate
 * global env or rely on real $HOME. Each test uses a unique tmp file path and
 * cleans up via afterEach.
 */

import { afterEach, describe, expect, it, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readToken,
  resolveTokenPath,
  writeToken,
} from "./github-token-store.ts";

// Each test gets a unique path so parallel runs don't collide.
let counter = 0;
function uniqueTmpPath(): string {
  counter += 1;
  return join(
    tmpdir(),
    `shipwright-agent-gh-token-test-${process.pid}-${Date.now()}-${counter}`,
  );
}

const createdPaths: string[] = [];
function track(p: string): string {
  createdPaths.push(p);
  return p;
}

afterEach(() => {
  while (createdPaths.length) {
    const p = createdPaths.pop();
    if (!p) continue;
    try {
      rmSync(p, { force: true, recursive: true });
    } catch {
      // ignore
    }
  }
});

// ─── resolveTokenPath ────────────────────────────────────────────────────────

describe("resolveTokenPath()", () => {
  it("returns GH_TOKEN_FILE if set", () => {
    const env = { GH_TOKEN_FILE: "/run/custom/token" };
    expect(resolveTokenPath(env)).toBe("/run/custom/token");
  });

  it("uses XDG_RUNTIME_DIR when GH_TOKEN_FILE is absent", () => {
    const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
    expect(resolveTokenPath(env)).toBe(
      "/run/user/1000/shipwright-agent-gh-token",
    );
  });

  it("GH_TOKEN_FILE takes precedence over XDG_RUNTIME_DIR", () => {
    const env = {
      GH_TOKEN_FILE: "/run/custom/token",
      XDG_RUNTIME_DIR: "/run/user/1000",
    };
    expect(resolveTokenPath(env)).toBe("/run/custom/token");
  });

  it("falls back to HOME/.shipwright-agent-gh-token when neither is set", () => {
    const env = { HOME: "/home/runner" };
    expect(resolveTokenPath(env)).toBe(
      "/home/runner/.shipwright-agent-gh-token",
    );
  });

  it("falls back to /tmp/.shipwright-agent-gh-token if HOME is also absent", () => {
    expect(resolveTokenPath({})).toBe("/tmp/.shipwright-agent-gh-token");
  });

  test("precedence — override > XDG > HOME", () => {
    const all = {
      GH_TOKEN_FILE: "/override/path",
      XDG_RUNTIME_DIR: "/run/user/1000",
      HOME: "/home/dan",
    };
    expect(resolveTokenPath(all)).toBe("/override/path");

    const noOverride = {
      XDG_RUNTIME_DIR: "/run/user/1000",
      HOME: "/home/dan",
    };
    expect(resolveTokenPath(noOverride)).toBe(
      "/run/user/1000/shipwright-agent-gh-token",
    );

    const homeOnly = { HOME: "/home/dan" };
    expect(resolveTokenPath(homeOnly)).toBe(
      "/home/dan/.shipwright-agent-gh-token",
    );
  });

  test("works for container case (HOME=/root, no XDG_RUNTIME_DIR)", () => {
    const env = { HOME: "/root" };
    expect(resolveTokenPath(env)).toBe("/root/.shipwright-agent-gh-token");
  });

  test("works for Pi systemd-user case (XDG_RUNTIME_DIR set)", () => {
    const env = {
      XDG_RUNTIME_DIR: "/run/user/1000",
      HOME: "/home/dan",
    };
    expect(resolveTokenPath(env)).toBe(
      "/run/user/1000/shipwright-agent-gh-token",
    );
  });

  test("defaults to process.env when no env passed", () => {
    // Just smoke-check: returns a non-empty string.
    const result = resolveTokenPath();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── writeToken / readToken round-trip ────────────────────────────────────────

describe("writeToken() / readToken() round-trip", () => {
  test("token written can be read back unchanged", () => {
    const p = track(uniqueTmpPath());
    writeToken("ghs_abc123def456", p);
    expect(readToken(p)).toBe("ghs_abc123def456");
  });

  test("overwrite — second write replaces first value", () => {
    const p = track(uniqueTmpPath());
    writeToken("first-token", p);
    writeToken("second-token", p);
    expect(readToken(p)).toBe("second-token");
  });

  test("round-trip preserves multi-character tokens with special chars", () => {
    const p = track(uniqueTmpPath());
    const token = "ghs_a1B2-c3_D4.e5+f6/g7";
    writeToken(token, p);
    expect(readToken(p)).toBe(token);
  });
});

// ─── writeToken atomic / mode 0600 ────────────────────────────────────────────

describe("writeToken() file mode and atomicity", () => {
  test("written file has mode 0600", () => {
    const p = track(uniqueTmpPath());
    writeToken("ghs_secret", p);
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("overwrite preserves mode 0600", () => {
    const p = track(uniqueTmpPath());
    writeToken("first", p);
    writeToken("second", p);
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("no .tmp leftover after write completes", () => {
    const p = track(uniqueTmpPath());
    writeToken("ghs_secret", p);

    // Inspect the directory for any leftover *.tmp files matching the prefix.
    const dir = p.substring(0, p.lastIndexOf("/"));
    const base = p.substring(p.lastIndexOf("/") + 1);
    const leftovers = readdirSync(dir).filter(
      (name) => name.startsWith(`${base}.`) && name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  test("no .tmp leftover after multiple overwrites", () => {
    const p = track(uniqueTmpPath());
    writeToken("first", p);
    writeToken("second", p);
    writeToken("third", p);

    const dir = p.substring(0, p.lastIndexOf("/"));
    const base = p.substring(p.lastIndexOf("/") + 1);
    const leftovers = readdirSync(dir).filter(
      (name) => name.startsWith(`${base}.`) && name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  test("parent directory auto-created if absent", () => {
    // Create a path where the parent subdir does not yet exist.
    const base = track(
      join(
        tmpdir(),
        `shipwright-agent-gh-token-test-${process.pid}-${Date.now()}-parentdir`,
      ),
    );
    const p = join(base, "subdir", "token");
    // base/subdir does not exist — writeToken must create it.
    expect(existsSync(join(base, "subdir"))).toBe(false);
    writeToken("parent-dir-token", p);
    expect(readToken(p)).toBe("parent-dir-token");
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ─── readToken — missing file ─────────────────────────────────────────────────

describe("readToken() — missing file", () => {
  test("returns null when the token file does not exist", () => {
    const p = uniqueTmpPath(); // not tracked, never created
    expect(existsSync(p)).toBe(false);
    expect(readToken(p)).toBeNull();
  });

  test("returns the token after a write following a missing read", () => {
    const p = track(uniqueTmpPath());
    expect(readToken(p)).toBeNull();
    writeToken("post-miss-token", p);
    expect(readToken(p)).toBe("post-miss-token");
  });

  test("propagates non-ENOENT errors (e.g. EACCES)", () => {
    // Simulate a non-ENOENT failure by passing a directory path: read on a
    // directory returns EISDIR, not ENOENT, so it should throw.
    const dir = track(uniqueTmpPath());
    mkdirSync(dir);
    expect(() => readToken(dir)).toThrow();
  });
});

// ─── Interop with externally-written tokens ──────────────────────────────────

describe("readToken() — interop", () => {
  test("reads a token written externally (raw write, no trailing newline)", () => {
    const p = track(uniqueTmpPath());
    writeFileSync(p, "external-token");
    expect(readToken(p)).toBe("external-token");
  });
});

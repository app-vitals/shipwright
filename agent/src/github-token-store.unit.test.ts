/**
 * agent/src/github-token-store.unit.test.ts
 *
 * Unit tests for github-token-store — resolveTokenPath precedence,
 * writeToken atomic write with 0o600 permissions, readToken null on ENOENT.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveTokenPath, writeToken, readToken } from "./github-token-store.ts";

// ─── resolveTokenPath ─────────────────────────────────────────────────────────

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
});

// ─── writeToken / readToken ───────────────────────────────────────────────────

describe("writeToken() / readToken()", () => {
  it("writes a token and reads it back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-token-test-"));
    const tokenPath = path.join(dir, "token");
    writeToken("my-secret-token", tokenPath);
    const read = readToken(tokenPath);
    expect(read).toBe("my-secret-token");
  });

  it("writes with mode 0o600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-token-test-"));
    const tokenPath = path.join(dir, "token");
    writeToken("tok", tokenPath);
    const mode = fs.statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns null when token file does not exist", () => {
    const result = readToken("/tmp/__does_not_exist_gh_token__");
    expect(result).toBeNull();
  });

  it("throws for non-ENOENT errors (e.g. permission denied)", () => {
    // Create a directory where the file should be — reading a directory throws EISDIR
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-token-test-"));
    expect(() => readToken(dir)).toThrow();
  });
});

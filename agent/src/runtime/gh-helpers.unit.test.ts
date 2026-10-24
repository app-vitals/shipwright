/**
 * agent/src/runtime/gh-helpers.unit.test.ts
 *
 * Unit tests for getCurrentUser() and ghGraphql() in gh-helpers.ts
 * (relocated from check-helpers.unit.test.ts, ARD-4.1).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentUser, ghGraphql } from "./gh-helpers.ts";

/**
 * Write a fake `gh` binary into dir that returns the given GraphQL viewer
 * response JSON. Returns the path to the fake binary.
 *
 * The fake binary is added to PATH by the test beforeEach/afterEach helpers.
 */
function writeFakeGhBinary(dir: string, viewerLogin: string): string {
  const binPath = join(dir, "gh");
  const response = JSON.stringify({ data: { viewer: { login: viewerLogin } } });
  // A minimal shell script that ignores all args and prints the baked response.
  writeFileSync(binPath, `#!/bin/sh\nprintf '%s\\n' '${response}'\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}

/** Write a fake `gh` binary that always fails with a given exit code. */
function writeFailingGhBinary(
  dir: string,
  exitCode: number,
  stderr: string,
): string {
  const binPath = join(dir, "gh");
  writeFileSync(
    binPath,
    `#!/bin/sh\nprintf '%s\\n' '${stderr}' >&2\nexit ${exitCode}\n`,
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

describe("getCurrentUser", () => {
  let tmpDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "get-current-user-test-"));
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns login as-is for a regular PAT user", async () => {
    writeFakeGhBinary(tmpDir, "dmcaulay");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    const result = await getCurrentUser();
    expect(result).toBe("dmcaulay");
  });

  test("normalises [bot] suffix to app/ prefix for GitHub App identity", async () => {
    writeFakeGhBinary(tmpDir, "my-app[bot]");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    const result = await getCurrentUser();
    expect(result).toBe("app/my-app");
  });

  test("handles hyphenated app name in [bot] normalisation", async () => {
    writeFakeGhBinary(tmpDir, "example-repo-agent[bot]");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    const result = await getCurrentUser();
    expect(result).toBe("app/example-repo-agent");
  });

  test("throws when gh exits non-zero", async () => {
    writeFailingGhBinary(tmpDir, 1, "not authenticated");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    await expect(getCurrentUser()).rejects.toThrow("gh api graphql failed");
  });
});

describe("ghGraphql retry", () => {
  let tmpDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gh-graphql-retry-test-"));
    savedPath = process.env.PATH;
    process.env.PATH = `${tmpDir}:${savedPath}`;
  });

  afterEach(() => {
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Fake gh that fails `failures` times with `stderr`, then succeeds. Counts calls. */
  function writeFlakyGh(failures: number, stderr: string): string {
    const counter = join(tmpDir, "count");
    writeFileSync(counter, "0");
    writeFileSync(
      join(tmpDir, "gh"),
      `#!/bin/sh
n=$(cat "${counter}"); n=$((n+1)); echo $n > "${counter}"
if [ $n -le ${failures} ]; then printf '%s\\n' '${stderr}' >&2; exit 1; fi
printf '%s\\n' '{"ok":true}'
`,
    );
    chmodSync(join(tmpDir, "gh"), 0o755);
    return counter;
  }

  const calls = (counter: string) => Number(readFileSync(counter, "utf8"));

  test("retries a transient 504 and succeeds", async () => {
    const counter = writeFlakyGh(2, "gh: HTTP 504");
    const result = await ghGraphql<{ ok: boolean }>("query {}", {
      baseDelayMs: 1,
    });
    expect(result).toEqual({ ok: true });
    expect(calls(counter)).toBe(3);
  });

  test("throws the standard error after exhausting retries", async () => {
    const counter = writeFlakyGh(99, "gh: HTTP 504");
    await expect(ghGraphql("query {}", { baseDelayMs: 1 })).rejects.toThrow(
      "gh api graphql failed (exit 1): gh: HTTP 504",
    );
    expect(calls(counter)).toBe(3);
  });

  test("does not retry a non-transient failure", async () => {
    const counter = writeFlakyGh(99, "gh: HTTP 401 bad credentials");
    await expect(ghGraphql("query {}", { baseDelayMs: 1 })).rejects.toThrow(
      "gh api graphql failed",
    );
    expect(calls(counter)).toBe(1);
  });
});

describe("ghGraphql owner hint", () => {
  let tmpDir: string;
  let savedPath: string | undefined;
  let savedOwner: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gh-graphql-owner-test-"));
    savedPath = process.env.PATH;
    savedOwner = process.env.SHIPWRIGHT_GH_OWNER;
    delete process.env.SHIPWRIGHT_GH_OWNER;
    process.env.PATH = `${tmpDir}:${savedPath}`;
    // Fake gh echoing the owner hint it was spawned with.
    writeFileSync(
      join(tmpDir, "gh"),
      `#!/bin/sh\nprintf '{"owner":"%s"}\\n' "$SHIPWRIGHT_GH_OWNER"\n`,
    );
    chmodSync(join(tmpDir, "gh"), 0o755);
  });

  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    if (savedOwner === undefined) delete process.env.SHIPWRIGHT_GH_OWNER;
    else process.env.SHIPWRIGHT_GH_OWNER = savedOwner;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("owner sets SHIPWRIGHT_GH_OWNER in the spawned env", async () => {
    const result = await ghGraphql<{ owner: string }>("query {}", {
      owner: "acme",
    });
    expect(result.owner).toBe("acme");
  });

  test("omitted owner leaves the env unchanged", async () => {
    const result = await ghGraphql<{ owner: string }>("query {}");
    expect(result.owner).toBe("");
  });

  test("omitted owner passes through an ambient SHIPWRIGHT_GH_OWNER", async () => {
    process.env.SHIPWRIGHT_GH_OWNER = "ambient";
    const result = await ghGraphql<{ owner: string }>("query {}");
    expect(result.owner).toBe("ambient");
  });

  test("does not mutate the parent process env", async () => {
    await ghGraphql("query {}", { owner: "acme" });
    expect(process.env.SHIPWRIGHT_GH_OWNER).toBeUndefined();
  });
});

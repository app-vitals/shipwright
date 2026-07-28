/**
 * scripts/test-env-preload.integration.test.ts
 *
 * Regression coverage for the gap flagged in review of SEN-4.2: the root
 * bunfig.toml `[test] preload` (scripts/test-env-preload.ts) only fires for
 * `bun test` invocations whose cwd is the repo root — it does not fire for a
 * subpackage's own `test` script (cwd inside e.g. mcp-server/), since Bun
 * does not walk up to a parent bunfig.toml for that invocation shape. This
 * test spawns the real `bun run test` command from inside a subpackage, with
 * a conflicting NODE_ENV pre-exported by the "parent shell", and asserts the
 * subpackage's own `NODE_ENV=test` script prefix (not the root preload)
 * still forces NODE_ENV to "test" before the test file runs — the exact
 * invariant a unit test calling `setTestEnv()` directly cannot exercise.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_SERVER_DIR = join(import.meta.dir, "..", "mcp-server");
const FIXTURE_FILENAME = "__test-env-preload-fixture.integration-fixture.test.ts";
const FIXTURE_PATH = join(MCP_SERVER_DIR, FIXTURE_FILENAME);

beforeAll(() => {
  writeFileSync(
    FIXTURE_PATH,
    `import { test } from "bun:test";
test("prints NODE_ENV for the spawning integration test to read", () => {
  console.log(\`FIXTURE_NODE_ENV=\${process.env.NODE_ENV}\`);
});
`,
  );
});

afterAll(() => {
  rmSync(FIXTURE_PATH, { force: true });
});

describe("subpackage `bun run test` invocation", () => {
  test("forces NODE_ENV=test via the subpackage's own script prefix, even with a conflicting parent NODE_ENV", async () => {
    const proc = Bun.spawn(["bun", "run", "test", FIXTURE_FILENAME], {
      cwd: MCP_SERVER_DIR,
      env: { ...process.env, NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `fixture test process failed:\n${stderr}`).toBe(0);
    expect(stdout).toContain("FIXTURE_NODE_ENV=test");
  }, 15_000);
});

/**
 * mcp-server/src/main.smoke.test.ts
 *
 * Smoke-adjacent test for main.ts's fail-closed inbound-auth guard (TSM-2.6):
 * the module throws at top level — before createApp/Bun.serve ever run — if
 * SHIPWRIGHT_MCP_SERVER_TOKEN is unset (see main.ts:27-32).
 *
 * This can't be exercised via an in-process `import("./main.ts")` the way
 * index.smoke.test.ts exercises createApp():
 *   - The guard runs at module top level, so importing main.ts with the
 *     token unset would throw during the shared test process's own import
 *     graph, and importing it WITH the token set would actually call
 *     Bun.serve() and bind a real port inside the test process.
 *   - Exercising the "unset" case requires mutating process.env, which the
 *     repo's isolation hard rule forbids doing to the shared test process
 *     (no global.* overrides — leaked/mutated globals break sibling suites).
 *
 * So this test spawns mcp-server's entry point as a real child process with
 * SHIPWRIGHT_MCP_SERVER_TOKEN explicitly absent from its env, and asserts the
 * process refuses to start: non-zero exit code, fail-closed message on stderr.
 */

import { describe, expect, it } from "bun:test";

const MCP_SERVER_DIR = new URL("..", import.meta.url).pathname;

describe("mcp-server main.ts fail-closed auth guard", () => {
  it("refuses to start (throws, non-zero exit) when SHIPWRIGHT_MCP_SERVER_TOKEN is unset", async () => {
    // Bun.spawn omits env keys whose value is `undefined`, so this makes the
    // child process see SHIPWRIGHT_MCP_SERVER_TOKEN as genuinely unset —
    // without mutating this (parent) test process's own process.env.
    const env: Record<string, string | undefined> = {
      ...process.env,
      SHIPWRIGHT_MCP_SERVER_TOKEN: undefined,
    };

    const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
      cwd: MCP_SERVER_DIR,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(
      "SHIPWRIGHT_MCP_SERVER_TOKEN must be set — mcp-server refuses to start without inbound auth configured.",
    );
  }, 10_000);
});

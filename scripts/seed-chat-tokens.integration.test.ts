/**
 * scripts/seed-chat-tokens.integration.test.ts
 *
 * CLI-entrypoint coverage for scripts/seed-chat-tokens.ts. A unit test cannot
 * reach the `import.meta.main` block (it is false for an imported module), so
 * this spawns the script the way `task stack` does (scripts/dev-tmux.ts ->
 * `bun run scripts/seed-chat-tokens.ts --db-url ...`).
 *
 * Since CHX-3.3 the chat service is hosted in app-vitals/agent and the seeder
 * writes to its ChatToken table over Bun.SQL, with no chat/ workspace or Prisma
 * client from this repo. The test therefore asserts the script gets all the way
 * to a *database connection* failure (the SQL client was built and a query was
 * issued) rather than a module-resolution failure.
 *
 * "Integration" per this repo's layer convention: real spawn, no real Postgres.
 * The database URL points at a closed loopback port so the connection is
 * refused immediately (no DNS, no waiting).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = "scripts/seed-chat-tokens.ts";

/** Port 1 on loopback: nothing listens, so `pg` gets an instant ECONNREFUSED. */
const UNREACHABLE_DB_URL = "postgresql://u:p@127.0.0.1:1/nope";

async function runSeeder(
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  // Strip the ambient chat DB URL (CI sets it) so the "no database URL" guard
  // is reachable and no case can fall back to a real database. Omitted via
  // rest-destructuring rather than assigned `undefined` — an absent key is the
  // only spelling of "unset" Bun.spawn treats consistently across versions.
  const { DATABASE_URL_SHIPWRIGHT_CHAT: _unset, ...env } = process.env;

  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, output: `${stdout}\n${stderr}` };
}

describe("seed-chat-tokens CLI entrypoint", () => {
  test("builds the SQL client and reaches the insert (fails only on connectivity)", async () => {
    const { exitCode, output } = await runSeeder([
      "--db-url",
      UNREACHABLE_DB_URL,
      "--admin-token",
      "dev-chat-admin-token",
      "--agent-token",
      "dev-chat-agent-token",
      "--agent-id",
      "dev-agent",
    ]);

    // No chat/ workspace import may remain: it would fail before any query.
    expect(output).not.toContain("Cannot find module");

    // A connection failure reported by the seeder's own handler proves the
    // client was built and the insert was actually attempted.
    expect(output).toContain("[seed-chat-tokens] failed to seed tokens");
    expect(exitCode).not.toBe(0);
  }, 30_000);

  test("fails fast with a clear message when no database URL is available", async () => {
    const { exitCode, output } = await runSeeder([
      "--admin-token",
      "a",
      "--agent-token",
      "b",
      "--agent-id",
      "dev-agent",
    ]);

    expect(output).toContain("No database URL");
    expect(output).not.toContain("Cannot find module");
    expect(exitCode).toBe(1);
  }, 30_000);

  test("fails fast when token flags are missing, before touching the database", async () => {
    const { exitCode, output } = await runSeeder([
      "--db-url",
      UNREACHABLE_DB_URL,
    ]);

    expect(output).toContain("Missing flags");
    expect(output).not.toContain("failed to seed tokens");
    expect(exitCode).toBe(1);
  }, 30_000);
});

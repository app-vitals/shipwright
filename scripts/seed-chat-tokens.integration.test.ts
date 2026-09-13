/**
 * scripts/seed-chat-tokens.integration.test.ts
 *
 * Regression coverage for the gap flagged in review of the chat Prisma 7
 * upgrade: scripts/seed-chat-tokens.ts's `import.meta.main` block is the one
 * chat PrismaClient construction site that lives outside chat/src, so nothing
 * in the repo exercised it — it kept importing the Prisma 6 generator output
 * (`../chat/prisma/client/index.js`) and the removed
 * `new PrismaClient({ datasources })` constructor, and `task stack` broke at
 * its seeding preflight with "Cannot find module".
 *
 * A unit test cannot reach that code: `import.meta.main` is false for an
 * imported module, so the CLI block never runs under `bun test`. This test
 * therefore spawns the script the way `task stack` does (scripts/dev-tmux.ts
 * → `bun run scripts/seed-chat-tokens.ts --db-url ...`) and asserts it gets
 * all the way to a *database* failure — i.e. the client was constructed and a
 * query issued — rather than a module-resolution or constructor failure.
 *
 * "Integration" per this repo's layer convention: real spawn, real generated
 * client, no real Postgres. The database URL points at a closed loopback port
 * so the connection is refused immediately (no DNS, no waiting) and the
 * process never touches a live database.
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
  test("constructs a Prisma 7 client and reaches the upsert (fails only on connectivity)", async () => {
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

    // The removed Prisma 6 client path and the dropped `datasources`
    // constructor option both fail before any query is issued — these are the
    // exact regressions this test exists to catch.
    expect(output).not.toContain("Cannot find module");
    expect(output).not.toContain("datasources");

    // Getting an unreachable-database error proves the adapter-backed client
    // was built and `chatToken.upsert()` actually ran.
    expect(output).toContain("Can't reach database server at 127.0.0.1:1");
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
    expect(output).not.toContain("Can't reach database server");
    expect(exitCode).toBe(1);
  }, 30_000);
});

/**
 * scripts/seed-task-store-token.integration.test.ts
 *
 * Integration coverage for seed-task-store-token.ts's *CLI entrypoint*.
 *
 * The pure helpers are unit-tested in seed-task-store-token.unit.test.ts with an
 * injected double. That leaves the `import.meta.main` block — which builds the
 * real PrismaClient — untested, and it is exactly the part that broke in the
 * Prisma 7 migration: it imported the v6-only `prisma/client/index.js` output
 * path (no longer emitted by the `prisma-client` generator) and passed the
 * `datasources` constructor option (dropped in v7). Both are construction-time
 * failures, so no amount of double-injection catches them — the script has to
 * actually be executed.
 *
 * Because that block is gated on `import.meta.main`, importing the module can't
 * reach it; the test spawns the script as a subprocess instead, which is also
 * precisely how `task hitl` and `task stack` invoke it.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { createPrismaClient } from "../task-store/src/prisma-client.ts";
import { hashRawToken } from "./seed-task-store-token.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const SCRIPT_PATH = new URL("./seed-task-store-token.ts", import.meta.url)
  .pathname;

/** Raw tokens minted by this suite, torn down in afterAll. */
const seededRawTokens: string[] = [];

function uniqueToken(suffix: string): string {
  const raw = `test-seed-${suffix}-${crypto.randomUUID()}`;
  seededRawTokens.push(raw);
  return raw;
}

async function runSeeder(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    ["bun", "run", SCRIPT_PATH, "--db-url", TEST_DB as string, ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describeOrSkip("seed-task-store-token CLI entrypoint (integration)", () => {
  afterAll(async () => {
    if (!TEST_DB || seededRawTokens.length === 0) return;
    const prisma = createPrismaClient(TEST_DB);
    try {
      await prisma.taskToken.deleteMany({
        where: { token: { in: seededRawTokens.map(hashRawToken) } },
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("builds a real client and upserts an admin token", async () => {
    const raw = uniqueToken("admin");

    const { exitCode, stdout, stderr } = await runSeeder(["--token", raw]);

    // A v6-style construction site fails here: module-not-found on the removed
    // client path, or a runtime error from the dropped `datasources` option.
    expect(stderr).not.toContain("Cannot find module");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("admin token ready");

    const prisma = createPrismaClient(TEST_DB as string);
    try {
      const row = await prisma.taskToken.findUnique({
        where: { token: hashRawToken(raw) },
      });
      expect(row).not.toBeNull();
      // agentId null => unrestricted admin token.
      expect(row?.agentId).toBeNull();
      expect(row?.label).toBe("dev-admin");
    } finally {
      await prisma.$disconnect();
    }
  });

  it("upserts an agent-scoped token when --agent-id is passed", async () => {
    const raw = uniqueToken("agent");

    const { exitCode, stdout } = await runSeeder([
      "--token",
      raw,
      "--agent-id",
      "hitl",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("agent-scoped (hitl) token ready");

    const prisma = createPrismaClient(TEST_DB as string);
    try {
      const row = await prisma.taskToken.findUnique({
        where: { token: hashRawToken(raw) },
      });
      expect(row?.agentId).toBe("hitl");
      expect(row?.label).toBe("dev-hitl");
    } finally {
      await prisma.$disconnect();
    }
  });

  it("is idempotent — a second run succeeds and leaves one row", async () => {
    const raw = uniqueToken("idempotent");

    expect((await runSeeder(["--token", raw])).exitCode).toBe(0);
    expect((await runSeeder(["--token", raw])).exitCode).toBe(0);

    const prisma = createPrismaClient(TEST_DB as string);
    try {
      const rows = await prisma.taskToken.findMany({
        where: { token: hashRawToken(raw) },
      });
      expect(rows).toHaveLength(1);
    } finally {
      await prisma.$disconnect();
    }
  });
});

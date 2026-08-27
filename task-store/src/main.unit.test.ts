/**
 * task-store/src/main.unit.test.ts
 *
 * Unit tests for checkDbReady — the DB-aware readiness check backing
 * GET /health/ready. Exercised here with a mocked $queryRaw (no real
 * Postgres) — the real query is a plain `SELECT 1` ping.
 */

import { describe, expect, test } from "bun:test";
import { checkDbReady } from "./main.ts";

describe("checkDbReady", () => {
  test("returns true when the DB is reachable", async () => {
    const prisma = { $queryRaw: async () => [{ "?column?": 1 }] };
    await expect(checkDbReady(prisma)).resolves.toBe(true);
  });

  test("returns false when the DB is unreachable", async () => {
    const prisma = {
      $queryRaw: async () => {
        throw new Error("Can't reach database server at 127.0.0.1:5432");
      },
    };
    await expect(checkDbReady(prisma)).resolves.toBe(false);
  });
});

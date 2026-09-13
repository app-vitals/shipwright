/**
 * admin/src/prisma-client.unit.test.ts
 *
 * Unit coverage for the one branch of `createAdminPrismaClient` that does no
 * I/O: the missing-connection-string guard. Under Prisma 7 the client is built
 * on a `pg.Pool`, and `pg` silently ignores a falsy `connectionString` (falling
 * back to PGHOST/PGUSER/... or localhost), so a blank URL has to fail loudly
 * here instead of booting the service against an unintended database.
 *
 * The connecting paths live in prisma-client.integration.test.ts (real DB).
 */

import { describe, expect, it } from "bun:test";
import { createAdminPrismaClient } from "./prisma-client.ts";

describe("createAdminPrismaClient — missing connection string", () => {
  it("throws when the connection string is empty", () => {
    expect(() => createAdminPrismaClient("")).toThrow(
      /DATABASE_URL_SHIPWRIGHT_ADMIN is not set/,
    );
  });

  it("throws when the connection string is only whitespace", () => {
    expect(() => createAdminPrismaClient("   ")).toThrow(
      /DATABASE_URL_SHIPWRIGHT_ADMIN is not set/,
    );
  });

  it("names the env var and the expected format in the error message", () => {
    let message = "";
    try {
      createAdminPrismaClient("");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("DATABASE_URL_SHIPWRIGHT_ADMIN");
    expect(message).toContain("postgresql://");
  });
});

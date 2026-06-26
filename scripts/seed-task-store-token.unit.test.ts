/**
 * scripts/seed-task-store-token.unit.test.ts
 * Unit tests for the local-dev task-store admin-token seeder.
 *
 * Pure helpers (hashRawToken, parseSeedArgs) and the upsert shape are tested via
 * an injected prisma double — no real DB, no network. The seeder is only ever run
 * by `task stack` against the local task-store DB; it is never part of a deployed
 * stack.
 */

import { describe, expect, test } from "bun:test";
import {
  hashRawToken,
  parseSeedArgs,
  seedTaskStoreAdminToken,
} from "./seed-task-store-token.ts";

describe("hashRawToken", () => {
  test("is a stable SHA-256 hex digest (known vector)", () => {
    // sha256("abc") — locks the algorithm against drift from token-service.ts.
    expect(hashRawToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("is deterministic for the dev token", () => {
    expect(hashRawToken("dev-task-store-admin-token")).toBe(
      hashRawToken("dev-task-store-admin-token"),
    );
  });
});

describe("parseSeedArgs", () => {
  test("parses --db-url and --token in space form", () => {
    expect(
      parseSeedArgs(["--db-url", "postgresql://x/y", "--token", "abc"]),
    ).toEqual({ dbUrl: "postgresql://x/y", token: "abc" });
  });

  test("parses --db-url= and --token= in equals form", () => {
    expect(
      parseSeedArgs(["--db-url=postgresql://x/y", "--token=abc"]),
    ).toEqual({ dbUrl: "postgresql://x/y", token: "abc" });
  });

  test("returns undefined fields when flags are absent", () => {
    expect(parseSeedArgs([])).toEqual({ dbUrl: undefined, token: undefined });
  });
});

describe("seedTaskStoreAdminToken", () => {
  function makePrismaDouble() {
    const calls: Array<Record<string, unknown>> = [];
    const prisma = {
      taskToken: {
        upsert: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { id: "tok_1" };
        },
      },
    };
    return { prisma, calls };
  }

  test("upserts an admin token (agentId null) keyed by the hashed raw value", async () => {
    const { prisma, calls } = makePrismaDouble();
    await seedTaskStoreAdminToken({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      prisma: prisma as any,
      rawToken: "dev-task-store-admin-token",
      label: "dev-admin",
    });

    expect(calls).toHaveLength(1);
    const args = calls[0];
    const hashed = hashRawToken("dev-task-store-admin-token");
    expect(args.where).toEqual({ token: hashed });
    expect(args.create).toEqual({
      token: hashed,
      label: "dev-admin",
      agentId: null,
    });
    // Empty update => idempotent: re-running leaves an existing token untouched.
    expect(args.update).toEqual({});
  });
});

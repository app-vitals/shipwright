/**
 * scripts/seed-task-store-token.unit.test.ts
 * Unit tests for the local-dev task-store admin-token seeder.
 *
 * Pure helpers (hashRawToken) and the upsert shape are tested via an injected
 * prisma double — no real DB, no network. The seeder is only ever run by
 * `task stack` against the local task-store DB; it is never part of a
 * deployed stack.
 *
 * Flag parsing itself is covered by lib/cli-flags.unit.test.ts; this file
 * only asserts that the flag-name mapping this script relies on
 * (--db-url/--token/--agent-id, both `--flag value` and `--flag=value` forms)
 * resolves the way the CLI entrypoint expects.
 */

import { describe, expect, test } from "bun:test";
import { parseFlags } from "../lib/cli-flags.ts";
import { hashRawToken, seedTaskStoreAdminToken } from "./seed-task-store-token.ts";

const SEED_TOKEN_FLAGS = ["--db-url", "--token", "--agent-id"] as const;

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

describe("parseFlags — seed-task-store-token's flag mapping", () => {
  test("parses --db-url and --token in space form", () => {
    const result = parseFlags(
      ["--db-url", "postgresql://x/y", "--token", "abc"],
      SEED_TOKEN_FLAGS,
    );
    expect(result["--db-url"]).toBe("postgresql://x/y");
    expect(result["--token"]).toBe("abc");
    expect(result["--agent-id"]).toBeUndefined();
  });

  test("parses --db-url= and --token= in equals form", () => {
    const result = parseFlags(
      ["--db-url=postgresql://x/y", "--token=abc"],
      SEED_TOKEN_FLAGS,
    );
    expect(result["--db-url"]).toBe("postgresql://x/y");
    expect(result["--token"]).toBe("abc");
    expect(result["--agent-id"]).toBeUndefined();
  });

  test("returns undefined fields when flags are absent", () => {
    const result = parseFlags([], SEED_TOKEN_FLAGS);
    expect(result["--db-url"]).toBeUndefined();
    expect(result["--token"]).toBeUndefined();
    expect(result["--agent-id"]).toBeUndefined();
  });

  test("parses --agent-id in space form", () => {
    const result = parseFlags(
      [
        "--db-url",
        "postgresql://x/y",
        "--token",
        "abc",
        "--agent-id",
        "hitl",
      ],
      SEED_TOKEN_FLAGS,
    );
    expect(result["--db-url"]).toBe("postgresql://x/y");
    expect(result["--token"]).toBe("abc");
    expect(result["--agent-id"]).toBe("hitl");
  });

  test("parses --agent-id= in equals form", () => {
    const result = parseFlags(
      ["--token=abc", "--agent-id=hitl"],
      SEED_TOKEN_FLAGS,
    );
    expect(result["--db-url"]).toBeUndefined();
    expect(result["--token"]).toBe("abc");
    expect(result["--agent-id"]).toBe("hitl");
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

  test("upserts an agent-scoped token (agentId set) keyed by the hashed raw value", async () => {
    const { prisma, calls } = makePrismaDouble();
    await seedTaskStoreAdminToken({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      prisma: prisma as any,
      rawToken: "dev-task-store-hitl-token",
      label: "dev-hitl",
      agentId: "hitl",
    });

    expect(calls).toHaveLength(1);
    const args = calls[0];
    const hashed = hashRawToken("dev-task-store-hitl-token");
    expect(args.where).toEqual({ token: hashed });
    expect(args.create).toEqual({
      token: hashed,
      label: "dev-hitl",
      agentId: "hitl",
    });
    expect(args.update).toEqual({});
  });
});

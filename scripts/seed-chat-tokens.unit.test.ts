/**
 * scripts/seed-chat-tokens.unit.test.ts
 * Unit tests for the local-dev chat-service token seeder.
 *
 * Pure helpers (hashRawToken, parseSeedArgs) and the upsert shape are tested
 * via an injected prisma double — no real DB, no network. The seeder is only
 * ever run by `task stack` against the local chat DB; it is never part of a
 * deployed stack.
 */

import { describe, expect, test } from "bun:test";
import {
  hashRawToken,
  parseSeedArgs,
  seedChatTokens,
} from "./seed-chat-tokens.ts";

describe("hashRawToken", () => {
  test("is a stable SHA-256 hex digest (known vector)", () => {
    // sha256("abc") — locks the algorithm against drift from chat/src/token-service.ts.
    expect(hashRawToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("is deterministic for the dev tokens", () => {
    expect(hashRawToken("dev-chat-admin-token")).toBe(
      hashRawToken("dev-chat-admin-token"),
    );
  });
});

describe("parseSeedArgs", () => {
  test("parses all flags in space form", () => {
    expect(
      parseSeedArgs([
        "--db-url",
        "postgresql://x/y",
        "--admin-token",
        "a",
        "--agent-token",
        "b",
        "--agent-id",
        "dev-agent",
      ]),
    ).toEqual({
      dbUrl: "postgresql://x/y",
      adminToken: "a",
      agentToken: "b",
      agentId: "dev-agent",
    });
  });

  test("parses all flags in equals form", () => {
    expect(
      parseSeedArgs([
        "--db-url=postgresql://x/y",
        "--admin-token=a",
        "--agent-token=b",
        "--agent-id=dev-agent",
      ]),
    ).toEqual({
      dbUrl: "postgresql://x/y",
      adminToken: "a",
      agentToken: "b",
      agentId: "dev-agent",
    });
  });

  test("returns undefined fields when flags are absent", () => {
    expect(parseSeedArgs([])).toEqual({
      dbUrl: undefined,
      adminToken: undefined,
      agentToken: undefined,
      agentId: undefined,
    });
  });
});

describe("seedChatTokens", () => {
  function makePrismaDouble() {
    const calls: Array<Record<string, unknown>> = [];
    const prisma = {
      chatToken: {
        upsert: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { id: "tok_1" };
        },
      },
    };
    return { prisma, calls };
  }

  test("upserts an admin token (agentId null) and an agent-scoped token", async () => {
    const { prisma, calls } = makePrismaDouble();
    await seedChatTokens({
      // biome-ignore lint/suspicious/noExplicitAny: test double
      prisma: prisma as any,
      adminRawToken: "dev-chat-admin-token",
      agentRawToken: "dev-chat-agent-token",
      agentId: "dev-agent",
    });

    expect(calls).toHaveLength(2);

    const adminHashed = hashRawToken("dev-chat-admin-token");
    expect(calls[0].where).toEqual({ token: adminHashed });
    expect(calls[0].create).toEqual({
      token: adminHashed,
      label: "dev-admin",
      agentId: null,
    });
    expect(calls[0].update).toEqual({});

    const agentHashed = hashRawToken("dev-chat-agent-token");
    expect(calls[1].where).toEqual({ token: agentHashed });
    expect(calls[1].create).toEqual({
      token: agentHashed,
      label: "dev-agent (dev-agent)",
      agentId: "dev-agent",
    });
    // Empty update => idempotent: re-running leaves existing tokens untouched.
    expect(calls[1].update).toEqual({});
  });
});

/**
 * admin/src/agent-anthropic-identity.unit.test.ts
 * Unit tests for AgentAnthropicIdentityService — Prisma error mapping and
 * partial-update semantics against an injected prisma test double.
 */

import { describe, expect, it } from "bun:test";
import { AgentAnthropicIdentityService } from "./agent-anthropic-identity.ts";
import { ConflictError, NotFoundError } from "./errors.ts";

type Row = Record<string, string | null>;

function makeFakePrisma(opts: { row?: Row | null; updateError?: unknown }) {
  const calls: { update?: unknown } = {};
  const agent = {
    async findUnique() {
      return opts.row ?? null;
    },
    async update(args: { data: Row }) {
      calls.update = args;
      if (opts.updateError) throw opts.updateError;
      return { ...(opts.row ?? {}), ...args.data };
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal prisma double
  return { prisma: { agent } as any, calls };
}

const EMPTY = {
  ownerEmail: null,
  anthropicIdentityName: null,
  anthropicServiceAccountId: null,
  anthropicFederationRuleId: null,
  k8sServiceAccountName: null,
};

describe("AgentAnthropicIdentityService", () => {
  it("get() returns the five identity fields", async () => {
    const { prisma } = makeFakePrisma({ row: { ...EMPTY } });
    expect(await new AgentAnthropicIdentityService(prisma).get("a1")).toEqual(
      EMPTY,
    );
  });

  it("get() returns null for an unknown agent", async () => {
    const { prisma } = makeFakePrisma({ row: null });
    expect(await new AgentAnthropicIdentityService(prisma).get("x")).toBeNull();
  });

  it("set() only writes fields that are present", async () => {
    const { prisma, calls } = makeFakePrisma({ row: { ...EMPTY } });
    await new AgentAnthropicIdentityService(prisma).set("a1", {
      ownerEmail: "o@example.com",
    });
    expect((calls.update as { data: unknown }).data).toEqual({
      ownerEmail: "o@example.com",
    });
  });

  it("set() maps P2002 to ConflictError", async () => {
    const { prisma } = makeFakePrisma({ updateError: { code: "P2002" } });
    await expect(
      new AgentAnthropicIdentityService(prisma).set("a1", {
        anthropicIdentityName: "dup",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("set() maps P2025 to NotFoundError", async () => {
    const { prisma } = makeFakePrisma({ updateError: { code: "P2025" } });
    await expect(
      new AgentAnthropicIdentityService(prisma).set("nope", {
        ownerEmail: "x@example.com",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

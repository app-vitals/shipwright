/**
 * agent/src/agent-members.unit.test.ts
 * Unit tests for AgentMemberService (admin/src/agent-members.ts) — pure logic
 * against an injected prisma test double. No real DB — see docs/testing.md
 * for the unit-layer contract.
 */

import { describe, expect, it } from "bun:test";
import { AgentMemberService } from "./agent-members.ts";

// ─── In-memory prisma.agentMember test double ──────────────────────────────

interface FakeAgentMemberRow {
  id: string;
  agentId: string;
  email: string;
  createdAt: Date;
}

function makeFakePrisma(seed: FakeAgentMemberRow[] = []) {
  const rows = new Map<string, FakeAgentMemberRow>(seed.map((r) => [r.id, r]));
  let nextId = 1;

  const agentMember = {
    async findMany({
      where,
    }: {
      where?: { agentId?: string; email?: string };
    } = {}): Promise<FakeAgentMemberRow[]> {
      let all = Array.from(rows.values());
      if (where?.agentId !== undefined) {
        all = all.filter((r) => r.agentId === where.agentId);
      }
      if (where?.email !== undefined) {
        all = all.filter((r) => r.email === where.email);
      }
      return all;
    },
    async findUnique({
      where,
    }: {
      where: { agentId_email: { agentId: string; email: string } };
    }): Promise<FakeAgentMemberRow | null> {
      const { agentId, email } = where.agentId_email;
      const row = Array.from(rows.values()).find(
        (r) => r.agentId === agentId && r.email === email,
      );
      return row ?? null;
    },
    async create({
      data,
    }: {
      data: { agentId: string; email: string };
    }): Promise<FakeAgentMemberRow> {
      const existing = Array.from(rows.values()).find(
        (r) => r.agentId === data.agentId && r.email === data.email,
      );
      if (existing) {
        throw new Error(
          "Unique constraint failed on the fields: (`agentId`,`email`)",
        );
      }
      const row: FakeAgentMemberRow = {
        id: `member-${nextId++}`,
        agentId: data.agentId,
        email: data.email,
        createdAt: new Date("2024-01-01"),
      };
      rows.set(row.id, row);
      return row;
    },
    async deleteMany({
      where,
    }: {
      where: { id: string; agentId: string };
    }): Promise<{ count: number }> {
      const row = rows.get(where.id);
      if (row && row.agentId === where.agentId) {
        rows.delete(where.id);
        return { count: 1 };
      }
      return { count: 0 };
    },
  };

  return { agentMember, __rows: rows };
}

type FakePrisma = ReturnType<typeof makeFakePrisma>;

function seedRow(overrides: Partial<FakeAgentMemberRow> = {}): FakeAgentMemberRow {
  return {
    id: "member-existing",
    agentId: "agent-1",
    email: "person@example.com",
    createdAt: new Date("2024-01-01"),
    ...overrides,
  };
}

// ─── listByAgentId ──────────────────────────────────────────────────────────

describe("AgentMemberService.listByAgentId", () => {
  it("returns all memberships for the given agentId", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "m1", agentId: "agent-1", email: "a@example.com" }),
      seedRow({ id: "m2", agentId: "agent-1", email: "b@example.com" }),
      seedRow({ id: "m3", agentId: "agent-2", email: "c@example.com" }),
    ]) as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    const result = await service.listByAgentId("agent-1");

    expect(result.map((r) => r.email).sort()).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("returns an empty array when the agent has no memberships", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    expect(await service.listByAgentId("agent-1")).toEqual([]);
  });
});

// ─── listByEmail ────────────────────────────────────────────────────────────

describe("AgentMemberService.listByEmail", () => {
  it("returns all memberships for the given email, case-sensitive as stored", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "m1", agentId: "agent-1", email: "person@example.com" }),
      seedRow({ id: "m2", agentId: "agent-2", email: "person@example.com" }),
      seedRow({ id: "m3", agentId: "agent-3", email: "other@example.com" }),
    ]) as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    const result = await service.listByEmail("person@example.com");

    expect(result.map((r) => r.agentId).sort()).toEqual(["agent-1", "agent-2"]);
  });

  it("does not match on a differently-cased email", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "m1", agentId: "agent-1", email: "person@example.com" }),
    ]) as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    expect(await service.listByEmail("Person@example.com")).toEqual([]);
  });

  it("returns an empty array when no memberships match", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    expect(await service.listByEmail("nobody@example.com")).toEqual([]);
  });
});

// ─── exists ─────────────────────────────────────────────────────────────────

describe("AgentMemberService.exists", () => {
  it("returns true when a membership row exists for the agentId+email pair", async () => {
    const prisma = makeFakePrisma([
      seedRow({ agentId: "agent-1", email: "person@example.com" }),
    ]) as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    expect(await service.exists("agent-1", "person@example.com")).toBe(true);
  });

  it("returns false when no membership row exists for the pair", async () => {
    const prisma = makeFakePrisma([
      seedRow({ agentId: "agent-1", email: "person@example.com" }),
    ]) as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    expect(await service.exists("agent-1", "someone-else@example.com")).toBe(
      false,
    );
    expect(await service.exists("agent-2", "person@example.com")).toBe(false);
  });

  it("returns false when there are no memberships at all", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    expect(await service.exists("agent-1", "person@example.com")).toBe(false);
  });
});

// ─── add ────────────────────────────────────────────────────────────────────

describe("AgentMemberService.add", () => {
  it("creates a membership row for the given agentId and email", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    const row = await service.add("agent-1", "person@example.com");

    expect(row.agentId).toBe("agent-1");
    expect(row.email).toBe("person@example.com");
    expect(row.id).toBeDefined();
  });

  it("propagates a unique-constraint error when the membership already exists", async () => {
    const prisma = makeFakePrisma([
      seedRow({ agentId: "agent-1", email: "person@example.com" }),
    ]) as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    await expect(
      (async () => service.add("agent-1", "person@example.com"))(),
    ).rejects.toThrow();
  });
});

// ─── remove ─────────────────────────────────────────────────────────────────

describe("AgentMemberService.remove", () => {
  it("deletes a membership by id when scoped to the correct agentId", async () => {
    const row = seedRow({ id: "m1", agentId: "agent-1" });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    await service.remove("agent-1", "m1");

    expect(await service.listByAgentId("agent-1")).toEqual([]);
  });

  it("no-ops when the memberId does not exist", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    await service.remove("agent-1", "missing");

    expect(await service.listByAgentId("agent-1")).toEqual([]);
  });

  it("no-ops when the memberId exists but belongs to a different agentId", async () => {
    const row = seedRow({ id: "m1", agentId: "agent-1" });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentMemberService(prisma as never);

    await service.remove("agent-2", "m1");

    expect(await service.listByAgentId("agent-1")).toEqual([row]);
  });
});

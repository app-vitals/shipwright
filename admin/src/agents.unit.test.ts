/**
 * agent/src/agents.unit.test.ts
 * Unit tests for AgentService (admin/src/agents.ts) — pure logic against an
 * injected prisma test double. No real DB — see docs/testing.md for the
 * unit-layer contract.
 */

import { describe, expect, it } from "bun:test";
import { AgentService } from "./agents.ts";

// ─── In-memory prisma.agent test double ────────────────────────────────────

interface FakeAgentRow {
  id: string;
  name: string;
  slackId: string | null;
  selfHosted: boolean;
  repos: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Projects a row down to just the keys named in a Prisma-style `select` object. */
function applySelect<T extends object>(
  row: T,
  select?: Partial<Record<keyof T, boolean>>,
): T {
  if (!select) return row;
  const projected = {} as T;
  for (const key of Object.keys(select) as (keyof T)[]) {
    if (select[key]) projected[key] = row[key];
  }
  return projected;
}

function makeFakePrisma(seed: FakeAgentRow[] = []) {
  const rows = new Map<string, FakeAgentRow>(seed.map((r) => [r.id, r]));
  let nextId = 1;

  const agent = {
    async create({
      data,
    }: {
      data: { name: string; slackId: string | null; selfHosted: boolean };
    }): Promise<FakeAgentRow> {
      const row: FakeAgentRow = {
        id: `agent-${nextId++}`,
        name: data.name,
        slackId: data.slackId,
        selfHosted: data.selfHosted,
        repos: [],
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      };
      rows.set(row.id, row);
      return row;
    },
    async delete({
      where,
    }: {
      where: { id: string };
    }): Promise<FakeAgentRow> {
      const row = rows.get(where.id);
      if (!row) throw new Error("record not found");
      rows.delete(where.id);
      return row;
    },
    async findMany({
      select,
      orderBy,
      where,
    }: {
      select?: Partial<Record<keyof FakeAgentRow, boolean>>;
      orderBy?: { name?: "asc" | "desc" };
      where?: {
        id?: { in: string[] };
        name?: { contains: string; mode?: "insensitive" };
      };
    } = {}): Promise<FakeAgentRow[]> {
      let all = Array.from(rows.values());
      if (where?.id) {
        const ids = new Set(where.id.in);
        all = all.filter((r) => ids.has(r.id));
      }
      if (where?.name) {
        const { contains, mode } = where.name;
        all = all.filter((r) =>
          mode === "insensitive"
            ? r.name.toLowerCase().includes(contains.toLowerCase())
            : r.name.includes(contains),
        );
      }
      if (orderBy?.name) {
        all = [...all].sort((a, b) =>
          orderBy.name === "desc"
            ? b.name.localeCompare(a.name)
            : a.name.localeCompare(b.name),
        );
      }
      return all.map((r) => applySelect(r, select));
    },
    async findUnique({
      where,
      select,
    }: {
      where: { id: string };
      select?: Partial<Record<keyof FakeAgentRow, boolean>>;
    }): Promise<FakeAgentRow | null> {
      const row = rows.get(where.id);
      if (!row) return null;
      return applySelect(row, select);
    },
    async update({
      where,
      data,
      select,
    }: {
      where: { id: string };
      data: {
        name?: string;
        slackId?: string | null;
        selfHosted?: boolean;
        repos?: string[];
      };
      select?: Partial<Record<keyof FakeAgentRow, boolean>>;
    }): Promise<FakeAgentRow> {
      const row = rows.get(where.id);
      if (!row) throw new Error("record not found");
      const updated: FakeAgentRow = {
        ...row,
        ...(data.name !== undefined && { name: data.name }),
        ...(data.slackId !== undefined && { slackId: data.slackId }),
        ...(data.selfHosted !== undefined && { selfHosted: data.selfHosted }),
        ...(data.repos !== undefined && { repos: data.repos }),
        updatedAt: new Date("2024-01-02"),
      };
      rows.set(where.id, updated);
      return applySelect(updated, select);
    },
  };

  return { agent, __rows: rows };
}

type FakePrisma = ReturnType<typeof makeFakePrisma>;

function seedRow(overrides: Partial<FakeAgentRow> = {}): FakeAgentRow {
  return {
    id: "agent-existing",
    name: "Existing Agent",
    slackId: null,
    selfHosted: false,
    repos: [],
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

// ─── create ─────────────────────────────────────────────────────────────────

describe("AgentService.create", () => {
  it("creates an agent with the given name, slackId, and selfHosted flag", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const agent = await service.create({
      name: "New Agent",
      slackId: "U123",
      selfHosted: true,
    });

    expect(agent.name).toBe("New Agent");
    expect(agent.slackId).toBe("U123");
    expect(agent.selfHosted).toBe(true);
    expect(agent.id).toBeDefined();
  });

  it("defaults slackId to null and selfHosted to false when omitted", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const agent = await service.create({ name: "Plain Agent" });

    expect(agent.slackId).toBeNull();
    expect(agent.selfHosted).toBe(false);
  });
});

// ─── delete ─────────────────────────────────────────────────────────────────

describe("AgentService.delete", () => {
  it("deletes the agent row by id", async () => {
    const row = seedRow();
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    await service.delete(row.id);

    expect(await prisma.agent.findUnique({ where: { id: row.id } })).toBeNull();
  });
});

// ─── list ───────────────────────────────────────────────────────────────────

describe("AgentService.list", () => {
  it("returns id/name/selfHosted for all agents, ordered by name asc", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "a1", name: "Zeta", selfHosted: false }),
      seedRow({ id: "a2", name: "Alpha", selfHosted: true }),
    ]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const result = await service.list();

    expect(result).toEqual([
      { id: "a2", name: "Alpha", selfHosted: true },
      { id: "a1", name: "Zeta", selfHosted: false },
    ]);
  });

  it("returns an empty array when there are no agents", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.list()).toEqual([]);
  });
});

// ─── getSummary ─────────────────────────────────────────────────────────────

describe("AgentService.getSummary", () => {
  it("returns {id, name, selfHosted} for an existing agent", async () => {
    const row = seedRow({ id: "a1", name: "Existing", selfHosted: true });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.getSummary("a1")).toEqual({
      id: "a1",
      name: "Existing",
      selfHosted: true,
    });
  });

  it("returns null when the agent does not exist", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.getSummary("missing")).toBeNull();
  });
});

// ─── getDetail ──────────────────────────────────────────────────────────────

describe("AgentService.getDetail", () => {
  it("returns the full record including repos and timestamps", async () => {
    const row = seedRow({
      id: "a1",
      name: "Existing",
      slackId: "U999",
      repos: ["org/repo"],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const detail = await service.getDetail("a1");

    expect(detail).toEqual({
      id: "a1",
      name: "Existing",
      slackId: "U999",
      selfHosted: false,
      repos: ["org/repo"],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  it("returns null when the agent does not exist", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.getDetail("missing")).toBeNull();
  });
});

// ─── exists ─────────────────────────────────────────────────────────────────

describe("AgentService.exists", () => {
  it("returns true when the agent exists", async () => {
    const row = seedRow({ id: "a1" });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.exists("a1")).toBe(true);
  });

  it("returns false when the agent does not exist", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.exists("missing")).toBe(false);
  });
});

// ─── updateSelfHosted ───────────────────────────────────────────────────────

describe("AgentService.updateSelfHosted", () => {
  it("updates the selfHosted flag and returns the full record", async () => {
    const row = seedRow({ id: "a1", selfHosted: false });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const updated = await service.updateSelfHosted("a1", { selfHosted: true });

    expect(updated.selfHosted).toBe(true);
    expect(updated.id).toBe("a1");
  });

  it("updates repos when provided", async () => {
    const row = seedRow({ id: "a1", repos: [] });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const updated = await service.updateSelfHosted("a1", {
      selfHosted: false,
      repos: ["org/repo"],
    });

    expect(updated.repos).toEqual(["org/repo"]);
  });

  it("leaves repos untouched when not provided", async () => {
    const row = seedRow({ id: "a1", repos: ["org/existing"] });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const updated = await service.updateSelfHosted("a1", { selfHosted: true });

    expect(updated.repos).toEqual(["org/existing"]);
  });
});

// ─── getById ────────────────────────────────────────────────────────────────

describe("AgentService.getById", () => {
  it("returns {id, repos} for an existing agent", async () => {
    const row = seedRow({ id: "a1", repos: ["org/repo1", "org/repo2"] });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.getById("a1")).toEqual({
      id: "a1",
      repos: ["org/repo1", "org/repo2"],
    });
  });

  it("returns null when the agent does not exist", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.getById("missing")).toBeNull();
  });
});

// ─── listAll ────────────────────────────────────────────────────────────────

describe("AgentService.listAll", () => {
  it("returns every agent with all fields, no filtering", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "a1", name: "Zeta" }),
      seedRow({ id: "a2", name: "Alpha" }),
    ]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const result = await service.listAll();

    expect(result.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
    expect(result[0]).toHaveProperty("createdAt");
    expect(result[0]).toHaveProperty("slackId");
  });

  it("returns an empty array when there are no agents", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.listAll()).toEqual([]);
  });
});

// ─── listByIds ──────────────────────────────────────────────────────────────

describe("AgentService.listByIds", () => {
  it("returns only the agents matching the given ids", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "a1", name: "One" }),
      seedRow({ id: "a2", name: "Two" }),
      seedRow({ id: "a3", name: "Three" }),
    ]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const result = await service.listByIds(["a1", "a3"]);

    expect(result.map((r) => r.id).sort()).toEqual(["a1", "a3"]);
  });

  it("returns an empty array when no ids match", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "a1", name: "One" }),
    ]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.listByIds(["missing"])).toEqual([]);
  });

  it("returns an empty array when given an empty id list", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "a1", name: "One" }),
    ]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.listByIds([])).toEqual([]);
  });
});

// ─── searchByName ───────────────────────────────────────────────────────────

describe("AgentService.searchByName", () => {
  it("returns agents whose name contains the query, case-insensitive", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "a1", name: "Shipwright Bot" }),
      seedRow({ id: "a2", name: "Other Product Agent" }),
      seedRow({ id: "a3", name: "Other" }),
    ]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const result = await service.searchByName("ship");

    expect(result.map((r) => r.id)).toEqual(["a1"]);
  });

  it("returns an empty array when nothing matches", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "a1", name: "Shipwright Bot" }),
    ]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.searchByName("nomatch")).toEqual([]);
  });
});

// ─── listOptions ────────────────────────────────────────────────────────────

describe("AgentService.listOptions", () => {
  it("returns {id, name} for all agents, ordered by name asc", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "a1", name: "Zeta" }),
      seedRow({ id: "a2", name: "Alpha" }),
    ]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const result = await service.listOptions();

    expect(result).toEqual([
      { id: "a2", name: "Alpha" },
      { id: "a1", name: "Zeta" },
    ]);
  });

  it("returns an empty array when there are no agents", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.listOptions()).toEqual([]);
  });
});

// ─── updateFields ───────────────────────────────────────────────────────────

describe("AgentService.updateFields", () => {
  it("updates only the provided fields and returns the full detail record", async () => {
    const row = seedRow({
      id: "a1",
      name: "Old Name",
      slackId: "U000",
      selfHosted: false,
      repos: ["org/old"],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const updated = await service.updateFields("a1", { name: "New Name" });

    expect(updated.name).toBe("New Name");
    expect(updated.slackId).toBe("U000");
    expect(updated.selfHosted).toBe(false);
    expect(updated.repos).toEqual(["org/old"]);
  });

  it("updates repos when provided", async () => {
    const row = seedRow({ id: "a1", repos: [] });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const updated = await service.updateFields("a1", {
      repos: ["org/new-repo"],
    });

    expect(updated.repos).toEqual(["org/new-repo"]);
  });

  it("updates selfHosted when provided", async () => {
    const row = seedRow({ id: "a1", selfHosted: false });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const updated = await service.updateFields("a1", { selfHosted: true });

    expect(updated.selfHosted).toBe(true);
  });

  it("updates slackId to null when explicitly passed null", async () => {
    const row = seedRow({ id: "a1", slackId: "U123" });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const updated = await service.updateFields("a1", { slackId: null });

    expect(updated.slackId).toBeNull();
  });

  it("leaves fields untouched when not provided", async () => {
    const row = seedRow({
      id: "a1",
      name: "Untouched",
      slackId: "U999",
      selfHosted: true,
      repos: ["org/keep"],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const updated = await service.updateFields("a1", {});

    expect(updated).toEqual({
      id: "a1",
      name: "Untouched",
      slackId: "U999",
      selfHosted: true,
      repos: ["org/keep"],
      createdAt: row.createdAt,
      updatedAt: new Date("2024-01-02"),
    });
  });
});

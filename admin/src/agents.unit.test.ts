/**
 * agent/src/agents.unit.test.ts
 * Unit tests for AgentService (admin/src/agents.ts) — pure logic against an
 * injected prisma test double. No real DB — see docs/testing.md for the
 * unit-layer contract.
 */

import { describe, expect, it } from "bun:test";
import type { AgentMemberService } from "./agent-members.ts";
import type { AgentTypeManifestResolver } from "./agent-type-manifest-loader.ts";
import type { AgentTypeManifest } from "./agent-type-registry.ts";
import { AgentService } from "./agents.ts";

// ─── In-memory prisma.agent test double ────────────────────────────────────

interface FakeAgentRow {
  id: string;
  name: string;
  slackId: string | null;
  selfHosted: boolean;
  repos: string[];
  authorAllowlist: string[];
  /**
   * DBR-2.1: rename-in-progress twin of authorAllowlist — dual-written and
   * dual-read during the transitional phase (see agents.ts).
   */
  reviewAuthorAllowlist: string[];
  patchAuthorAllowlist: string[];
  restrictSlackToMembers: boolean;
  typeName: string;
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

/**
 * In-memory prisma.agentEnv.findMany double, keyed by agentId — only the
 * `key` column is ever selected by AgentService.getDetail(), mirroring the
 * production query that never touches AgentEnv.value (secrets_in_logs).
 */
function makeFakePrisma(
  seed: FakeAgentRow[] = [],
  envSeed: Record<string, string[]> = {},
  memberSeed: Record<
    string,
    { id: string; agentId: string; email: string; createdAt: Date }[]
  > = {},
) {
  const rows = new Map<string, FakeAgentRow>(seed.map((r) => [r.id, r]));
  let nextId = 1;

  const agent = {
    async create({
      data,
    }: {
      data: {
        name: string;
        slackId: string | null;
        selfHosted: boolean;
        repos?: string[];
        authorAllowlist?: string[];
        reviewAuthorAllowlist?: string[];
        patchAuthorAllowlist?: string[];
        restrictSlackToMembers?: boolean;
      };
    }): Promise<FakeAgentRow> {
      const row: FakeAgentRow = {
        id: `agent-${nextId++}`,
        name: data.name,
        slackId: data.slackId,
        selfHosted: data.selfHosted,
        repos: data.repos ?? [],
        authorAllowlist: data.authorAllowlist ?? [],
        reviewAuthorAllowlist: data.reviewAuthorAllowlist ?? [],
        patchAuthorAllowlist: data.patchAuthorAllowlist ?? [],
        restrictSlackToMembers: data.restrictSlackToMembers ?? false,
        typeName: "coding",
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
        authorAllowlist?: string[];
        reviewAuthorAllowlist?: string[];
        patchAuthorAllowlist?: string[];
        restrictSlackToMembers?: boolean;
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
        ...(data.authorAllowlist !== undefined && {
          authorAllowlist: data.authorAllowlist,
        }),
        ...(data.reviewAuthorAllowlist !== undefined && {
          reviewAuthorAllowlist: data.reviewAuthorAllowlist,
        }),
        ...(data.patchAuthorAllowlist !== undefined && {
          patchAuthorAllowlist: data.patchAuthorAllowlist,
        }),
        ...(data.restrictSlackToMembers !== undefined && {
          restrictSlackToMembers: data.restrictSlackToMembers,
        }),
        updatedAt: new Date("2024-01-02"),
      };
      rows.set(where.id, updated);
      return applySelect(updated, select);
    },
  };

  const agentEnv = {
    async findMany({
      where,
    }: {
      where: { agentId: string };
      select?: { key: true };
    }): Promise<{ key: string }[]> {
      const keys = envSeed[where.agentId] ?? [];
      return keys.map((key) => ({ key }));
    },
  };

  const agentMember = {
    async findMany({
      where,
    }: {
      where: { agentId: string };
    }): Promise<
      { id: string; agentId: string; email: string; createdAt: Date }[]
    > {
      return memberSeed[where.agentId] ?? [];
    },
  };

  return { agent, agentEnv, agentMember, __rows: rows };
}

type FakePrisma = ReturnType<typeof makeFakePrisma>;

/** A registry double that always returns a fixed manifest — mirrors the
 * fakeRegistry() pattern in agent-cron-jobs.unit.test.ts. */
function fakeRegistry(
  requiredEnvByType: Record<string, string[]>,
): AgentTypeManifestResolver {
  return {
    getManifest(typeName: string): AgentTypeManifest {
      const required = requiredEnvByType[typeName] ?? [];
      return {
        env: {
          required: required.map((key) => ({
            key,
            description: `${key} description`,
            secret: true,
          })),
          optional: [],
        },
      } as unknown as AgentTypeManifest;
    },
    tryGetManifest(typeName: string): AgentTypeManifest | undefined {
      if (!(typeName in requiredEnvByType)) return undefined;
      return this.getManifest(typeName);
    },
    listTypes() {
      return Object.keys(requiredEnvByType).map((name) => ({
        name,
        displayName: name,
      }));
    },
  };
}

function seedRow(overrides: Partial<FakeAgentRow> = {}): FakeAgentRow {
  return {
    id: "agent-existing",
    name: "Existing Agent",
    slackId: null,
    selfHosted: false,
    repos: [],
    authorAllowlist: [],
    reviewAuthorAllowlist: [],
    patchAuthorAllowlist: [],
    restrictSlackToMembers: false,
    typeName: "coding",
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

  it("creates an agent with the given authorAllowlist", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const agent = await service.create({
      name: "New Agent",
      authorAllowlist: ["octocat", "hubot"],
    });

    expect(agent.authorAllowlist).toEqual(["octocat", "hubot"]);
  });

  it("defaults authorAllowlist to an empty array when omitted", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const agent = await service.create({ name: "Plain Agent" });

    expect(agent.authorAllowlist).toEqual([]);
  });

  it("dual-writes reviewAuthorAllowlist to match authorAllowlist on create", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const agent = await service.create({
      name: "New Agent",
      authorAllowlist: ["octocat", "hubot"],
    });

    expect(agent.reviewAuthorAllowlist).toEqual(["octocat", "hubot"]);
  });

  it("defaults reviewAuthorAllowlist to an empty array when omitted", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const agent = await service.create({ name: "Plain Agent" });

    expect(agent.reviewAuthorAllowlist).toEqual([]);
  });

  it("lists a required env key in missingRequiredEnv for a freshly created agent (no AgentEnv rows yet)", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(
      prisma as never,
      fakeRegistry({ coding: ["CLAUDE_CODE_OAUTH_TOKEN"] }),
    );

    const agent = await service.create({ name: "New Agent" });

    expect(agent.missingRequiredEnv).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("returns an empty missingRequiredEnv array (not undefined/null) when the type's required contract is empty", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(
      prisma as never,
      fakeRegistry({ coding: [] }),
    );

    const agent = await service.create({ name: "New Agent" });

    expect(agent.missingRequiredEnv).toEqual([]);
    expect(agent.missingRequiredEnv).not.toBeUndefined();
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
  it("returns id/name/selfHosted/typeName for all agents, ordered by name asc", async () => {
    const prisma = makeFakePrisma([
      seedRow({ id: "a1", name: "Zeta", selfHosted: false }),
      seedRow({ id: "a2", name: "Alpha", selfHosted: true }),
    ]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const result = await service.list();

    expect(result).toEqual([
      { id: "a2", name: "Alpha", selfHosted: true, typeName: "coding" },
      { id: "a1", name: "Zeta", selfHosted: false, typeName: "coding" },
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
  it("returns {id, name, selfHosted, typeName} for an existing agent", async () => {
    const row = seedRow({ id: "a1", name: "Existing", selfHosted: true });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.getSummary("a1")).toEqual({
      id: "a1",
      name: "Existing",
      selfHosted: true,
      typeName: "coding",
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
  it("returns the full record including repos, typeName, timestamps, and an empty missingRequiredEnv when the type has no required contract", async () => {
    const row = seedRow({
      id: "a1",
      name: "Existing",
      slackId: "U999",
      repos: ["org/repo"],
      authorAllowlist: ["octocat"],
      reviewAuthorAllowlist: ["octocat"],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(
      prisma as never,
      fakeRegistry({ coding: [] }),
    );

    const detail = await service.getDetail("a1");

    expect(detail).toEqual({
      id: "a1",
      name: "Existing",
      slackId: "U999",
      selfHosted: false,
      repos: ["org/repo"],
      authorAllowlist: ["octocat"],
      reviewAuthorAllowlist: ["octocat"],
      patchAuthorAllowlist: [],
      restrictSlackToMembers: false,
      typeName: "coding",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      missingRequiredEnv: [],
    });
  });

  it("defaults typeName to 'coding' when the row was seeded without an explicit value", async () => {
    const row = seedRow({ id: "a1" });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(
      prisma as never,
      fakeRegistry({ coding: [] }),
    );

    const detail = await service.getDetail("a1");

    expect(detail?.typeName).toBe("coding");
  });

  it("returns null when the agent does not exist", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    expect(await service.getDetail("missing")).toBeNull();
  });

  it("lists a required env key in missingRequiredEnv when no AgentEnv row exists for it", async () => {
    const row = seedRow({ id: "a1", typeName: "coding" });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(
      prisma as never,
      fakeRegistry({ coding: ["CLAUDE_CODE_OAUTH_TOKEN"] }),
    );

    const detail = await service.getDetail("a1");

    expect(detail?.missingRequiredEnv).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("clears a required key from missingRequiredEnv once its AgentEnv row is seeded", async () => {
    const row = seedRow({ id: "a1", typeName: "coding" });
    const prisma = makeFakePrisma([row], {
      a1: ["CLAUDE_CODE_OAUTH_TOKEN"],
    }) as unknown as FakePrisma;
    const service = new AgentService(
      prisma as never,
      fakeRegistry({ coding: ["CLAUDE_CODE_OAUTH_TOKEN"] }),
    );

    const detail = await service.getDetail("a1");

    expect(detail?.missingRequiredEnv).toEqual([]);
  });

  it("returns an empty missingRequiredEnv array (not undefined/null) when the manifest's required contract is empty, without querying AgentEnv", async () => {
    const row = seedRow({ id: "a1", typeName: "coding" });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    let findManyCalled = false;
    const originalFindMany = prisma.agentEnv.findMany.bind(prisma.agentEnv);
    prisma.agentEnv.findMany = (async (args: never) => {
      findManyCalled = true;
      return originalFindMany(args);
    }) as typeof prisma.agentEnv.findMany;
    const service = new AgentService(
      prisma as never,
      fakeRegistry({ coding: [] }),
    );

    const detail = await service.getDetail("a1");

    expect(detail?.missingRequiredEnv).toEqual([]);
    expect(detail?.missingRequiredEnv).not.toBeUndefined();
    expect(findManyCalled).toBe(false);
  });

  it("never includes AgentEnv values in the computed result — only key names are read", async () => {
    const row = seedRow({ id: "a1", typeName: "coding" });
    const prisma = makeFakePrisma([row], {
      a1: ["CLAUDE_CODE_OAUTH_TOKEN"],
    }) as unknown as FakePrisma;
    const service = new AgentService(
      prisma as never,
      fakeRegistry({ coding: ["CLAUDE_CODE_OAUTH_TOKEN"] }),
    );

    const detail = await service.getDetail("a1");

    expect(JSON.stringify(detail)).not.toContain("value");
    expect(detail?.missingRequiredEnv).toEqual([]);
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
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateSelfHosted("a1", { selfHosted: true });

    expect(updated.selfHosted).toBe(true);
    expect(updated.id).toBe("a1");
  });

  it("updates repos when provided", async () => {
    const row = seedRow({ id: "a1", repos: [] });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateSelfHosted("a1", {
      selfHosted: false,
      repos: ["org/repo"],
    });

    expect(updated.repos).toEqual(["org/repo"]);
  });

  it("leaves repos untouched when not provided", async () => {
    const row = seedRow({ id: "a1", repos: ["org/existing"] });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateSelfHosted("a1", { selfHosted: true });

    expect(updated.repos).toEqual(["org/existing"]);
  });

  it("updates authorAllowlist when provided", async () => {
    const row = seedRow({ id: "a1", authorAllowlist: [] });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateSelfHosted("a1", {
      selfHosted: false,
      authorAllowlist: ["octocat"],
    });

    expect(updated.authorAllowlist).toEqual(["octocat"]);
  });

  it("leaves authorAllowlist untouched when not provided", async () => {
    const row = seedRow({ id: "a1", authorAllowlist: ["octocat"] });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateSelfHosted("a1", { selfHosted: true });

    expect(updated.authorAllowlist).toEqual(["octocat"]);
  });

  it("dual-writes reviewAuthorAllowlist when only authorAllowlist is provided", async () => {
    const row = seedRow({
      id: "a1",
      authorAllowlist: [],
      reviewAuthorAllowlist: [],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateSelfHosted("a1", {
      selfHosted: false,
      authorAllowlist: ["octocat"],
    });

    expect(updated.authorAllowlist).toEqual(["octocat"]);
    expect(updated.reviewAuthorAllowlist).toEqual(["octocat"]);
  });

  it("dual-writes authorAllowlist when only reviewAuthorAllowlist is provided", async () => {
    const row = seedRow({
      id: "a1",
      authorAllowlist: [],
      reviewAuthorAllowlist: [],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateSelfHosted("a1", {
      selfHosted: false,
      reviewAuthorAllowlist: ["octocat"],
    });

    expect(updated.authorAllowlist).toEqual(["octocat"]);
    expect(updated.reviewAuthorAllowlist).toEqual(["octocat"]);
  });

  it("leaves reviewAuthorAllowlist untouched when neither field is provided", async () => {
    const row = seedRow({
      id: "a1",
      authorAllowlist: ["octocat"],
      reviewAuthorAllowlist: ["octocat"],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateSelfHosted("a1", { selfHosted: true });

    expect(updated.reviewAuthorAllowlist).toEqual(["octocat"]);
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
      authorAllowlist: [],
      reviewAuthorAllowlist: [],
      patchAuthorAllowlist: [],
      restrictSlackToMembers: false,
      memberEmails: [],
    });
  });

  it("returns null when the agent does not exist", async () => {
    const prisma = makeFakePrisma() as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.getById("missing")).toBeNull();
  });

  it("includes authorAllowlist for the runtime config lookup", async () => {
    const row = seedRow({
      id: "a1",
      repos: ["org/repo1"],
      authorAllowlist: ["octocat", "hubot"],
      reviewAuthorAllowlist: ["octocat", "hubot"],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    expect(await service.getById("a1")).toEqual({
      id: "a1",
      repos: ["org/repo1"],
      authorAllowlist: ["octocat", "hubot"],
      reviewAuthorAllowlist: ["octocat", "hubot"],
      patchAuthorAllowlist: [],
      restrictSlackToMembers: false,
      memberEmails: [],
    });
  });

  it("includes reviewAuthorAllowlist for the runtime config lookup, returned as an identical array to authorAllowlist", async () => {
    const row = seedRow({
      id: "a1",
      repos: ["org/repo1"],
      authorAllowlist: ["octocat"],
      reviewAuthorAllowlist: ["octocat"],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const result = await service.getById("a1");

    expect(result?.reviewAuthorAllowlist).toEqual(result?.authorAllowlist);
    expect(result?.reviewAuthorAllowlist).toEqual(["octocat"]);
  });

  it("includes memberEmails scoped to the agent, excluding other agents' members", async () => {
    const row = seedRow({ id: "a1", repos: ["org/repo1"] });
    const otherRow = seedRow({ id: "a2", repos: [] });
    const prisma = makeFakePrisma([row, otherRow], undefined, {
      a1: [
        {
          id: "member-1",
          agentId: "a1",
          email: "dev@example.com",
          createdAt: new Date("2024-01-01"),
        },
        {
          id: "member-2",
          agentId: "a1",
          email: "ops@example.com",
          createdAt: new Date("2024-01-01"),
        },
      ],
      a2: [
        {
          id: "member-3",
          agentId: "a2",
          email: "other@example.com",
          createdAt: new Date("2024-01-01"),
        },
      ],
    }) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const result = await service.getById("a1");

    expect(result?.memberEmails).toEqual([
      "dev@example.com",
      "ops@example.com",
    ]);
  });

  it("returns restrictSlackToMembers: true when set on the seeded row", async () => {
    const row = seedRow({
      id: "a1",
      repos: ["org/repo1"],
      restrictSlackToMembers: true,
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never);

    const result = await service.getById("a1");

    expect(result?.restrictSlackToMembers).toBe(true);
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
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateFields("a1", { name: "New Name" });

    expect(updated.name).toBe("New Name");
    expect(updated.slackId).toBe("U000");
    expect(updated.selfHosted).toBe(false);
    expect(updated.repos).toEqual(["org/old"]);
  });

  it("updates repos when provided", async () => {
    const row = seedRow({ id: "a1", repos: [] });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateFields("a1", {
      repos: ["org/new-repo"],
    });

    expect(updated.repos).toEqual(["org/new-repo"]);
  });

  it("updates authorAllowlist when provided", async () => {
    const row = seedRow({ id: "a1", authorAllowlist: [] });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateFields("a1", {
      authorAllowlist: ["octocat"],
    });

    expect(updated.authorAllowlist).toEqual(["octocat"]);
  });

  it("updates selfHosted when provided", async () => {
    const row = seedRow({ id: "a1", selfHosted: false });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateFields("a1", { selfHosted: true });

    expect(updated.selfHosted).toBe(true);
  });

  it("updates slackId to null when explicitly passed null", async () => {
    const row = seedRow({ id: "a1", slackId: "U123" });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

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
      authorAllowlist: ["octocat"],
      reviewAuthorAllowlist: ["octocat"],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(
      prisma as never,
      fakeRegistry({ coding: [] }),
    );

    const updated = await service.updateFields("a1", {});

    expect(updated).toEqual({
      id: "a1",
      name: "Untouched",
      slackId: "U999",
      selfHosted: true,
      repos: ["org/keep"],
      authorAllowlist: ["octocat"],
      reviewAuthorAllowlist: ["octocat"],
      patchAuthorAllowlist: [],
      restrictSlackToMembers: false,
      typeName: "coding",
      createdAt: row.createdAt,
      updatedAt: new Date("2024-01-02"),
      missingRequiredEnv: [],
    });
  });

  it("dual-writes reviewAuthorAllowlist when only authorAllowlist is provided", async () => {
    const row = seedRow({
      id: "a1",
      authorAllowlist: [],
      reviewAuthorAllowlist: [],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateFields("a1", {
      authorAllowlist: ["octocat"],
    });

    expect(updated.authorAllowlist).toEqual(["octocat"]);
    expect(updated.reviewAuthorAllowlist).toEqual(["octocat"]);
  });

  it("dual-writes authorAllowlist when only reviewAuthorAllowlist is provided", async () => {
    const row = seedRow({
      id: "a1",
      authorAllowlist: [],
      reviewAuthorAllowlist: [],
    });
    const prisma = makeFakePrisma([row]) as unknown as FakePrisma;
    const service = new AgentService(prisma as never, fakeRegistry({}));

    const updated = await service.updateFields("a1", {
      reviewAuthorAllowlist: ["octocat"],
    });

    expect(updated.authorAllowlist).toEqual(["octocat"]);
    expect(updated.reviewAuthorAllowlist).toEqual(["octocat"]);
  });
});

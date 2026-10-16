/**
 * Unit tests for agent-cron-jobs.ts:
 *   - the pure cron-expression validator (isValidCron)
 *   - reconcileSystemCrons()'s create/update/orphan/parent-link logic, driven
 *     by an injected AgentTypeManifestResolver double and an in-memory prisma
 *     test double (no real DB, no filesystem).
 *
 * Pure logic against injected doubles — see docs/testing.md for the unit-layer
 * contract.
 */
import { describe, expect, test } from "bun:test";
import type { AgentCronJob, PrismaClient } from "../prisma/client/client.ts";
import { AgentCronJobService, isValidCron } from "./agent-cron-jobs.ts";
import type { AgentTypeManifestResolver } from "./agent-type-manifest-loader.ts";
import type { AgentTypeManifest } from "./agent-type-registry.ts";

describe("isValidCron", () => {
  test("accepts standard 5-field schedules", () => {
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("0 4 * * 1")).toBe(true);
  });

  // The staggered pipeline schedules use comma-separated minute lists like
  // "0,30" to keep a 30-minute cadence while firing at a distinct offset from
  // sibling crons. Confirm the validator accepts them.
  test("accepts comma-separated minute lists", () => {
    expect(isValidCron("0,30 * * * *")).toBe(true);
    expect(isValidCron("5,35 * * * *")).toBe(true);
    expect(isValidCron("10,40 * * * *")).toBe(true);
    expect(isValidCron("15,45 * * * *")).toBe(true);
    expect(isValidCron("20,50 * * * *")).toBe(true);
  });

  test("accepts comma lists in other fields", () => {
    expect(isValidCron("0 9 * * 1,3,5")).toBe(true);
    expect(isValidCron("0 9,17 * * *")).toBe(true);
  });

  test("rejects schedules without exactly 5 fields", () => {
    expect(isValidCron("0 9 * *")).toBe(false);
    expect(isValidCron("0 9 * * * *")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });

  test("rejects non-cron garbage", () => {
    expect(isValidCron("not-a-cron")).toBe(false);
    expect(isValidCron("bad")).toBe(false);
  });
});

// ─── reconcileSystemCrons() with injected registry + fake prisma ────────────

type ManifestCron = AgentTypeManifest["crons"][number];

/** Build a minimal valid-enough manifest carrying just the crons we care about. */
function manifestWithCrons(crons: ManifestCron[]): AgentTypeManifest {
  return { crons } as unknown as AgentTypeManifest;
}

/** A registry double that always returns a fixed manifest and records lookups. */
function fakeRegistry(
  byType: Record<string, ManifestCron[]>,
  fallbackType = "coding",
): AgentTypeManifestResolver & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    getManifest(typeName: string): AgentTypeManifest {
      lookups.push(typeName);
      const crons = byType[typeName] ?? byType[fallbackType];
      if (!crons) throw new Error(`no manifest for ${typeName}`);
      return manifestWithCrons(crons);
    },
    tryGetManifest(typeName: string): AgentTypeManifest | undefined {
      lookups.push(typeName);
      const crons = byType[typeName];
      return crons ? manifestWithCrons(crons) : undefined;
    },
    listTypes() {
      return Object.keys(byType).map((name) => ({ name, displayName: name }));
    },
  };
}

type FakeCronRow = AgentCronJob;

/**
 * In-memory prisma double covering only what reconcileSystemCrons() touches:
 *   agent.findUnique (typeName resolution),
 *   agentCronJob.findMany, and a $transaction exposing
 *   agentCronJob.{create,update,delete}.
 */
function makeFakePrisma(opts: {
  typeName: string;
  existing?: Partial<FakeCronRow>[];
}) {
  let nextId = 1;
  const rows = new Map<string, FakeCronRow>();
  for (const seed of opts.existing ?? []) {
    const id = seed.id ?? `existing-${nextId++}`;
    rows.set(id, {
      id,
      agentId: "agent-1",
      name: null,
      schedule: "* * * * *",
      prompt: "",
      channel: null,
      user: null,
      silent: false,
      enabled: true,
      preCheck: null,
      system: true,
      parentCronId: null,
      lockdownDisabledAt: null,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      ...seed,
    } as FakeCronRow);
  }

  const agentCronJob = {
    async findMany({
      where,
    }: {
      where?: { agentId?: string; system?: boolean };
    } = {}): Promise<FakeCronRow[]> {
      return Array.from(rows.values()).filter((r) => {
        if (where?.agentId !== undefined && r.agentId !== where.agentId)
          return false;
        if (where?.system !== undefined && r.system !== where.system)
          return false;
        return true;
      });
    },
    async create({
      data,
    }: { data: Partial<FakeCronRow> }): Promise<FakeCronRow> {
      const id = `created-${nextId++}`;
      const row = {
        id,
        agentId: "agent-1",
        name: null,
        schedule: "* * * * *",
        prompt: "",
        channel: null,
        user: null,
        silent: false,
        enabled: true,
        preCheck: null,
        system: true,
        parentCronId: null,
        lockdownDisabledAt: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        ...data,
      } as FakeCronRow;
      rows.set(id, row);
      return row;
    },
    async update({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<FakeCronRow>;
    }): Promise<FakeCronRow> {
      const row = rows.get(where.id);
      if (!row) throw new Error(`no row ${where.id}`);
      const next = { ...row, ...data } as FakeCronRow;
      rows.set(where.id, next);
      return next;
    },
    async delete({ where }: { where: { id: string } }): Promise<FakeCronRow> {
      const row = rows.get(where.id);
      if (!row) throw new Error(`no row ${where.id}`);
      rows.delete(where.id);
      return row;
    },
  };

  const agent = {
    async findUnique({
      where,
    }: {
      where: { id: string };
    }): Promise<{ typeName: string } | null> {
      return where.id === "agent-1" ? { typeName: opts.typeName } : null;
    },
  };

  const prisma = {
    agent,
    agentCronJob,
    async $transaction<T>(
      fn: (tx: { agentCronJob: typeof agentCronJob }) => Promise<T>,
    ): Promise<T> {
      return fn({ agentCronJob });
    },
  };

  return { prisma, rows };
}

const loopCron: ManifestCron = {
  name: "shipwright-loop",
  schedule: "* * * * *",
  prompt: "internal",
  silent: true,
  enabled: false,
};

const childCron: ManifestCron = {
  name: "shipwright-dev-task",
  schedule: "* * * * *",
  prompt: "/shipwright:dev-task",
  silent: true,
  enabled: true,
  parentCron: "shipwright-loop",
};

describe("reconcileSystemCrons (unit, injected registry)", () => {
  test("resolves the agent's typeName via the injected registry", async () => {
    const registry = fakeRegistry({ coding: [loopCron] });
    const { prisma } = makeFakePrisma({ typeName: "coding" });
    const service = new AgentCronJobService(
      prisma as unknown as PrismaClient,
      undefined,
      registry,
    );

    await service.reconcileSystemCrons("agent-1");

    expect(registry.lookups).toEqual(["coding"]);
  });

  test("creates one row per manifest cron on a fresh agent", async () => {
    const registry = fakeRegistry({ coding: [loopCron, childCron] });
    const { prisma, rows } = makeFakePrisma({ typeName: "coding" });
    const service = new AgentCronJobService(
      prisma as unknown as PrismaClient,
      undefined,
      registry,
    );

    const result = await service.reconcileSystemCrons("agent-1");

    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    const names = Array.from(rows.values())
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(["shipwright-dev-task", "shipwright-loop"]);
  });

  test("links a child cron to its parent on first reconcile", async () => {
    const registry = fakeRegistry({ coding: [childCron, loopCron] });
    const { prisma, rows } = makeFakePrisma({ typeName: "coding" });
    const service = new AgentCronJobService(
      prisma as unknown as PrismaClient,
      undefined,
      registry,
    );

    await service.reconcileSystemCrons("agent-1");

    const all = Array.from(rows.values());
    const loop = all.find((r) => r.name === "shipwright-loop");
    const child = all.find((r) => r.name === "shipwright-dev-task");
    expect(child?.parentCronId).toBe(loop?.id as string);
    expect(loop?.parentCronId).toBeNull();
  });

  test("updates a matching existing row in place, preserving its id", async () => {
    const registry = fakeRegistry({ coding: [loopCron] });
    const { prisma, rows } = makeFakePrisma({
      typeName: "coding",
      existing: [{ id: "stable-id", name: "shipwright-loop", enabled: false }],
    });
    const service = new AgentCronJobService(
      prisma as unknown as PrismaClient,
      undefined,
      registry,
    );

    const result = await service.reconcileSystemCrons("agent-1");

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    expect(rows.has("stable-id")).toBe(true);
  });

  test("orphan pass deletes a system cron absent from the manifest", async () => {
    const registry = fakeRegistry({ coding: [loopCron] });
    const { prisma, rows } = makeFakePrisma({
      typeName: "coding",
      existing: [{ id: "orphan", name: "removed-cron" }],
    });
    const service = new AgentCronJobService(
      prisma as unknown as PrismaClient,
      undefined,
      registry,
    );

    const result = await service.reconcileSystemCrons("agent-1");

    expect(result.deleted).toBe(1);
    expect(rows.has("orphan")).toBe(false);
  });

  test("clears a stale parentCronId when the entry no longer declares a resolvable parent", async () => {
    const registry = fakeRegistry({ coding: [loopCron] });
    const { prisma, rows } = makeFakePrisma({
      typeName: "coding",
      existing: [
        {
          id: "loop-id",
          name: "shipwright-loop",
          parentCronId: "some-old-parent",
        },
      ],
    });
    const service = new AgentCronJobService(
      prisma as unknown as PrismaClient,
      undefined,
      registry,
    );

    await service.reconcileSystemCrons("agent-1");

    expect(rows.get("loop-id")?.parentCronId).toBeNull();
  });

  test("an unknown non-coding typeName logs an error and changes nothing", async () => {
    const registry = fakeRegistry({ coding: [loopCron] });
    const { prisma, rows } = makeFakePrisma({
      typeName: "specialist",
      existing: [
        { id: "sys-1", name: "old-system", system: true },
        { id: "user-1", name: "mine", system: false },
      ],
    });
    const service = new AgentCronJobService(
      prisma as unknown as PrismaClient,
      undefined,
      registry,
    );
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    let result: Awaited<ReturnType<typeof service.reconcileSystemCrons>>;
    try {
      result = await service.reconcileSystemCrons("agent-1");
    } finally {
      console.error = original;
    }

    expect(result).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect(Array.from(rows.keys()).sort()).toEqual(["sys-1", "user-1"]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.[0])).toContain("specialist");
    expect(String(errors[0]?.[0])).toContain("agent-1");
  });

  test("a coding manifest that cannot load still throws", async () => {
    const registry = fakeRegistry({});
    const { prisma } = makeFakePrisma({ typeName: "coding" });
    const service = new AgentCronJobService(
      prisma as unknown as PrismaClient,
      undefined,
      registry,
    );

    await expect(service.reconcileSystemCrons("agent-1")).rejects.toThrow(
      /coding/,
    );
  });

  test("a valid non-coding manifest reconciles normally", async () => {
    const registry = fakeRegistry({ specialist: [loopCron] });
    const { prisma, rows } = makeFakePrisma({ typeName: "specialist" });
    const service = new AgentCronJobService(
      prisma as unknown as PrismaClient,
      undefined,
      registry,
    );

    const result = await service.reconcileSystemCrons("agent-1");

    expect(result.created).toBe(1);
    expect(registry.lookups).toEqual(["specialist"]);
    expect(Array.from(rows.values())[0]?.name).toBe("shipwright-loop");
  });
});

/**
 * scripts/wait-for-agent.unit.test.ts
 * Unit tests for scripts/wait-for-agent.ts — the poll loop that replaces
 * implicit dev-agent seeding (ATS-6.1).
 *
 * Uses an injected Prisma double, an injected sleep (no real setInterval/
 * setTimeout wait), and injected stdout/stderr writers. No mock.module(), no
 * global overrides, no real DB or timers.
 */

import { describe, expect, it } from "bun:test";
import {
  type FoundAgent,
  type WaitDeps,
  waitForAgent,
} from "./wait-for-agent.ts";

// ─── Prisma double factory ────────────────────────────────────────────────────

function makePrismaDouble(sequence: (FoundAgent | null)[]) {
  const calls: unknown[] = [];
  let i = 0;
  const prisma = {
    agent: {
      findFirst: async (args: unknown) => {
        calls.push(args);
        const result = sequence[Math.min(i, sequence.length - 1)];
        i++;
        return result;
      },
    },
    $disconnect: async () => {},
  };
  return { prisma, calls, callCount: () => i };
}

function makeDeps(overrides: Partial<WaitDeps> = {}): {
  deps: WaitDeps;
  statusLines: string[];
  results: string[];
  sleepCalls: number[];
} {
  const statusLines: string[] = [];
  const results: string[] = [];
  const sleepCalls: number[] = [];
  const deps: WaitDeps = {
    prisma: makePrismaDouble([
      null,
      null,
      { id: "a1", name: "Agent", typeName: "coding" },
    ]).prisma,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
    intervalMs: 2000,
    logStatus: (line: string) => statusLines.push(line),
    writeResult: (id: string) => results.push(id),
    ...overrides,
  };
  return { deps, statusLines, results, sleepCalls };
}

describe("waitForAgent", () => {
  it("resolves immediately when an agent already exists (relaunch case — no forced wait)", async () => {
    const { prisma, callCount } = makePrismaDouble([
      { id: "existing-1", name: "Existing Agent", typeName: "coding" },
    ]);
    const statusLines: string[] = [];
    const results: string[] = [];
    const sleepCalls: number[] = [];

    const id = await waitForAgent({
      prisma,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      intervalMs: 2000,
      logStatus: (line) => statusLines.push(line),
      writeResult: (i) => results.push(i),
    });

    expect(id).toBe("existing-1");
    expect(results).toEqual(["existing-1"]);
    expect(sleepCalls).toHaveLength(0);
    expect(callCount()).toBe(1);
  });

  it("polls on the injected interval until a row appears, then resolves", async () => {
    const { prisma, callCount } = makePrismaDouble([
      null,
      null,
      { id: "created-later", name: "New Agent", typeName: "coding" },
    ]);
    const sleepCalls: number[] = [];

    const id = await waitForAgent({
      prisma,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      intervalMs: 2000,
      logStatus: () => {},
      writeResult: () => {},
    });

    expect(id).toBe("created-later");
    expect(callCount()).toBe(3);
    expect(sleepCalls).toEqual([2000, 2000]);
  });

  it("sleeps using the injected intervalMs, not a hardcoded value", async () => {
    const { prisma } = makePrismaDouble([
      null,
      { id: "x", name: "X", typeName: "coding" },
    ]);
    const sleepCalls: number[] = [];

    await waitForAgent({
      prisma,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      intervalMs: 500,
      logStatus: () => {},
      writeResult: () => {},
    });

    expect(sleepCalls).toEqual([500]);
  });

  it("orders the findFirst query by createdAt asc (oldest/first-created agent wins)", async () => {
    const { prisma, calls } = makePrismaDouble([
      { id: "first", name: "First", typeName: "coding" },
    ]);

    await waitForAgent({
      prisma,
      sleep: async () => {},
      intervalMs: 2000,
      logStatus: () => {},
      writeResult: () => {},
    });

    expect(calls).toEqual([{ orderBy: { createdAt: "asc" } }]);
  });

  it("prints the create-your-agent pointer message on the status channel (stderr), not the result channel", async () => {
    const { deps, statusLines, results } = makeDeps();

    await waitForAgent(deps);

    const joined = statusLines.join("\n");
    expect(joined).toContain("admin/agents/new");
    expect(joined.toLowerCase()).toContain("create");
    // The pointer/status text must never leak into the stdout result channel.
    expect(results.every((r) => !r.includes("admin/agents/new"))).toBe(true);
  });

  it("writes ONLY the resolved id to the result channel (clean for shell $(...) capture)", async () => {
    const { deps, results } = makeDeps();

    await waitForAgent(deps);

    expect(results).toEqual(["a1"]);
  });

  it("returns the resolved agent id", async () => {
    const { deps } = makeDeps();

    const id = await waitForAgent(deps);

    expect(id).toBe("a1");
  });
});

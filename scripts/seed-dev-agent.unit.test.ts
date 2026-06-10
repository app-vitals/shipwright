/**
 * scripts/seed-dev-agent.unit.test.ts
 * Unit tests for scripts/seed-dev-agent.ts — idempotent dev agent seed script.
 *
 * Uses injected Prisma doubles (plain objects) and injected file readers.
 * No mock.module(), no global overrides, no real DB or filesystem I/O.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { seedDevAgent, type SeedDeps } from "./seed-dev-agent.ts";

// ─── Prisma double factory ────────────────────────────────────────────────────

type UpsertCall = { where: unknown; create: unknown; update: unknown };
type TransactionCall = unknown[];

function makePrismaDouble() {
  const agentUpserts: UpsertCall[] = [];
  const agentEnvUpserts: UpsertCall[] = [];
  const agentPluginUpserts: UpsertCall[] = [];
  const agentToolUpserts: UpsertCall[] = [];
  const transactions: TransactionCall[] = [];

  const prisma = {
    agent: {
      upsert: async (args: UpsertCall) => {
        agentUpserts.push(args);
        return { id: "dev-agent", name: "Dev Agent" };
      },
      findUnique: async (_args: unknown) => {
        return { id: "dev-agent", name: "Dev Agent" };
      },
    },
    agentEnv: {
      upsert: async (args: UpsertCall) => {
        agentEnvUpserts.push(args);
        return args.create;
      },
    },
    agentPlugin: {
      upsert: async (args: UpsertCall) => {
        agentPluginUpserts.push(args);
        return args.create;
      },
    },
    agentTool: {
      upsert: async (args: UpsertCall) => {
        agentToolUpserts.push(args);
        return args.create;
      },
    },
    $transaction: async (ops: unknown[]) => {
      transactions.push(ops);
      // Execute all ops so counts are recorded
      const results = [];
      for (const op of ops) {
        results.push(await op);
      }
      return results;
    },
    $disconnect: async () => {},
  };

  return {
    prisma,
    agentUpserts,
    agentEnvUpserts,
    agentPluginUpserts,
    agentToolUpserts,
    transactions,
  };
}

// ─── Default tools constant (matches script) ─────────────────────────────────

const DEFAULT_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebSearch",
  "WebFetch",
  "Skill",
  "Agent",
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("seedDevAgent", () => {
  let double: ReturnType<typeof makePrismaDouble>;

  beforeEach(() => {
    double = makePrismaDouble();
  });

  it("upserts Agent + AgentEnv + AgentPlugin + AgentTool when env file present", async () => {
    const envFileContent = [
      "CLAUDE_CODE_OAUTH_TOKEN=test-oauth-token",
      "GH_TOKEN=ghp_test123",
    ].join("\n");

    const deps: SeedDeps = {
      prisma: double.prisma as never,
      readEnvFile: () => envFileContent,
      exit: (_code: number, _msg: string): never => {
        throw new Error("should not exit");
      },
    };

    await seedDevAgent(deps);

    // Agent upsert
    expect(double.agentUpserts).toHaveLength(1);
    expect(double.agentUpserts[0].where).toEqual({ id: "dev-agent" });
    expect((double.agentUpserts[0].create as { id: string }).id).toBe("dev-agent");
    expect((double.agentUpserts[0].create as { name: string }).name).toBe("Dev Agent");

    // AgentEnv upserts — CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN
    expect(double.agentEnvUpserts.length).toBeGreaterThanOrEqual(2);
    const envKeys = double.agentEnvUpserts.map(
      (u) => (u.where as { agentId_key: { key: string } }).agentId_key.key,
    );
    expect(envKeys).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(envKeys).toContain("GH_TOKEN");

    // AgentPlugin upsert — "shipwright"
    expect(double.agentPluginUpserts).toHaveLength(1);
    const pluginCreate = double.agentPluginUpserts[0].create as { name: string };
    expect(pluginCreate.name).toBe("shipwright");

    // AgentTool upserts — all DEFAULT_TOOLS
    expect(double.agentToolUpserts).toHaveLength(DEFAULT_TOOLS.length);
    const toolPatterns = double.agentToolUpserts.map(
      (u) => (u.where as { agentId_pattern: { pattern: string } }).agentId_pattern.pattern,
    );
    for (const tool of DEFAULT_TOOLS) {
      expect(toolPatterns).toContain(tool);
    }
  });

  it("seeds CLAUDE_CODE_OAUTH_TOKEN without GH_TOKEN when GH_TOKEN is absent", async () => {
    const envFileContent = "CLAUDE_CODE_OAUTH_TOKEN=test-oauth-token";

    const deps: SeedDeps = {
      prisma: double.prisma as never,
      readEnvFile: () => envFileContent,
      exit: (_code: number, _msg: string): never => {
        throw new Error("should not exit");
      },
    };

    await seedDevAgent(deps);

    const envKeys = double.agentEnvUpserts.map(
      (u) => (u.where as { agentId_key: { key: string } }).agentId_key.key,
    );
    expect(envKeys).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(envKeys).not.toContain("GH_TOKEN");
  });

  it("exits non-zero with clear message when state/dev-agent.env is missing", async () => {
    let exitCode: number | undefined;
    let exitMessage: string | undefined;

    const deps: SeedDeps = {
      prisma: double.prisma as never,
      readEnvFile: () => {
        throw new Error("ENOENT: no such file or directory");
      },
      exit: (code: number, msg: string): never => {
        exitCode = code;
        exitMessage = msg;
        throw new Error("__exit__");
      },
    };

    await expect(seedDevAgent(deps)).rejects.toThrow("__exit__");

    expect(exitCode).toBe(1);
    expect(exitMessage).toBeDefined();
    expect(exitMessage?.toLowerCase()).toContain("state/dev-agent.env");
  });

  it("exits non-zero with clear message when CLAUDE_CODE_OAUTH_TOKEN is absent from env file", async () => {
    let exitCode: number | undefined;
    let exitMessage: string | undefined;

    const deps: SeedDeps = {
      prisma: double.prisma as never,
      readEnvFile: () => "GH_TOKEN=ghp_test123\n# just a comment",
      exit: (code: number, msg: string): never => {
        exitCode = code;
        exitMessage = msg;
        throw new Error("__exit__");
      },
    };

    await expect(seedDevAgent(deps)).rejects.toThrow("__exit__");

    expect(exitCode).toBe(1);
    expect(exitMessage).toBeDefined();
    expect(exitMessage?.toLowerCase()).toContain("claude_code_oauth_token");
  });

  it("is idempotent — second run produces same upsert calls (not create)", async () => {
    const envFileContent = "CLAUDE_CODE_OAUTH_TOKEN=test-oauth-token";

    const deps: SeedDeps = {
      prisma: double.prisma as never,
      readEnvFile: () => envFileContent,
      exit: (_code: number, _msg: string): never => {
        throw new Error("should not exit");
      },
    };

    // First run
    await seedDevAgent(deps);
    const firstAgentUpserts = double.agentUpserts.length;
    const firstEnvUpserts = double.agentEnvUpserts.length;
    const firstPluginUpserts = double.agentPluginUpserts.length;
    const firstToolUpserts = double.agentToolUpserts.length;

    // Second run with same double
    await seedDevAgent(deps);

    // Should double the upsert calls (idempotent = same operation twice)
    expect(double.agentUpserts.length).toBe(firstAgentUpserts * 2);
    expect(double.agentEnvUpserts.length).toBe(firstEnvUpserts * 2);
    expect(double.agentPluginUpserts.length).toBe(firstPluginUpserts * 2);
    expect(double.agentToolUpserts.length).toBe(firstToolUpserts * 2);

    // All agent upserts must use upsert (not create) with id "dev-agent"
    for (const upsert of double.agentUpserts) {
      expect((upsert.where as { id: string }).id).toBe("dev-agent");
    }
  });
});

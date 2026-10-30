/**
 * scripts/seed-dev-agent.unit.test.ts
 * Unit tests for scripts/seed-dev-agent.ts — idempotent dev agent seed script.
 *
 * Uses injected Prisma doubles (plain objects) and injected file readers.
 * No mock.module(), no global overrides, no real DB or filesystem I/O.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  CODING_SPECIALTY_DEFAULTS,
  codingSpecialtyDefaults,
} from "@shipwright/admin/coding/coding-specialty-defaults";
import { parseEnvFile, type SeedDeps, seedDevAgent } from "./seed-dev-agent.ts";

// ─── Fake specialty defaults ─────────────────────────────────────────────────
//
// Resolves a fixed "coding" tool/plugin set, keeping this suite independent of
// the real defaults in admin/src/coding/coding-specialty-defaults.ts (the
// last test pins the two together).

const CODING_TOOLS = [
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

function fakeSpecialtyDefaults(): SeedDeps["specialtyDefaults"] {
  return () => ({ tools: CODING_TOOLS, plugins: ["shipwright"] });
}

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
      specialtyDefaults: fakeSpecialtyDefaults(),
      exit: (_code: number, _msg: string): never => {
        throw new Error("should not exit");
      },
    };

    await seedDevAgent(deps);

    // Agent upsert
    expect(double.agentUpserts).toHaveLength(1);
    expect(double.agentUpserts[0].where).toEqual({ id: "dev-agent" });
    expect((double.agentUpserts[0].create as { id: string }).id).toBe(
      "dev-agent",
    );
    expect((double.agentUpserts[0].create as { name: string }).name).toBe(
      "Dev Agent",
    );

    // AgentEnv upserts — CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN
    expect(double.agentEnvUpserts.length).toBeGreaterThanOrEqual(2);
    const envKeys = double.agentEnvUpserts.map(
      (u) => (u.where as { agentId_key: { key: string } }).agentId_key.key,
    );
    expect(envKeys).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(envKeys).toContain("GH_TOKEN");

    // AgentPlugin upsert — "shipwright"
    expect(double.agentPluginUpserts).toHaveLength(1);
    const pluginCreate = double.agentPluginUpserts[0].create as {
      name: string;
    };
    expect(pluginCreate.name).toBe("shipwright");

    // AgentTool upserts — the full defaults-resolved tool set
    expect(double.agentToolUpserts).toHaveLength(CODING_TOOLS.length);
    const toolPatterns = double.agentToolUpserts.map(
      (u) =>
        (u.where as { agentId_pattern: { pattern: string } }).agentId_pattern
          .pattern,
    );
    for (const tool of CODING_TOOLS) {
      expect(toolPatterns).toContain(tool);
    }
  });

  // ─── Code-defaults parity ───────────────────────────────────

  it("resolves its tool set from the injected specialty defaults rather than a hardcoded constant", async () => {
    const customTools = ["Read", "Bash"];
    const customDefaults: SeedDeps["specialtyDefaults"] = () => ({
      tools: customTools,
      plugins: ["shipwright"],
    });

    const deps: SeedDeps = {
      prisma: double.prisma as never,
      readEnvFile: () => "CLAUDE_CODE_OAUTH_TOKEN=test-oauth-token",
      specialtyDefaults: customDefaults,
      exit: (_code: number, _msg: string): never => {
        throw new Error("should not exit");
      },
    };

    await seedDevAgent(deps);

    const toolPatterns = double.agentToolUpserts.map(
      (u) =>
        (u.where as { agentId_pattern: { pattern: string } }).agentId_pattern
          .pattern,
    );
    expect(toolPatterns.sort()).toEqual([...customTools].sort());
  });

  it("produces the same tool/plugin set as the real coding code defaults (what POST /admin/agents seeds)", async () => {
    const codingDefaults = CODING_SPECIALTY_DEFAULTS;

    const deps: SeedDeps = {
      prisma: double.prisma as never,
      readEnvFile: () => "CLAUDE_CODE_OAUTH_TOKEN=test-oauth-token",
      specialtyDefaults: codingSpecialtyDefaults,
      exit: (_code: number, _msg: string): never => {
        throw new Error("should not exit");
      },
    };

    await seedDevAgent(deps);

    // Tool set matches the real coding defaults exactly (parity with the
    // admin POST /admin/agents seeding path, which resolves the same defaults).
    const toolPatterns = double.agentToolUpserts.map(
      (u) =>
        (u.where as { agentId_pattern: { pattern: string } }).agentId_pattern
          .pattern,
    );
    expect(toolPatterns.sort()).toEqual(
      [...(codingDefaults.tools ?? [])].sort(),
    );

    // Plugin set matches too — the seeded plugins
    // is backed by (and equal to) the defaults' plugins array.
    const pluginNames = double.agentPluginUpserts.map(
      (u) => (u.create as { name: string }).name,
    );
    expect(pluginNames).toEqual(codingDefaults.plugins);
  });

  it("seeds CLAUDE_CODE_OAUTH_TOKEN without GH_TOKEN when GH_TOKEN is absent", async () => {
    const envFileContent = "CLAUDE_CODE_OAUTH_TOKEN=test-oauth-token";

    const deps: SeedDeps = {
      prisma: double.prisma as never,
      readEnvFile: () => envFileContent,
      specialtyDefaults: fakeSpecialtyDefaults(),
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
      specialtyDefaults: fakeSpecialtyDefaults(),
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
      specialtyDefaults: fakeSpecialtyDefaults(),
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
      specialtyDefaults: fakeSpecialtyDefaults(),
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

// ─── parseEnvFile unit tests ──────────────────────────────────────────────────

describe("parseEnvFile", () => {
  it("parses a basic key=value pair", () => {
    expect(parseEnvFile("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("handles values containing = signs (KEY=abc=def)", () => {
    // Only the first = is treated as the delimiter; everything after is the value
    expect(parseEnvFile("KEY=abc=def")).toEqual({ KEY: "abc=def" });
  });

  it("handles multiple = in a value (BASE64-style values)", () => {
    expect(parseEnvFile("TOKEN=abc==")).toEqual({ TOKEN: "abc==" });
  });

  it("strips surrounding double quotes from value", () => {
    expect(parseEnvFile('FOO="bar baz"')).toEqual({ FOO: "bar baz" });
  });

  it("strips surrounding single quotes from value", () => {
    expect(parseEnvFile("FOO='bar baz'")).toEqual({ FOO: "bar baz" });
  });

  it("strips an unmatched leading quote without crashing (regex acts independently on each end)", () => {
    // The replace regex /^["']|["']$/g strips a leading " and a trailing " independently —
    // not as a matched pair. So a lone leading " is still stripped.
    const result = parseEnvFile('FOO="unmatched');
    expect(result.FOO).toBe("unmatched");
  });

  it("strips an unmatched trailing quote without crashing (regex acts independently on each end)", () => {
    const result = parseEnvFile('FOO=unmatched"');
    expect(result.FOO).toBe("unmatched");
  });

  it("handles \\r\\n line endings (Windows-style)", () => {
    const content = "FOO=bar\r\nBAZ=qux\r\n";
    expect(parseEnvFile(content)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles mixed \\n and \\r\\n line endings", () => {
    const content = "FOO=bar\r\nBAZ=qux\nQUX=quux\r\n";
    expect(parseEnvFile(content)).toEqual({
      FOO: "bar",
      BAZ: "qux",
      QUX: "quux",
    });
  });

  it("ignores blank lines", () => {
    expect(parseEnvFile("\n\nFOO=bar\n\n")).toEqual({ FOO: "bar" });
  });

  it("ignores comment lines starting with #", () => {
    expect(parseEnvFile("# comment\nFOO=bar\n# another comment")).toEqual({
      FOO: "bar",
    });
  });

  it("ignores lines without = separator", () => {
    expect(parseEnvFile("NOEQUALS\nFOO=bar")).toEqual({ FOO: "bar" });
  });

  it("trims whitespace around key name", () => {
    expect(parseEnvFile("  FOO  =bar")).toEqual({ FOO: "bar" });
  });

  it("returns empty object for empty string", () => {
    expect(parseEnvFile("")).toEqual({});
  });

  it("returns empty object for only comments and blank lines", () => {
    expect(parseEnvFile("# just a comment\n\n# another")).toEqual({});
  });
});

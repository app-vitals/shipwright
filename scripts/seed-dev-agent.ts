/**
 * scripts/seed-dev-agent.ts
 * Idempotent seed script for the local dev agent.
 *
 * Upserts a dev agent (id: "dev-agent") into the admin Prisma DB with its
 * AgentEnv (CLAUDE_CODE_OAUTH_TOKEN, optional GH_TOKEN), AgentPlugin
 * (shipwright), and AgentTool defaults.
 *
 * Reads secrets from state/dev-agent.env (git-ignored). Exits non-zero with
 * a clear message if the file is missing or CLAUDE_CODE_OAUTH_TOKEN is absent.
 *
 * Usage:
 *   bun run scripts/seed-dev-agent.ts [--db-url <url>]
 *
 * Required (in state/dev-agent.env):
 *   CLAUDE_CODE_OAUTH_TOKEN=<value>
 *   GH_TOKEN=<value>  # optional
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEV_AGENT_ID = "dev-agent";
const DEV_AGENT_NAME = "Dev Agent";
const DEV_AGENT_ENV_FILE = "state/dev-agent.env";
const DEV_PLUGIN_NAME = "shipwright";

export const DEFAULT_TOOLS = [
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

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal Prisma interface needed by the seed function — injected for testability. */
export interface SeedPrisma {
  agent: {
    upsert(args: {
      where: { id: string };
      create: { id: string; name: string };
      update: Record<string, never>;
    }): Promise<unknown>;
  };
  agentEnv: {
    upsert(args: {
      where: { agentId_key: { agentId: string; key: string } };
      create: { agentId: string; key: string; value: string };
      update: { value: string };
    }): Promise<unknown>;
  };
  agentPlugin: {
    upsert(args: {
      where: { agentId_name: { agentId: string; name: string } };
      create: { agentId: string; name: string; version: null; enabled: boolean };
      update: { version: null; enabled: boolean };
    }): Promise<unknown>;
  };
  agentTool: {
    upsert(args: {
      where: { agentId_pattern: { agentId: string; pattern: string } };
      create: { agentId: string; pattern: string; enabled: boolean };
      update: { enabled: boolean };
    }): Promise<unknown>;
  };
  $transaction(ops: Promise<unknown>[]): Promise<unknown[]>;
  $disconnect(): Promise<void>;
}

/** Injectable dependencies for testability. */
export interface SeedDeps {
  /** Prisma client (or double). */
  prisma: SeedPrisma;
  /** Read the env file contents — throws on missing file. */
  readEnvFile: () => string;
  /** Called when the script should exit with an error. The implementation should throw. */
  exit: (code: number, message: string) => never;
}

// ─── Env file parser ──────────────────────────────────────────────────────────

/**
 * Parse a dotenv-style file into a key/value map.
 * Ignores blank lines and lines starting with #.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) result[key] = value;
  }
  return result;
}

// ─── Core seed function ───────────────────────────────────────────────────────

/**
 * Idempotently seeds the dev agent into the admin DB.
 * Accepts injected deps for testability.
 */
export async function seedDevAgent(deps: SeedDeps): Promise<void> {
  const { prisma, readEnvFile, exit } = deps;

  // 1. Read and parse the env file
  let envVars: Record<string, string>;
  try {
    const content = readEnvFile();
    envVars = parseEnvFile(content);
  } catch {
    exit(
      1,
      [
        "Error: state/dev-agent.env not found.",
        "",
        "Create it with your dev agent credentials:",
        '  echo "CLAUDE_CODE_OAUTH_TOKEN=<your-token>" > state/dev-agent.env',
        "",
        "This file is git-ignored and will not be committed.",
      ].join("\n"),
    );
  }

  // 2. Validate required token
  if (!envVars.CLAUDE_CODE_OAUTH_TOKEN) {
    exit(
      1,
      [
        "Error: CLAUDE_CODE_OAUTH_TOKEN is missing from state/dev-agent.env.",
        "",
        "Add it to state/dev-agent.env:",
        "  CLAUDE_CODE_OAUTH_TOKEN=<your-claude-code-oauth-token>",
      ].join("\n"),
    );
  }

  // 3. Upsert the agent record
  await prisma.agent.upsert({
    where: { id: DEV_AGENT_ID },
    create: { id: DEV_AGENT_ID, name: DEV_AGENT_NAME },
    update: {},
  });
  console.log(`[seed-dev-agent] upserted agent: ${DEV_AGENT_ID}`);

  // 4. Patch env vars
  const envToSeed: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: envVars.CLAUDE_CODE_OAUTH_TOKEN,
  };
  if (envVars.GH_TOKEN) {
    envToSeed.GH_TOKEN = envVars.GH_TOKEN;
  }

  await prisma.$transaction(
    Object.entries(envToSeed).map(([key, value]) =>
      prisma.agentEnv.upsert({
        where: { agentId_key: { agentId: DEV_AGENT_ID, key } },
        create: { agentId: DEV_AGENT_ID, key, value },
        update: { value },
      }),
    ),
  );
  console.log(
    `[seed-dev-agent] upserted env vars: ${Object.keys(envToSeed).join(", ")}`,
  );

  // 5. Upsert plugin
  await prisma.agentPlugin.upsert({
    where: { agentId_name: { agentId: DEV_AGENT_ID, name: DEV_PLUGIN_NAME } },
    create: { agentId: DEV_AGENT_ID, name: DEV_PLUGIN_NAME, version: null, enabled: true },
    update: { version: null, enabled: true },
  });
  console.log(`[seed-dev-agent] upserted plugin: ${DEV_PLUGIN_NAME}`);

  // 6. Upsert default tools
  await prisma.$transaction(
    DEFAULT_TOOLS.map((pattern) =>
      prisma.agentTool.upsert({
        where: { agentId_pattern: { agentId: DEV_AGENT_ID, pattern } },
        create: { agentId: DEV_AGENT_ID, pattern, enabled: true },
        update: { enabled: true },
      }),
    ),
  );
  console.log(
    `[seed-dev-agent] upserted ${DEFAULT_TOOLS.length} tools: ${DEFAULT_TOOLS.join(", ")}`,
  );

  console.log(`[seed-dev-agent] done — dev agent "${DEV_AGENT_ID}" is ready.`);
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const { PrismaClient } = await import("../admin/prisma/client/index.js");

  const argv = process.argv.slice(2);
  const dbUrl = (() => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--db-url" && argv[i + 1]) return argv[i + 1];
      if (argv[i]?.startsWith("--db-url=")) return argv[i].slice("--db-url=".length);
    }
    return process.env.DATABASE_URL;
  })();

  if (!dbUrl) {
    console.error(
      "Error: DATABASE_URL is not set. Pass --db-url <url> or set the DATABASE_URL env var.",
    );
    process.exit(1);
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });

  const envFilePath = path.join(process.cwd(), DEV_AGENT_ENV_FILE);

  try {
    await seedDevAgent({
      prisma,
      readEnvFile: () => fs.readFileSync(envFilePath, "utf8"),
      exit: (code, message) => {
        console.error(message);
        process.exit(code);
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

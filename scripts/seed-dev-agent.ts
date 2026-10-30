/**
 * scripts/seed-dev-agent.ts
 * Idempotent seed script for the local dev agent.
 *
 * Upserts a dev agent (id: "dev-agent") into the admin Prisma DB with its
 * AgentEnv (CLAUDE_CODE_OAUTH_TOKEN, optional GH_TOKEN), and its
 * AgentPlugin/AgentTool rows resolved from the coding specialty's code
 * defaults (admin/src/coding/coding-specialty-defaults.ts) — the same
 * source of truth used by the admin console's agent-creation form,
 * POST /admin/agents.
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
import type { SpecialtyDefaults } from "@app-vitals/agent-admin/specialty-defaults";
import { parseFlags } from "@app-vitals/agent-lib/cli-flags";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEV_AGENT_ID = "dev-agent";
const DEV_AGENT_NAME = "Dev Agent";
const DEV_AGENT_ENV_FILE = "state/dev-agent.env";
const DEV_AGENT_TYPE = "coding";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal Prisma interface needed by the seed function — injected for testability. */
interface SeedPrisma {
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
      create: {
        agentId: string;
        name: string;
        version: null;
        enabled: boolean;
      };
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
  /**
   * Resolves the "coding" specialty's code defaults for their tools/plugins —
   * the single source of truth this script and the admin console's
   * POST /admin/agents create form both seed from. Injectable for testability
   * (see seed-dev-agent.unit.test.ts).
   */
  specialtyDefaults: (specialty: string) => SpecialtyDefaults | undefined;
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
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
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
  const { prisma, readEnvFile, specialtyDefaults, exit } = deps;

  // Resolve the "coding" defaults up front — their tools/plugins are this
  // script's single source of truth (mirrors POST /admin/agents' seeding).
  const defaults = specialtyDefaults(DEV_AGENT_TYPE);
  if (!defaults) {
    exit(1, `Error: no specialty defaults found for "${DEV_AGENT_TYPE}".`);
  }
  const plugins = defaults.plugins ?? [];
  const tools = defaults.tools ?? [];

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

  // 5. Upsert plugins from the code defaults
  await prisma.$transaction(
    plugins.map((name) =>
      prisma.agentPlugin.upsert({
        where: { agentId_name: { agentId: DEV_AGENT_ID, name } },
        create: {
          agentId: DEV_AGENT_ID,
          name,
          version: null,
          enabled: true,
        },
        update: { version: null, enabled: true },
      }),
    ),
  );
  console.log(`[seed-dev-agent] upserted plugins: ${plugins.join(", ")}`);

  // 6. Upsert tools from the code defaults
  await prisma.$transaction(
    tools.map((pattern) =>
      prisma.agentTool.upsert({
        where: { agentId_pattern: { agentId: DEV_AGENT_ID, pattern } },
        create: { agentId: DEV_AGENT_ID, pattern, enabled: true },
        update: { enabled: true },
      }),
    ),
  );
  console.log(
    `[seed-dev-agent] upserted ${tools.length} tools: ${tools.join(", ")}`,
  );

  console.log(`[seed-dev-agent] done — dev agent "${DEV_AGENT_ID}" is ready.`);
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const { createAdminPrismaClient } = await import(
    "@app-vitals/agent-admin/prisma-client"
  );
  const { codingSpecialtyDefaults } = await import(
    "@shipwright/admin/coding/coding-specialty-defaults"
  );

  const argv = process.argv.slice(2);
  const dbUrl =
    parseFlags(argv, ["--db-url"] as const)["--db-url"] ??
    process.env.DATABASE_URL_SHIPWRIGHT_ADMIN;

  if (!dbUrl) {
    console.error(
      "Error: DATABASE_URL_SHIPWRIGHT_ADMIN is not set. Pass --db-url <url> or set the DATABASE_URL_SHIPWRIGHT_ADMIN env var.",
    );
    process.exit(1);
  }

  const prisma = createAdminPrismaClient(dbUrl);

  const envFilePath = path.join(process.cwd(), DEV_AGENT_ENV_FILE);

  try {
    await seedDevAgent({
      prisma,
      readEnvFile: () => fs.readFileSync(envFilePath, "utf8"),
      specialtyDefaults: codingSpecialtyDefaults,
      exit: (code, message) => {
        console.error(message);
        process.exit(code);
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

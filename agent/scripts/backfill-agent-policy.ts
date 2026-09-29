/**
 * agent/scripts/backfill-agent-policy.ts
 * CLI entry point for APM-1.1's one-off agent-policy DB backfill.
 *
 * Overwrites the 6 agent-policy DB columns (autoPostReviews, allowSelfReview,
 * minConfidence, maxFindings, cleanupMergedWorktrees, cleanupAfterDays) on one
 * or more Agent rows with the REAL values parsed out of each agent's own
 * state/agent-policy.md file — the column defaults a fresh migration already
 * stamps onto every row are only the documented defaults, not necessarily
 * what a given already-provisioned agent's owner has actually configured.
 *
 * There is no remote-fetch API for a live agent's state/agent-policy.md — it
 * only ever exists on that agent's own pod filesystem (see
 * scripts/agent-workspace-pull.ts's doc comment). An operator must manually
 * copy each agent's file out first, e.g.:
 *
 *   kubectl cp <agent-pod>:/home/bun/workspace/state/agent-policy.md ./agent-123-policy.md
 *
 * ...then pass the local path here alongside that agent's DB id.
 *
 * Required env vars:
 *   DATABASE_URL_SHIPWRIGHT_ADMIN — Postgres connection string for the admin DB
 *
 * Usage:
 *   DATABASE_URL_SHIPWRIGHT_ADMIN=<url> \
 *     bun agent/scripts/backfill-agent-policy.ts \
 *       --agent-id <id> --file <path> [--agent-id <id> --file <path> ...]
 *
 * Flags:
 *   --agent-id <id>   Repeatable, paired with the --file immediately after it.
 *                      The Agent row's DB id (not its Slack/display name).
 *   --file <path>      Local path to that agent's copied-out
 *                      state/agent-policy.md content.
 *   --help              Print this usage and exit 0.
 *
 * Exit codes:
 *   0 — completed with zero per-agent errors
 *   1 — completed with at least one per-agent error (see the printed report)
 *
 * Idempotent: safe to re-run — each run simply re-parses and re-writes the
 * same 6 fields from the same file content.
 */

import { readFileSync } from "node:fs";
import { createAdminPrismaClient, type PrismaClient } from "@shipwright/admin";
import {
  type AgentPolicyBackfillDeps,
  type AgentPolicyBackfillResult,
  runAgentPolicyBackfill,
} from "../src/agent-policy-backfill.ts";

const USAGE = `Usage: DATABASE_URL_SHIPWRIGHT_ADMIN=<url> bun backfill-agent-policy.ts --agent-id <id> --file <path> [--agent-id <id> --file <path> ...]

Required env vars:
  DATABASE_URL_SHIPWRIGHT_ADMIN — Postgres connection string for the admin DB

Flags:
  --agent-id <id>  Repeatable, paired with the --file immediately after it.
                     The Agent row's DB id.
  --file <path>      Local path to that agent's copied-out
                     state/agent-policy.md content (e.g. via kubectl cp).
  --help              Print this usage and exit 0.

Exit codes:
  0 — completed with zero per-agent errors
  1 — completed with at least one per-agent error (see the printed report)`;

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Error: required environment variable ${name} is not set\n`);
    console.error(USAGE);
    process.exit(1);
  }
  return val;
}

interface AgentFilePair {
  agentId: string;
  filePath: string;
}

function parseArgs(argv: string[]): AgentFilePair[] {
  const pairs: AgentFilePair[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== "--agent-id") continue;

    const agentId = argv[++i];
    if (!agentId) {
      console.error("Error: --agent-id requires a value\n");
      console.error(USAGE);
      process.exit(1);
    }

    if (argv[++i] !== "--file") {
      console.error(
        `Error: --agent-id ${agentId} must be immediately followed by --file <path>\n`,
      );
      console.error(USAGE);
      process.exit(1);
    }

    const filePath = argv[++i];
    if (!filePath) {
      console.error("Error: --file requires a value (path)\n");
      console.error(USAGE);
      process.exit(1);
    }

    pairs.push({ agentId, filePath });
  }

  if (pairs.length === 0) {
    console.error(
      "Error: no --agent-id/--file pairs given — pass at least one\n",
    );
    console.error(USAGE);
    process.exit(1);
  }

  return pairs;
}

const pairs = parseArgs(process.argv.slice(2));
const databaseUrl = requireEnv("DATABASE_URL_SHIPWRIGHT_ADMIN");

// Reading each file happens up front, outside the backfill core, so a
// missing/unreadable file is reported per-agent (mirroring
// runAgentPolicyBackfill's own continue-on-error shape) without ever
// reaching Prisma for that agent.
const items: Array<{ agentId: string; content: string }> = [];
const readErrors: AgentPolicyBackfillResult[] = [];
for (const { agentId, filePath } of pairs) {
  try {
    items.push({ agentId, content: readFileSync(filePath, "utf-8") });
  } catch (err) {
    readErrors.push({
      agentId,
      fields: {
        autoPostReviews: true,
        allowSelfReview: false,
        minConfidence: 75,
        maxFindings: 5,
        cleanupMergedWorktrees: true,
        cleanupAfterDays: 14,
      },
      error: `failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

const prisma: PrismaClient = createAdminPrismaClient(databaseUrl);

const deps: AgentPolicyBackfillDeps = {
  updateAgentPolicy: async (agentId, fields) => {
    await prisma.agent.update({ where: { id: agentId }, data: fields });
  },
};

console.log(
  `Backfilling agent-policy fields for ${pairs.length} agent(s)...\n`,
);

const results = [...readErrors, ...(await runAgentPolicyBackfill(deps, items))];
await prisma.$disconnect();

let hadErrors = false;
for (const result of results) {
  console.log(`── ${result.agentId} ──`);
  console.log(`  auto_post_reviews:        ${result.fields.autoPostReviews}`);
  console.log(`  allow_self_review:        ${result.fields.allowSelfReview}`);
  console.log(`  min_confidence:           ${result.fields.minConfidence}`);
  console.log(`  max_findings:             ${result.fields.maxFindings}`);
  console.log(
    `  cleanup_merged_worktrees: ${result.fields.cleanupMergedWorktrees}`,
  );
  console.log(`  cleanup_after_days:       ${result.fields.cleanupAfterDays}`);
  if (result.error) {
    hadErrors = true;
    console.log(`  ERROR: ${result.error}`);
  }
  console.log();
}

if (hadErrors) {
  console.error("Completed with per-agent errors — see the report above.");
  process.exit(1);
}

console.log("Backfill complete.");

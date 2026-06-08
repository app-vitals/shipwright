/**
 * agent/src/migrate.ts
 * Core migration logic — enumerate agents from vitals-os accounts API,
 * write env vars, tools, and cron jobs to the shipwright admin API.
 *
 * Idempotent: envs replace-all, tools upsert internally, crons skip duplicates.
 * Continues on per-agent failure; reports failing agent + field.
 */

import type { AccountsMigrationClient } from "./accounts-migration-client.ts";
import type { ShipwrightAdminMigrationClient } from "./shipwright-admin-client.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentMigrationFailure {
  agentId: string;
  field: string;
  error: string;
}

export interface MigrationResult {
  migrated: number;
  failed: AgentMigrationFailure[];
}

// ─── Core migration function ──────────────────────────────────────────────────

export async function runMigration(
  accountsClient: AccountsMigrationClient,
  adminClient: ShipwrightAdminMigrationClient,
): Promise<MigrationResult> {
  const agents = await accountsClient.listAgents();

  let migrated = 0;
  const failed: AgentMigrationFailure[] = [];

  for (const agent of agents) {
    const { id: agentId } = agent;
    const failedBefore = failed.length;

    // 1. Migrate env vars + tools
    try {
      const config = await accountsClient.getAgentConfig(agentId);
      await adminClient.upsertEnvs(agentId, config.env);

      for (const pattern of config.tools) {
        try {
          await adminClient.addTool(agentId, pattern);
        } catch (err) {
          failed.push({
            agentId,
            field: `tool:${pattern}`,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      failed.push({
        agentId,
        field: "env",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Migrate crons (skip duplicates matched by schedule+prompt)
    try {
      const sourceCrons = await accountsClient.getAgentCrons(agentId);
      const existingCrons = await adminClient.listCrons(agentId);

      for (const cron of sourceCrons) {
        const isDuplicate = existingCrons.some(
          (existing) =>
            existing.schedule === cron.schedule &&
            existing.prompt === cron.prompt,
        );

        if (!isDuplicate) {
          try {
            await adminClient.createCron(agentId, cron);
          } catch (err) {
            const cronLabel = cron.name ?? cron.schedule;
            failed.push({
              agentId,
              field: `cron:${cronLabel}`,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      failed.push({
        agentId,
        field: "crons",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (failed.length === failedBefore) {
      migrated++;
    }
  }

  return { migrated, failed };
}

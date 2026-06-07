/**
 * agent/src/agent-cron-jobs.ts
 * AgentCronJobService — CRUD for scheduled prompts per agent.
 *
 * Cron expression validation uses an inline 5-field regex check.
 * Delivery target must be either a Slack channel ID or a Slack user ID (DM)
 * — not both, and not neither (unless silent=true).
 */

import { NotFoundError, UnprocessableEntityError } from "./errors.ts";
import { SYSTEM_CRONS } from "./system-crons.ts";
import type { AgentCronJob, PrismaClient } from "../prisma/client/index.js";

export type { AgentCronJob };

export interface CreateAgentCronJobInput {
  schedule: string;
  prompt: string;
  channel?: string | null;
  user?: string | null;
  silent?: boolean;
  enabled?: boolean;
  preCheck?: string | null;
  name?: string | null;
  system?: boolean;
}

/**
 * Validates a cron expression.
 * Accepts standard 5-field cron: minute hour day-of-month month day-of-week.
 * Each field may contain digits, *, /, -, and comma.
 */
function isValidCron(schedule: string): boolean {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const fieldPattern = /^(\*|[0-9]+([-,][0-9]+)*)(\/[0-9]+)?$|^\*\/[0-9]+$/;
  return fields.every((f) => fieldPattern.test(f));
}

function validateDeliveryTarget(
  channel: string | null,
  user: string | null,
  silent: boolean,
): void {
  if (channel && user) {
    throw new UnprocessableEntityError(
      "channel and user are mutually exclusive — set one or the other, not both",
    );
  }
  if (!silent && !channel && !user) {
    throw new UnprocessableEntityError(
      "at least one of channel or user must be set (unless silent=true)",
    );
  }
}

export class AgentCronJobService {
  constructor(private prisma: PrismaClient) {}

  /**
   * List all cron jobs for a given agent.
   */
  async list(agentId: string): Promise<AgentCronJob[]> {
    return this.prisma.agentCronJob.findMany({
      where: { agentId },
      orderBy: { createdAt: "asc" },
    });
  }

  async get(agentId: string, cronId: string): Promise<AgentCronJob> {
    const job = await this.prisma.agentCronJob.findUnique({
      where: { id: cronId },
    });
    if (!job || job.agentId !== agentId) {
      throw new NotFoundError(`cron job ${cronId} not found`);
    }
    return job;
  }

  /**
   * List all enabled cron jobs across all agents.
   * Used by the runtime sync loop on startup and every 60s.
   */
  async listEnabled(): Promise<AgentCronJob[]> {
    return this.prisma.agentCronJob.findMany({
      where: { enabled: true },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Create a new cron job for the given agent.
   * Validates:
   *   - schedule is a valid 5-field cron expression
   *   - channel and user are mutually exclusive (422 if both set)
   *   - at least one of channel or user is set (unless silent=true)
   * Throws UnprocessableEntityError for invalid inputs.
   */
  async create(
    agentId: string,
    input: CreateAgentCronJobInput,
  ): Promise<AgentCronJob> {
    if (!isValidCron(input.schedule)) {
      throw new UnprocessableEntityError(
        `invalid cron expression: "${input.schedule}"`,
      );
    }

    const channel = input.channel ?? null;
    const user = input.user ?? null;
    const silent = input.silent ?? false;

    validateDeliveryTarget(channel, user, silent);

    return this.prisma.agentCronJob.create({
      data: {
        agentId,
        schedule: input.schedule,
        prompt: input.prompt,
        channel,
        user,
        silent,
        enabled: input.enabled ?? true,
        preCheck: input.preCheck ?? null,
        name: input.name ?? null,
        system: input.system ?? false,
      },
    });
  }

  /**
   * Delete a cron job. Verifies agentId ownership before deleting.
   * Throws NotFoundError if the cronId doesn't exist or belongs to a different agent.
   */
  async delete(agentId: string, cronId: string): Promise<void> {
    const existing = await this.prisma.agentCronJob.findUnique({
      where: { id: cronId },
    });

    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`cron job ${cronId} not found`);
    }

    await this.prisma.agentCronJob.delete({ where: { id: cronId } });
  }

  /**
   * Update a cron job's schedule, prompt, channel, user, silent, and preCheck.
   * Applies the same validation as create():
   *   - schedule must be a valid cron expression
   *   - channel and user are mutually exclusive (422 if both set)
   *   - at least one of channel or user must be set (unless silent=true)
   * Throws NotFoundError if the cronId doesn't exist or belongs to a different agent.
   * Throws UnprocessableEntityError for invalid inputs.
   */
  async update(
    agentId: string,
    cronId: string,
    input: {
      schedule: string;
      prompt: string;
      channel?: string | null;
      user?: string | null;
      silent?: boolean;
      preCheck?: string | null;
    },
  ): Promise<AgentCronJob> {
    await this.get(agentId, cronId);

    if (!isValidCron(input.schedule)) {
      throw new UnprocessableEntityError(
        `invalid cron expression: "${input.schedule}"`,
      );
    }

    const channel = input.channel ?? null;
    const user = input.user ?? null;
    const silent = input.silent ?? false;

    validateDeliveryTarget(channel, user, silent);

    return this.prisma.agentCronJob.update({
      where: { id: cronId },
      data: {
        schedule: input.schedule,
        prompt: input.prompt,
        channel,
        user,
        silent,
        ...(input.preCheck !== undefined && { preCheck: input.preCheck }),
      },
    });
  }

  /**
   * Update only the preCheck field of a cron job.
   * Pass null to clear the preCheck script.
   * Throws NotFoundError if the cronId doesn't exist or belongs to a different agent.
   */
  async updatePreCheck(
    agentId: string,
    cronId: string,
    preCheck: string | null,
  ): Promise<AgentCronJob> {
    await this.get(agentId, cronId);
    return this.prisma.agentCronJob.update({
      where: { id: cronId },
      data: { preCheck },
    });
  }

  /**
   * Update only the delivery-target fields of a cron job (channel, user, silent).
   * Does not touch schedule or prompt.
   * Throws NotFoundError if the cronId doesn't exist or belongs to a different agent.
   */
  async updateDelivery(
    agentId: string,
    cronId: string,
    input: {
      channel?: string | null;
      user?: string | null;
      silent?: boolean;
    },
  ): Promise<AgentCronJob> {
    await this.get(agentId, cronId);

    return this.prisma.agentCronJob.update({
      where: { id: cronId },
      data: {
        ...(input.channel !== undefined && { channel: input.channel }),
        ...(input.user !== undefined && { user: input.user }),
        ...(input.silent !== undefined && { silent: input.silent }),
      },
    });
  }

  /**
   * Enable or disable a cron job.
   * Throws NotFoundError if the cronId doesn't exist or belongs to a different agent.
   */
  async setEnabled(
    agentId: string,
    cronId: string,
    enabled: boolean,
  ): Promise<AgentCronJob> {
    await this.get(agentId, cronId);

    return this.prisma.agentCronJob.update({
      where: { id: cronId },
      data: { enabled },
    });
  }

  /**
   * Reconcile system crons for the given agent.
   *
   * For each entry in SYSTEM_CRONS:
   *   - If an existing system cron with matching name exists: delete it and
   *     recreate it with current SYSTEM_CRONS definition, preserving the
   *     existing enabled state.
   *   - If no matching cron exists: create it with SYSTEM_CRONS default enabled.
   *
   * Orphan pass: delete any cron with system=true whose name is no longer in SYSTEM_CRONS.
   *
   * Returns a summary { created, updated, deleted }.
   */
  async reconcileSystemCrons(
    agentId: string,
  ): Promise<{ created: number; updated: number; deleted: number }> {
    // Fetch all existing system crons for this agent
    const existingSystemCrons = await this.prisma.agentCronJob.findMany({
      where: { agentId, system: true },
    });

    // Build a map of name → existing cron
    const existingByName = new Map<string, AgentCronJob>();
    for (const cron of existingSystemCrons) {
      if (cron.name) {
        existingByName.set(cron.name, cron);
      }
    }

    // Build set of valid SYSTEM_CRONS names for orphan detection
    const systemCronNames = new Set(SYSTEM_CRONS.map((c) => c.name));

    let created = 0;
    let updated = 0;
    let deleted = 0;

    // Reconcile each SYSTEM_CRON entry
    for (const systemCron of SYSTEM_CRONS) {
      const existing = existingByName.get(systemCron.name);
      const enabled = existing ? existing.enabled : systemCron.enabled;

      if (existing) {
        await this.prisma.agentCronJob.delete({ where: { id: existing.id } });
        updated++;
      } else {
        created++;
      }

      await this.prisma.agentCronJob.create({
        data: {
          agentId,
          name: systemCron.name,
          system: true,
          schedule: systemCron.schedule,
          prompt: systemCron.prompt,
          silent: systemCron.silent ?? false,
          preCheck: systemCron.preCheck ?? null,
          channel: null,
          user: null,
          enabled,
        },
      });
    }

    // Orphan pass: delete any system cron whose name is not in SYSTEM_CRONS.
    for (const cron of existingSystemCrons) {
      if (!cron.name || !systemCronNames.has(cron.name)) {
        await this.prisma.agentCronJob.delete({ where: { id: cron.id } });
        deleted++;
      }
    }

    return { created, updated, deleted };
  }
}

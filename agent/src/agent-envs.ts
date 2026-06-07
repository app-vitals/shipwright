/**
 * agent/src/agent-envs.ts
 * AgentEnvService — generic env var store for deployed agents.
 *
 * Keys are env var names (e.g. SLACK_BOT_TOKEN). Values are encrypted at rest
 * using SHIPWRIGHT_ENCRYPTION_KEY (AES-256-GCM).
 */

import { type Clock, SystemClock } from "./clock.ts";
import { ApiError, UnprocessableEntityError } from "./errors.ts";
import type { PrismaClient } from "../prisma/client/index.js";
import type { TokenCrypto } from "./token-crypto.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentEnvBundle {
  /** All stored env vars (decrypted). */
  env: Record<string, string>;
  agentId: string;
  /** Enabled tool patterns for this agent. */
  allowedTools: string[];
}

export interface AgentEnvEntry {
  agentId: string;
  env: Record<string, string>;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class AgentEnvService {
  constructor(
    private prisma: PrismaClient,
    private crypto: TokenCrypto,
    private clock: Clock = SystemClock(),
  ) {}

  /**
   * Replace all env vars for the given agent (delete existing + insert new).
   * Validates that agentId references an existing Agent.
   */
  async upsert(agentId: string, env: Record<string, string>): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new UnprocessableEntityError("agent not found");
    }

    const now = this.clock.now();
    const rows = Object.entries(env).map(([key, value]) => ({
      agentId,
      key,
      value: this.crypto.encrypt(value),
      updatedAt: now,
    }));

    await this.prisma.$transaction([
      this.prisma.agentEnv.deleteMany({ where: { agentId } }),
      ...rows.map((row) =>
        this.prisma.agentEnv.create({
          data: {
            agentId: row.agentId,
            key: row.key,
            value: row.value,
            updatedAt: row.updatedAt,
          },
        }),
      ),
    ]);
  }

  /**
   * Upsert specific keys for the given agent without touching other keys.
   * Validates that agentId references an existing Agent.
   */
  async patch(agentId: string, env: Record<string, string>): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new UnprocessableEntityError("agent not found");
    }

    const now = this.clock.now();
    await this.prisma.$transaction(
      Object.entries(env).map(([key, value]) =>
        this.prisma.agentEnv.upsert({
          where: { agentId_key: { agentId, key } },
          create: {
            agentId,
            key,
            value: this.crypto.encrypt(value),
            updatedAt: now,
          },
          update: { value: this.crypto.encrypt(value), updatedAt: now },
        }),
      ),
    );
  }

  /**
   * Get all env vars for an agent (decrypted).
   * Returns null if the agent has no env vars set.
   */
  async getByAgentId(agentId: string): Promise<Record<string, string> | null> {
    const rows = await this.prisma.agentEnv.findMany({ where: { agentId } });
    if (rows.length === 0) return null;
    return this.decryptRows(rows);
  }

  /**
   * Returns the full env bundle for an agent — stored env vars (decrypted) plus
   * allowed tools.
   *
   * Returns null if the agent has no env vars set.
   * Throws 500 if decryption fails.
   */
  async getConfigBundle(agentId: string): Promise<AgentEnvBundle | null> {
    const rows = await this.prisma.agentEnv.findMany({ where: { agentId } });
    if (rows.length === 0) return null;

    let env: Record<string, string>;
    try {
      env = this.decryptRows(rows);
    } catch (err) {
      console.error("[shipwright agent] failed to decrypt agent env vars", err);
      throw new ApiError(500, "failed to decrypt agent env vars");
    }

    const tools = await this.prisma.agentTool.findMany({
      where: { agentId, enabled: true },
    });

    return {
      env,
      agentId,
      allowedTools: tools.map((t: { pattern: string }) => t.pattern),
    };
  }

  /**
   * Delete a single env var key for the given agent.
   * No-ops if the key does not exist.
   */
  async deleteKey(agentId: string, key: string): Promise<void> {
    await this.prisma.agentEnv.deleteMany({ where: { agentId, key } });
  }

  /**
   * List all agents with their decrypted env vars.
   */
  async listAll(): Promise<AgentEnvEntry[]> {
    const rows = await this.prisma.agentEnv.findMany();

    // Group by agentId
    const byAgent = new Map<string, typeof rows>();
    for (const row of rows) {
      const existing = byAgent.get(row.agentId) ?? [];
      existing.push(row);
      byAgent.set(row.agentId, existing);
    }

    return Array.from(byAgent.entries()).map(([agentId, agentRows]) => ({
      agentId,
      env: this.decryptRows(agentRows),
    }));
  }

  private decryptRows(
    rows: Array<{ key: string; value: string }>,
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const row of rows) {
      env[row.key] = this.crypto.decrypt(row.value);
    }
    return env;
  }
}

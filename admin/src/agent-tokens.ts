/**
 * agent/src/agent-tokens.ts
 * AgentTokenService — scoped API tokens for agent authentication.
 *
 * The raw token (64-char hex) is returned once at creation; only the SHA-256
 * hash is stored. Token validation is O(1) via the unique index on `token`.
 */

import { createHash, randomBytes } from "node:crypto";
import type { AgentToken, PrismaClient } from "../prisma/client/index.js";
import { type Clock, SystemClock } from "./clock.ts";
import { UnprocessableEntityError } from "./errors.ts";

export type { AgentToken };

export interface AgentTokenValidated {
  agentId: string;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateRawToken(): string {
  return randomBytes(32).toString("hex");
}

export class AgentTokenService {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
  ) {}

  /**
   * Create a new token for an agent.
   * Returns the token record plus the raw token — only opportunity to read it.
   * Throws UnprocessableEntityError if agentId doesn't reference an existing Agent.
   */
  async create(
    agentId: string,
    label?: string,
  ): Promise<{ token: AgentToken; rawToken: string }> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent) {
      throw new UnprocessableEntityError("agentId not found");
    }

    const rawToken = generateRawToken();
    const hashed = hashToken(rawToken);

    const token = await this.prisma.agentToken.create({
      data: { agentId, token: hashed, label },
    });

    return { token, rawToken };
  }

  /**
   * Validate a raw token. Returns { agentId } if valid and not revoked,
   * or null if the token is unknown or revoked.
   */
  async validate(raw: string): Promise<AgentTokenValidated | null> {
    const hashed = hashToken(raw);
    const record = await this.prisma.agentToken.findUnique({
      where: { token: hashed },
    });
    if (!record || record.revokedAt !== null) return null;
    return { agentId: record.agentId };
  }

  /**
   * Revoke a token by ID. Returns the updated record, or null if not found (P2025).
   * Re-throws all other errors so real failures aren't silently swallowed.
   */
  async revoke(tokenId: string): Promise<AgentToken | null> {
    try {
      return await this.prisma.agentToken.update({
        where: { id: tokenId },
        data: { revokedAt: this.clock.now() },
      });
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "P2025"
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * List tokens for a given agent (without the hashed token value).
   */
  async listForAgent(agentId: string): Promise<AgentToken[]> {
    return this.prisma.agentToken.findMany({
      where: { agentId },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Get a single token by ID. Used for ownership checks before mutating.
   */
  async getById(tokenId: string): Promise<AgentToken | null> {
    return this.prisma.agentToken.findUnique({ where: { id: tokenId } });
  }
}

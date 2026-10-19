/**
 * admin/src/agent-anthropic-identity.ts
 * AgentAnthropicIdentityService — typed read/update of an agent's owner and
 * Anthropic identity columns (PAI-1.1). All fields are nullable; a duplicate
 * anthropicIdentityName (unique index) surfaces as a ConflictError.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import { ConflictError, NotFoundError } from "./errors.ts";

export interface AgentAnthropicIdentity {
  ownerEmail: string | null;
  anthropicIdentityName: string | null;
  anthropicServiceAccountId: string | null;
  anthropicFederationRuleId: string | null;
  k8sServiceAccountName: string | null;
}

/** Partial update — omitted keys are left untouched, null clears a field. */
export type AgentAnthropicIdentityUpdate = Partial<AgentAnthropicIdentity>;

const IDENTITY_KEYS = [
  "ownerEmail",
  "anthropicIdentityName",
  "anthropicServiceAccountId",
  "anthropicFederationRuleId",
  "k8sServiceAccountName",
] as const satisfies readonly (keyof AgentAnthropicIdentity)[];

const IDENTITY_SELECT = {
  ownerEmail: true,
  anthropicIdentityName: true,
  anthropicServiceAccountId: true,
  anthropicFederationRuleId: true,
  k8sServiceAccountName: true,
} as const;

function prismaCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

export class AgentAnthropicIdentityService {
  constructor(private prisma: PrismaClient) {}

  /** Returns the identity fields, or null if the agent does not exist. */
  async get(agentId: string): Promise<AgentAnthropicIdentity | null> {
    return this.prisma.agent.findUnique({
      where: { id: agentId },
      select: IDENTITY_SELECT,
    });
  }

  /**
   * Update the provided identity fields.
   * @throws NotFoundError if the agent does not exist
   * @throws ConflictError if anthropicIdentityName is already used
   */
  async set(
    agentId: string,
    update: AgentAnthropicIdentityUpdate,
  ): Promise<AgentAnthropicIdentity> {
    const data: AgentAnthropicIdentityUpdate = {};
    for (const key of IDENTITY_KEYS) {
      if (update[key] !== undefined) data[key] = update[key];
    }
    try {
      return await this.prisma.agent.update({
        where: { id: agentId },
        data,
        select: IDENTITY_SELECT,
      });
    } catch (err) {
      if (prismaCode(err) === "P2002") {
        throw new ConflictError("anthropicIdentityName is already in use");
      }
      if (prismaCode(err) === "P2025") {
        throw new NotFoundError(`Agent ${agentId} not found`);
      }
      throw err;
    }
  }
}

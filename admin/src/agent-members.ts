/**
 * agent/src/agent-members.ts
 * AgentMemberService — authorized human members per agent (access control).
 *
 * Membership rows are keyed by [agentId, email] (unique constraint) — an
 * email can be a member of multiple agents, and an agent can have multiple
 * member emails.
 */

import type { AgentMember, PrismaClient } from "../prisma/client/index.js";

export type { AgentMember };

export class AgentMemberService {
  constructor(private prisma: PrismaClient) {}

  /**
   * List all memberships for a given agent.
   */
  async listByAgentId(agentId: string): Promise<AgentMember[]> {
    return this.prisma.agentMember.findMany({ where: { agentId } });
  }

  /**
   * List all memberships for a given email, case-sensitive as stored.
   * Callers are expected to lowercase the email before calling.
   */
  async listByEmail(email: string): Promise<AgentMember[]> {
    return this.prisma.agentMember.findMany({ where: { email } });
  }

  /**
   * Returns whether a membership row exists for the given agentId+email pair.
   */
  async exists(agentId: string, email: string): Promise<boolean> {
    const membership = await this.prisma.agentMember.findUnique({
      where: { agentId_email: { agentId, email } },
    });
    return membership !== null;
  }

  /**
   * Create a membership row for the given agentId and email.
   * Throws (unique-constraint violation) if the membership already exists —
   * callers are expected to catch and handle "already a member" as a no-op.
   */
  async add(agentId: string, email: string): Promise<AgentMember> {
    return this.prisma.agentMember.create({ data: { agentId, email } });
  }

  /**
   * Delete a membership by id, scoped to agentId. No-ops if the id doesn't
   * exist or belongs to a different agent.
   */
  async remove(agentId: string, memberId: string): Promise<void> {
    await this.prisma.agentMember.deleteMany({
      where: { id: memberId, agentId },
    });
  }
}

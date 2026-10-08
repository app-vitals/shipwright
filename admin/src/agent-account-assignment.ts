/**
 * admin/src/agent-account-assignment.ts
 * Post-assignment side effect for SSP-5.3 (admin assign/reassign an agent to
 * an account). The task-store scope resolver reads Agent.accountId live, so no
 * token re-mint is needed — only the tenant pod label / CPU limit (SSP-7.1)
 * has to be re-applied, by reconciling the single agent's workload.
 */

import type { AgentProvisioner } from "./agent-provisioner.ts";

/**
 * Reconciles the agent's K8s workload after its accountId changed. Self-hosted
 * agents have no workload, so they are skipped. Never throws: the DB change is
 * already committed, so a reconcile failure is returned as a warning string
 * (the next full reconcile pass will converge it) instead of failing the call.
 */
export async function reconcileAgentAfterAccountChange(
  provisioner: Pick<AgentProvisioner, "reconcile">,
  agent: {
    id: string;
    name: string;
    selfHosted: boolean;
    accountId?: string | null;
  },
): Promise<string | undefined> {
  if (agent.selfHosted) return undefined;
  try {
    const result = await provisioner.reconcile([
      { id: agent.id, slug: agent.name, accountId: agent.accountId ?? null },
    ]);
    const failure = result.failed.find((f) => f.agentId === agent.id);
    return failure
      ? `account updated, but reconciling the agent workload failed: ${failure.error}`
      : undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `account updated, but reconciling the agent workload failed: ${message}`;
  }
}

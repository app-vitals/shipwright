/**
 * admin/src/startup-policy-reconcile.ts
 *
 * One-shot policy-only reconcile run on admin startup (ACP-1.3).
 *
 * The chart passes the Claude policy hash to admin as an env var, so a policy
 * change restarts admin. On boot this pass walks every managed agent through
 * `provisioner.reconcile(..., { policyOnly: true })`, which patches only the
 * policy wiring (volume, mount, hash annotation) — so only agents whose policy
 * actually changed roll. It runs whether or not a policy is configured, so
 * agents lose the mount after the policy is disabled.
 *
 * Never throws: a Kubernetes or database failure is logged and admin keeps
 * serving. Called once from main.ts after Bun.serve.
 */

import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { AgentService, AgentSummary } from "./agents.ts";

export interface StartupPolicyReconcileDeps {
  agentService: Pick<AgentService, "list">;
  provisioner: Pick<AgentProvisioner, "canProvision" | "reconcile">;
  logger: Pick<Console, "log" | "error">;
}

/**
 * The reconcile targets for a list of agents. Self-hosted agents manage their
 * own workloads, so they are excluded from K8s reconciliation. Shared with
 * POST /agents/reconcile so both paths select agents the same way.
 */
export function managedReconcileTargets(
  agents: AgentSummary[],
): Parameters<AgentProvisioner["reconcile"]>[0] {
  return agents
    .filter((a) => !a.selfHosted)
    .map((a) => ({ id: a.id, slug: a.name, accountId: a.accountId }));
}

export async function runStartupPolicyReconcile({
  agentService,
  provisioner,
  logger,
}: StartupPolicyReconcileDeps): Promise<void> {
  if (!provisioner.canProvision) return;

  try {
    const targets = managedReconcileTargets(await agentService.list());
    const result = await provisioner.reconcile(targets, { policyOnly: true });
    logger.log(
      `[startup-policy-reconcile] agents=${targets.length} updated=${result.updated.length} recreated=${result.recreated.length} orphans=${result.orphans.length} failed=${result.failed.length}`,
    );
    for (const { agentId, error } of result.failed) {
      logger.error(
        `[startup-policy-reconcile] agent ${agentId} failed: ${error}`,
      );
    }
  } catch (err) {
    logger.error("[startup-policy-reconcile] reconcile failed:", err);
  }
}

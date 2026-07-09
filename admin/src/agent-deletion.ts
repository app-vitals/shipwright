/**
 * admin/src/agent-deletion.ts
 *
 * Single shared orchestration for fully deleting a Shipwright agent. Both
 * agent-delete entry points (DELETE /agents/:id in agents-api.ts, and the
 * admin-ui "danger zone" POST /admin/agents/:id/delete handler) are meant to
 * call this instead of independently calling provisioner.deprovision() +
 * prisma.agent.delete() — wiring that up is a separate future task
 * (ADC-4.1/ADC-4.2). This module only defines the shared function.
 *
 * Critical ordering requirement: the Agent DB row is deleted LAST, and only
 * once every automatable cleanup step has succeeded. This makes the whole
 * operation idempotent and retryable — a caller can invoke deleteAgentFully
 * again after a partial failure and it will only re-attempt what didn't
 * finish, because every underlying step is individually idempotent:
 *   - provisioner.deprovision() swallows 404s on the Deployment/Secret/PVC.
 *   - task-store / chat-service revokeToken() tolerate an already-revoked
 *     (404) token.
 *   - chat-service deleteThreadsForAgent() tolerates already-deleted (404)
 *     threads.
 *
 * Out of scope (decided during planning): no mutation of task-store Task
 * rows (assignee/claimedBy) for the deleted agent — tasks keep their
 * historical assignment.
 */

import {
  type ManualStep,
  buildManualStepsChecklist,
} from "./agent-deletion-checklist.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { ChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import type { SlackProvisioningClient } from "./slack-provisioning-client.ts";
import type { TaskStoreProvisioningClient } from "./task-store-provisioning-client.ts";
import { type TokenCrypto, identityCrypto } from "./token-crypto.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Name of one automatable cleanup step, used in `completed` / `failed`. */
export type AgentDeletionStep = "k8s" | "task-store" | "chat-service" | "slack";

export interface DeleteAgentResult {
  /**
   * True only when every applicable automated step succeeded and the Agent
   * DB row (plus its cascaded children) was actually deleted.
   */
  agentDeleted: boolean;
  /** Steps that ran and succeeded this call. */
  completed: AgentDeletionStep[];
  /** Steps that ran and threw, with their error message. */
  failed: { step: AgentDeletionStep; error: string }[];
  /** Operator-facing reminders that require manual follow-up. Never blocks. */
  manualStepsRequired: ManualStep[];
}

/** Row shape read from AgentEnv — `value` is the raw (encrypted-at-rest) column. */
interface AgentEnvRow {
  key: string;
  value: string;
  secret: boolean;
}

/**
 * Minimal Prisma shape deleteAgentFully() depends on — not the full
 * PrismaClient type, per the test-isolation convention (injected fakes only
 * need to implement what's actually called).
 */
export interface AgentDeletionPrismaDeps {
  agent: {
    findUnique(args: {
      where: { id: string };
      include: { envVars: true };
    }): Promise<{
      id: string;
      name: string;
      envVars: AgentEnvRow[];
    } | null>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

export interface AgentDeletionDeps {
  prisma: AgentDeletionPrismaDeps;
  provisioner: Pick<AgentProvisioner, "deprovision">;
  taskStoreClient: Pick<
    TaskStoreProvisioningClient,
    "listTokensForAgent" | "revokeToken"
  >;
  chatServiceClient: Pick<
    ChatServiceProvisioningClient,
    "listTokensForAgent" | "revokeToken" | "deleteThreadsForAgent"
  >;
  slackClient: Pick<SlackProvisioningClient, "deleteApp">;
  /**
   * Decrypts AgentEnv.value (always encrypted at rest — see agent-envs.ts).
   * Needed to resolve the real SLACK_APP_ID value for slackClient.deleteApp().
   * Defaults to identityCrypto (plain text passthrough) — matching how other
   * modules default when SHIPWRIGHT_ENCRYPTION_KEY is unset — so callers that
   * don't need Slack cleanup, and tests, can omit it.
   */
  crypto?: TokenCrypto;
}

export interface DeleteAgentFullyOpts {
  /**
   * Slack user token, supplied per-request (same UX as the existing
   * sync-manifest flow in admin-ui.ts). Required to actually call
   * slackClient.deleteApp() — Slack tokens are never persisted server-side.
   */
  xoxpToken?: string;
}

const SLACK_APP_ID_KEY = "SLACK_APP_ID";

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * Idempotently delete an agent and every automatable resource tied to it.
 * The Agent DB row is deleted LAST, and only when every step attempted this
 * call succeeded — see the module doc comment for the retry contract.
 *
 * Throws if the agent does not exist (nothing to orchestrate).
 */
export async function deleteAgentFully(
  agentId: string,
  deps: AgentDeletionDeps,
  opts?: DeleteAgentFullyOpts,
): Promise<DeleteAgentResult> {
  const agent = await deps.prisma.agent.findUnique({
    where: { id: agentId },
    include: { envVars: true },
  });
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  const completed: AgentDeletionStep[] = [];
  const failed: DeleteAgentResult["failed"] = [];

  const runStep = async (
    step: AgentDeletionStep,
    fn: () => Promise<void>,
  ): Promise<void> => {
    try {
      await fn();
      completed.push(step);
    } catch (err) {
      failed.push({
        step,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 1. K8s Deployment + Secret + PVC — idempotent, 404-tolerant.
  await runStep("k8s", () =>
    deps.provisioner.deprovision(agentId, { slug: agent.name }),
  );

  // 2. Task-store token(s) — idempotent, tolerates already-revoked.
  await runStep("task-store", async () => {
    const tokens = await deps.taskStoreClient.listTokensForAgent(agentId);
    for (const token of tokens) {
      await deps.taskStoreClient.revokeToken(token.id);
    }
  });

  // 3. Chat-service token(s) + threads — idempotent, tolerates already-gone.
  await runStep("chat-service", async () => {
    const tokens = await deps.chatServiceClient.listTokensForAgent(agentId);
    for (const token of tokens) {
      await deps.chatServiceClient.revokeToken(token.id);
    }
    await deps.chatServiceClient.deleteThreadsForAgent(agentId);
  });

  // 4. Slack app deletion — only when both a Slack app is provisioned
  // (SLACK_APP_ID present in envVars) AND a token was supplied per-request.
  // SLACK_APP_ID present with no token is NOT a failure — it becomes a
  // manual checklist entry instead. buildManualStepsChecklist() already
  // excludes SLACK_APP_ID/SLACK_SIGNING_SECRET/SLACK_BOT_TOKEN from its
  // generic output, so that "no token" entry is appended explicitly here.
  const slackAppIdRow = agent.envVars.find((e) => e.key === SLACK_APP_ID_KEY);
  const manualStepsRequired = buildManualStepsChecklist(agent.envVars);

  if (slackAppIdRow) {
    if (opts?.xoxpToken) {
      const xoxpToken = opts.xoxpToken;
      const crypto = deps.crypto ?? identityCrypto;
      const appId = crypto.decrypt(slackAppIdRow.value);
      await runStep("slack", () =>
        deps.slackClient.deleteApp(xoxpToken, appId),
      );
    } else {
      manualStepsRequired.push({
        key: SLACK_APP_ID_KEY,
        message:
          "Slack app was not deleted automatically (no operator token supplied). Delete it manually via Slack app management, or retry agent deletion with an xoxp- token to delete it automatically.",
      });
    }
  }

  const allSucceeded = failed.length === 0;

  if (allSucceeded) {
    await deps.prisma.agent.delete({ where: { id: agentId } });
  }

  return {
    agentDeleted: allSucceeded,
    completed,
    failed,
    manualStepsRequired,
  };
}

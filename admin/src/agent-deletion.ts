/**
 * admin/src/agent-deletion.ts
 *
 * `deleteAgentFully()` — the single shared orchestration both agent-delete entry
 * points (DELETE /agents/:id and the admin-ui "danger zone") are wired into.
 * Previously each caller independently ran
 * `provisioner.deprovision()` + `prisma.agent.delete()` with no shared cleanup,
 * so any fix to one drifted from the other. This module centralizes the full
 * teardown so there is one place to fix.
 *
 * ── Critical ordering ──────────────────────────────────────────────────────
 * The Agent DB row is deleted LAST, and only once every automatable cleanup
 * step has succeeded. This makes the whole operation IDEMPOTENT and RETRYABLE:
 * a caller can re-invoke `deleteAgentFully` after a partial failure and it only
 * re-attempts what didn't finish, because every underlying step is itself
 * individually idempotent:
 *   - K8s deprovision swallows 404 (agent-provisioner.ts deprovision()).
 *   - Token revoke on an already-revoked token is a no-op (token-service).
 *   - Thread delete tolerates 404 (chat-service deleteThreadsForAgent()).
 *
 * The Agent row is the retry anchor: while it still exists, a retry re-reads it
 * and re-runs the remaining cleanup; once it's deleted, the operation is done.
 *
 * Steps, in order:
 *   1. Read the Agent row + its AgentEnv rows.
 *   2. K8s deprovision (Deployment + Secret + PVC).
 *   3. Revoke task-store token(s).
 *   4. Revoke chat-service token(s) + delete chat threads.
 *   5. (Optional) Delete the Slack app, gated on a supplied user token.
 *   6. Build the secret checklist (always included, never blocks).
 *   7. If every automatable step succeeded → delete the Agent row.
 *   8. Otherwise → leave the Agent row in place so the caller can retry.
 *
 * Out of scope (decided during planning): no mutation of task-store Task rows
 * for the deleted agent — tasks keep their historical assignment.
 */

import {
  type ManualStep,
  buildManualStepsChecklist,
} from "./agent-deletion-checklist.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { ChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import { NotFoundError } from "./errors.ts";
import type { SlackProvisioningClient } from "./slack-provisioning-client.ts";
import type { TaskStoreProvisioningClient } from "./task-store-provisioning-client.ts";

// ─── Step identifiers ─────────────────────────────────────────────────────────

/**
 * Stable identifiers for each automatable cleanup step. Used both in the
 * `completed` list and to tag entries in the `failed` array so a caller (or a
 * test) can tell exactly which dependency broke.
 */
export type DeleteAgentStep =
  | "k8s"
  | "task-store-tokens"
  | "chat-service-tokens-and-threads"
  | "slack-app";

/** A step that threw, with its error message for the caller to log/surface. */
export interface FailedStep {
  step: DeleteAgentStep;
  error: string;
}

// ─── Result ────────────────────────────────────────────────────────────────────

export interface DeleteAgentResult {
  /**
   * True only when every automatable step succeeded AND the Agent row was
   * deleted. False when any step failed (the row is left in place for retry).
   */
  agentDeleted: boolean;
  /** Steps that completed successfully, in execution order. */
  completed: DeleteAgentStep[];
  /**
   * Steps that failed. Empty when `agentDeleted` is true. A failed step does
   * NOT abort the remaining steps — they are still attempted so a single retry
   * makes maximum forward progress.
   */
  failed: FailedStep[];
  /**
   * Operator-facing manual reminders (hand-pasted secrets with no automated
   * revocation, plus an optional Slack-app entry when a token wasn't supplied).
   * Always populated; never blocks the delete.
   */
  manualStepsRequired: ManualStep[];
}

// ─── Dependencies (DI boundary) ─────────────────────────────────────────────────

/**
 * Minimal Prisma surface this orchestration needs: read the Agent row, read its
 * AgentEnv rows, and delete the Agent row (cascades child rows). Typed as a
 * structural shape rather than `Pick<PrismaClient, ...>` so tests can inject a
 * tiny in-memory double without pulling in the generated client.
 */
export interface DeleteAgentPrisma {
  agent: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; name: true };
    }): Promise<{ id: string; name: string } | null>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  agentEnv: {
    findMany(args: {
      where: { agentId: string };
      select: { key: true; value: true; secret: true };
    }): Promise<{ key: string; value: string; secret: boolean }[]>;
  };
}

export interface DeleteAgentFullyDeps {
  prisma: DeleteAgentPrisma;
  provisioner: Pick<AgentProvisioner, "deprovision">;
  taskStore: Pick<TaskStoreProvisioningClient, "listTokensForAgent" | "revokeToken">;
  chatService: Pick<
    ChatServiceProvisioningClient,
    "listTokensForAgent" | "revokeToken" | "deleteThreadsForAgent"
  >;
  slack: Pick<SlackProvisioningClient, "deleteApp">;
  /**
   * Decrypt a stored AgentEnv value. AgentEnv values are AES-256-GCM encrypted
   * at rest; only the SLACK_APP_ID value is decrypted here (to pass to the
   * Slack delete call). Injected so the orchestration stays free of concrete
   * crypto and is trivially unit-testable.
   */
  decrypt(value: string): string;
}

export interface DeleteAgentFullyOpts {
  /**
   * Slack user token (xoxp-) authorizing the Slack app deletion. Supplied
   * per-request (same UX as the sync-manifest flow) — when omitted, a Slack app
   * (if present) is NOT auto-deleted and instead becomes a manual checklist
   * entry. Its absence is never a failure.
   */
  xoxpToken?: string;
}

// ─── Orchestration ──────────────────────────────────────────────────────────────

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Fully delete an agent: tear down its workload and external state, then delete
 * the Agent DB row LAST (only if every automatable step succeeded).
 *
 * Idempotent and retryable — see the module header. Throws `NotFoundError` only
 * when the Agent row is genuinely absent at the start of the call: that means
 * either the id was never valid, or a prior call already completed the delete.
 * Treating a missing row as an error (rather than a silent success) keeps retry
 * semantics honest — the caller asked to delete something that isn't there. A
 * caller that races two deletes can catch it; the common retry-after-partial
 * path always still sees the row (it's deleted last) and proceeds normally.
 */
export async function deleteAgentFully(
  agentId: string,
  deps: DeleteAgentFullyDeps,
  opts: DeleteAgentFullyOpts = {},
): Promise<DeleteAgentResult> {
  // ── Step 1: read the Agent row + its AgentEnv rows ──────────────────────────
  const agent = await deps.prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, name: true },
  });
  if (!agent) {
    throw new NotFoundError(`agent ${agentId} not found`);
  }
  const envRows = await deps.prisma.agentEnv.findMany({
    where: { agentId },
    select: { key: true, value: true, secret: true },
  });

  const completed: DeleteAgentStep[] = [];
  const failed: FailedStep[] = [];

  const runStep = async (
    step: DeleteAgentStep,
    fn: () => Promise<void>,
  ): Promise<void> => {
    try {
      await fn();
      completed.push(step);
    } catch (err) {
      failed.push({ step, error: errMessage(err) });
    }
  };

  // ── Step 2: K8s deprovision (Deployment + Secret + PVC) ─────────────────────
  await runStep("k8s", async () => {
    await deps.provisioner.deprovision(agentId, { slug: agent.name });
  });

  // ── Step 3: revoke task-store token(s) ──────────────────────────────────────
  await runStep("task-store-tokens", async () => {
    await revokeAllTokens(deps.taskStore, agentId);
  });

  // ── Step 4: revoke chat-service token(s) + delete chat threads ──────────────
  await runStep("chat-service-tokens-and-threads", async () => {
    await revokeAllTokens(deps.chatService, agentId);
    await deps.chatService.deleteThreadsForAgent(agentId);
  });

  // ── Step 5: (optional) delete the Slack app ─────────────────────────────────
  // Only present when the agent stores a SLACK_APP_ID. Gated on a supplied user
  // token: with one we auto-delete (a real cleanup step that can fail); without
  // one it's an expected manual gap that adds a checklist entry, not a failure.
  const slackAppIdRow = envRows.find((r) => r.key === "SLACK_APP_ID");
  const manualSlackSteps: ManualStep[] = [];
  if (slackAppIdRow) {
    const slackAppId = deps.decrypt(slackAppIdRow.value);
    if (opts.xoxpToken) {
      await runStep("slack-app", async () => {
        await deps.slack.deleteApp(opts.xoxpToken as string, slackAppId);
      });
    } else {
      manualSlackSteps.push({
        key: "SLACK_APP_ID",
        message: `Slack app ${slackAppId} was not deleted automatically — no Slack user token was supplied. Delete it manually at api.slack.com/apps or retry with a token.`,
      });
    }
  }

  // ── Step 6: build the secret checklist (always included) ────────────────────
  const manualStepsRequired = [
    ...buildManualStepsChecklist(envRows),
    ...manualSlackSteps,
  ];

  // ── Steps 7/8: delete the Agent row LAST, only if nothing failed ────────────
  if (failed.length === 0) {
    await deps.prisma.agent.delete({ where: { id: agentId } });
    return { agentDeleted: true, completed, failed, manualStepsRequired };
  }

  return { agentDeleted: false, completed, failed, manualStepsRequired };
}

/**
 * List every token scoped to the agent and revoke each. Revocation is
 * individually idempotent (already-revoked / 404 is a no-op), so one failure
 * mid-loop doesn't abort the rest — we attempt every token, then re-throw the
 * first error so the enclosing step is recorded as failed for retry.
 */
async function revokeAllTokens(
  client: Pick<
    TaskStoreProvisioningClient,
    "listTokensForAgent" | "revokeToken"
  >,
  agentId: string,
): Promise<void> {
  const tokens = await client.listTokensForAgent(agentId);
  let firstError: unknown;
  for (const token of tokens) {
    try {
      await client.revokeToken(token.id);
    } catch (err) {
      if (firstError === undefined) firstError = err;
    }
  }
  if (firstError !== undefined) throw firstError;
}

/**
 * admin/src/agent-deletion-checklist.ts
 *
 * Pure builder for the operator-facing "manual steps" checklist surfaced when
 * an agent is deleted. Several agent secrets (GH_TOKEN, LINEAR_API_KEY,
 * STRIPE_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ...) are
 * hand-pasted into AgentEnv with no stored ID/owner metadata, so no automated
 * revocation is possible on agent delete. Rather than silently dropping them,
 * this module turns the agent's `AgentEnv` rows into a reminder checklist for
 * the operator to work through by hand.
 *
 * Uses the existing `AgentEnv.secret` boolean (checked by default in the "add
 * env var" admin UI form) — no schema changes needed.
 *
 * This function is PURE — no fs, no network, no Prisma, no clock. It only
 * shapes plain objects from plain objects, so it's unit-tested in isolation
 * without a DB. See ./agent-manifest.ts for the same "pure builder" pattern.
 */

/** A single operator-facing reminder produced for one AgentEnv row. */
export interface ManualStep {
  /** The AgentEnv key this reminder is about (e.g. "GH_TOKEN"). */
  key: string;
  /** Human-readable instructions for the operator. */
  message: string;
}

/**
 * Per-agent Anthropic identity pieces still present after a failed removal.
 * A null/absent piece is already gone and gets no entry.
 */
export interface LeftoverIdentity {
  anthropicFederationRuleId?: string | null;
  anthropicServiceAccountId?: string | null;
  k8sServiceAccountName?: string | null;
}

/**
 * Keys handled by the Slack app deletion step (ADC-2.1 / ADC-3.1) — excluded
 * entirely from this checklist so operators aren't told to do the same
 * cleanup twice.
 */
const SLACK_APP_MANAGED_KEYS = new Set([
  "SLACK_APP_ID",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
]);

/**
 * Named/standard keys with specific revocation instructions. Exact-match on
 * key name — a differently-cased key (e.g. "gh_token") falls through to the
 * generic custom-secret message rather than being matched here, since
 * AgentEnv keys are conventionally upper-snake-case and we'd rather surface
 * an unexpected casing than silently apply the wrong instructions.
 */
const NAMED_KEY_INSTRUCTIONS: Record<string, string> = {
  GH_TOKEN:
    "Revoke this GitHub personal access token at https://github.com/settings/tokens (or the fine-grained PAT settings page).",
  ANTHROPIC_API_KEY: "Revoke/rotate this key in the Anthropic console.",
  CLAUDE_CODE_OAUTH_TOKEN:
    "Revoke this token via `claude auth logout` or the Anthropic console.",
};

/**
 * Build the manual-steps checklist for the given `AgentEnv` rows.
 *
 * Bucketing:
 * - Named/standard keys (GH_TOKEN, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN)
 *   get a specific instruction.
 * - Slack-app-managed keys (SLACK_APP_ID, SLACK_SIGNING_SECRET,
 *   SLACK_BOT_TOKEN) are excluded — handled by the Slack app deletion step.
 * - Any other row with `secret: true` gets a generic "verify manually"
 *   reminder, naming the key.
 * - Rows with `secret: false` never produce an entry, regardless of key name.
 *
 * Order-preserving and non-deduplicating: one `ManualStep` per matching input
 * row, in input order (duplicate keys produce duplicate entries).
 *
 * `leftoverIdentity` (optional) appends one entry per per-agent Anthropic
 * identity piece still present after a failed removal, in removal order:
 * federation rule, Anthropic service account, Kubernetes ServiceAccount.
 */
export function buildManualStepsChecklist(
  envRows: { key: string; secret: boolean }[],
  leftoverIdentity?: LeftoverIdentity,
): ManualStep[] {
  const steps: ManualStep[] = [];

  for (const row of envRows) {
    if (!row.secret) continue;
    if (SLACK_APP_MANAGED_KEYS.has(row.key)) continue;

    const namedInstruction = NAMED_KEY_INSTRUCTIONS[row.key];
    if (namedInstruction !== undefined) {
      steps.push({ key: row.key, message: namedInstruction });
      continue;
    }

    steps.push({
      key: row.key,
      message: `Custom secret '${row.key}' was added manually and has no automated revocation — verify whether it needs to be revoked at the source.`,
    });
  }

  // Identity pieces the automated removal left behind, in removal order. The
  // rule goes first: Anthropic refuses to archive a service account while a
  // live rule references it.
  if (leftoverIdentity?.anthropicFederationRuleId) {
    steps.push({
      key: "anthropicFederationRuleId",
      message: `Anthropic federation rule ${leftoverIdentity.anthropicFederationRuleId} was not archived automatically — archive it in the Anthropic console first (a service account cannot be archived while a live rule references it).`,
    });
  }
  if (leftoverIdentity?.anthropicServiceAccountId) {
    steps.push({
      key: "anthropicServiceAccountId",
      message: `Anthropic service account ${leftoverIdentity.anthropicServiceAccountId} was not archived automatically — archive it in the Anthropic console once its federation rule is archived.`,
    });
  }
  if (leftoverIdentity?.k8sServiceAccountName) {
    steps.push({
      key: "k8sServiceAccountName",
      message: `Kubernetes ServiceAccount ${leftoverIdentity.k8sServiceAccountName} was not deleted automatically — delete it from the agent namespace with kubectl.`,
    });
  }

  return steps;
}

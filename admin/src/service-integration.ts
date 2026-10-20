/**
 * admin/src/service-integration.ts
 *
 * The seam for optional per-agent service integrations in agent provisioning.
 *
 * An integration is an external service (task-store today) for which the
 * provisioner mints a per-agent token on create, stores it in the agent Secret
 * under `secretKey`, and injects `tokenEnv` (secretKeyRef) + `urlEnv` (plain
 * value) into the agent Deployment; agent deletion revokes every token scoped
 * to the agent. Integrations are supplied by the composition root through
 * AdminExtension.serviceIntegrations(env) — the platform never names one.
 *
 * Chat-service stays a built-in platform integration (it has extra thread
 * cleanup on delete) and is handled alongside, not through this list.
 *
 * Ordering contract: extension integrations are processed in list order and
 * ALWAYS before the built-in chat-service integration — minting, Secret keys,
 * Deployment env entries, rollback revocation and deletion steps all follow
 * that order. (This reproduces the original task-store-before-chat order.)
 */

/** Token operations a service exposes to the provisioner and deletion flow. */
export interface ServiceTokenClient {
  /** Mint a per-agent token; `id` is needed to revoke it on rollback. */
  mintToken(
    label: string,
    agentId?: string,
  ): Promise<{ id: string; rawToken: string }>;
  /** Revoke a previously-minted token. Idempotent (already-gone is a no-op). */
  revokeToken(id: string): Promise<void>;
  /** List the ids of every token scoped to `agentId` (for deletion cleanup). */
  listTokensForAgent(agentId: string): Promise<{ id: string }[]>;
}

/** How an integration shows up in the agent Secret and Deployment. */
export interface ServiceEnvSpec {
  /** Env var carrying the per-agent token (secretKeyRef into the agent Secret). */
  tokenEnv: string;
  /** Env var carrying the service base URL (plain value). */
  urlEnv: string;
  /** Key within the agent Secret under which the token is stored. */
  secretKey: string;
  /** In-cluster base URL. Absent = integration not configured for provisioning. */
  url?: string;
}

export interface ServiceIntegration extends ServiceTokenClient, ServiceEnvSpec {
  /** Stable name; deletion reports the step as `${name}-tokens`. */
  name: string;
}

/** The subset of an integration the deletion flow needs. */
export type DeletionServiceIntegration = Pick<
  ServiceIntegration,
  "name" | "listTokensForAgent" | "revokeToken"
>;

/**
 * The integrations the provisioner should actively wire (mint + env): those
 * with a URL. Unconfigured integrations are kept in the full list so deletion
 * still runs (and reports) their step, matching the former no-op client.
 */
export function provisionableIntegrations(
  integrations: readonly ServiceIntegration[] | undefined,
): ServiceIntegration[] {
  return (integrations ?? []).filter((i) => Boolean(i.url));
}

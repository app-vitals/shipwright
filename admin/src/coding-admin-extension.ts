/**
 * admin/src/coding-admin-extension.ts
 *
 * Shipwright's coding AdminExtension: the home for the coding agent's admin
 * surfaces (task-store views, dev-task adherence, work queue, sessions). Today
 * it registers the task-store service integration (per-agent task-store tokens
 * minted on provision and revoked on delete); the other surfaces still live in
 * the platform and move here in later tasks.
 */

import type { AdminExtension } from "./admin-extension.ts";
import {
  HttpTaskStoreProvisioningClient,
  NoopTaskStoreProvisioningClient,
} from "./coding-task-store-provisioning-client.ts";
import type { ServiceIntegration } from "./service-integration.ts";

/**
 * The task-store integration, built from SHIPWRIGHT_TASK_STORE_URL and
 * SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN. Always returned so agent deletion still
 * runs its `task-store-tokens` step; with either var unset it carries a no-op
 * client and no URL, so provisioning skips it (no token, no env).
 */
export function taskStoreServiceIntegration(
  env: NodeJS.ProcessEnv,
): ServiceIntegration {
  const url = env.SHIPWRIGHT_TASK_STORE_URL;
  const adminToken = env.SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN;
  const configured = Boolean(url && adminToken);
  const client =
    url && adminToken
      ? new HttpTaskStoreProvisioningClient(url, adminToken)
      : new NoopTaskStoreProvisioningClient();
  return {
    name: "task-store",
    tokenEnv: "SHIPWRIGHT_TASK_STORE_TOKEN",
    urlEnv: "SHIPWRIGHT_TASK_STORE_URL",
    secretKey: "task-store-token",
    ...(configured ? { url } : {}),
    mintToken: (label, agentId) => client.mintToken(label, agentId),
    revokeToken: (id) => client.revokeToken(id),
    listTokensForAgent: (agentId) => client.listTokensForAgent(agentId),
  };
}

export const codingAdminExtension: AdminExtension = {
  name: "coding",
  serviceIntegrations: (env) => [taskStoreServiceIntegration(env)],
};

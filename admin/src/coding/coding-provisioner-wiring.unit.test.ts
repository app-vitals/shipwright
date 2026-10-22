import { describe, expect, it } from "bun:test";
import { buildProvisioner } from "../admin-boot-config.ts";
import { collectServiceIntegrations } from "../admin-extension.ts";
import type {
  AgentProvisioner,
  KubernetesAgentProvisionerConfig,
} from "../agent-provisioner.ts";
import type { AgentTokenService } from "../agent-tokens.ts";
import { adminExtensions } from "../main.ts";

/** Stub token service — buildProvisioner only threads it through, never calls it. */
function stubAgentTokenService(): AgentTokenService {
  return {} as unknown as AgentTokenService;
}

/** Reaches into the private `config` field so branch behavior is actually verifiable. */
function configOf(
  provisioner: AgentProvisioner,
): KubernetesAgentProvisionerConfig {
  return (
    provisioner as unknown as { config: KubernetesAgentProvisionerConfig }
  ).config;
}

// Split out of main.unit.test.ts (AEP-4.1): it exercises Shipwright's admin
// composition (adminExtensions from main.ts), which stays out of the platform
// set, while the rest of main.unit.test.ts is platform code.
describe("buildProvisioner with Shipwright's composed admin extensions", () => {
  it("wires the coding extension's task-store integration only when both URL and admin token are set", () => {
    const withEnv = {
      SHIPWRIGHT_K8S_PROVISIONING: "enabled",
      SHIPWRIGHT_TASK_STORE_URL: "http://task-store.svc:3002",
      SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: "ts-admin-token",
    };
    const withTaskStore = buildProvisioner(
      withEnv,
      stubAgentTokenService(),
      undefined,
      collectServiceIntegrations(adminExtensions, withEnv),
    );
    const integrations = configOf(withTaskStore).serviceIntegrations ?? [];
    expect(integrations.map((i) => i.name)).toEqual(["task-store"]);
    expect(integrations[0]?.url).toBe("http://task-store.svc:3002");

    // Admin token missing: the integration is still registered (so deletion
    // keeps its step) but carries no URL, so provisioning skips it.
    const withoutEnv = {
      SHIPWRIGHT_K8S_PROVISIONING: "enabled",
      SHIPWRIGHT_TASK_STORE_URL: "http://task-store.svc:3002",
    };
    const withoutTaskStore = buildProvisioner(
      withoutEnv,
      stubAgentTokenService(),
      undefined,
      collectServiceIntegrations(adminExtensions, withoutEnv),
    );
    const skipped = configOf(withoutTaskStore).serviceIntegrations ?? [];
    expect(skipped.map((i) => i.url)).toEqual([undefined]);
  });
});

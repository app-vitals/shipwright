/**
 * admin/src/agent-provisioner.unit.test.ts
 * Unit tests for KubernetesAgentProvisioner PVC name template feature.
 *
 * Uses RecordedKubernetesClient (in-memory K8s double) and a stub AgentTokenService
 * so no real DB or cluster is required.
 */

import { describe, expect, it } from "bun:test";
import { sanitizeAgentName } from "./agent-manifest.ts";
import {
  KubernetesAgentProvisioner,
  type KubernetesAgentProvisionerConfig,
} from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import { RecordedKubernetesClient } from "./kubernetes-client.ts";

const NAMESPACE = "shipwright";

const BASE_CONFIG: KubernetesAgentProvisionerConfig = {
  namespace: NAMESPACE,
  image: "ghcr.io/app-vitals/shipwright-agent",
  imageTag: "v1.0.0",
  apiUrl: "http://shipwright-admin.shipwright.svc:3001",
  adminDeploymentName: "shipwright-admin",
  adminDeploymentUid: "aaaa-bbbb-cccc-dddd",
};

/** Stub token service — no DB required. */
function stubTokens(): Pick<
  AgentTokenService,
  "create" | "validate" | "listForAgent" | "revoke"
> {
  return {
    create: async (agentId: string, _label: string) => ({
      id: `tok-${agentId}`,
      rawToken: `raw-${agentId}`,
      agentId,
      label: _label,
      createdAt: new Date(),
      expiresAt: null,
    }),
    validate: async () => null,
    listForAgent: async () => [],
    revoke: async () => {},
  } as unknown as Pick<
    AgentTokenService,
    "create" | "validate" | "listForAgent" | "revoke"
  >;
}

function emptyClient(): RecordedKubernetesClient {
  return new RecordedKubernetesClient({
    deployments: {},
    secrets: {},
    pvcs: {},
  });
}

// ─── AC 1: Default behaviour unchanged ────────────────────────────────────────

describe("KubernetesAgentProvisioner.provision() — default PVC naming", () => {
  it("creates a PVC named {sanitizedAgentId}-home when no pvcName config is set", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      BASE_CONFIG,
    );

    await provisioner.provision(agentId);

    const resourceName = sanitizeAgentName(agentId);
    const expectedPvcName = `${resourceName}-home`;
    await expect(k8s.getPvc(NAMESPACE, expectedPvcName)).resolves.toBeDefined();
  });

  it("passes undefined slug → falls back to resourceName in pvcName function", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const resourceName = sanitizeAgentName(agentId);
    let capturedArgs: {
      resourceName: string;
      slug: string | undefined;
    } | null = null;

    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      pvcName: (rn, slug) => {
        capturedArgs = { resourceName: rn, slug };
        return `${rn}-home`;
      },
    };

    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      config,
    );

    await provisioner.provision(agentId);

    expect(capturedArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by the not.toBeNull() assertion above
    expect(capturedArgs!.resourceName).toBe(resourceName);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the not.toBeNull() assertion above
    expect(capturedArgs!.slug).toBeUndefined();
  });
});

// ─── AC 2: Templated PVC name with slug ───────────────────────────────────────

describe("KubernetesAgentProvisioner.provision() — templated PVC naming", () => {
  it("creates a PVC named by the template when slug is provided via opts", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const slug = "okwow";

    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      pvcName: (resourceName, s) => `vitals-os-agent-${s ?? resourceName}-home`,
    };

    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      config,
    );

    await provisioner.provision(agentId, { slug });

    // PVC must use the slug, not the sanitized agentId
    await expect(
      k8s.getPvc(NAMESPACE, "vitals-os-agent-okwow-home"),
    ).resolves.toBeDefined();

    // The default name must NOT exist
    const resourceName = sanitizeAgentName(agentId);
    await expect(
      k8s.getPvc(NAMESPACE, `vitals-os-agent-${resourceName}-home`),
    ).rejects.toThrow();
  });

  it("Deployment is created alongside the template-derived PVC", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const slug = "okwow";
    const expectedPvcName = "vitals-os-agent-okwow-home";

    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      pvcName: (resourceName, s) => `vitals-os-agent-${s ?? resourceName}-home`,
    };

    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      config,
    );

    await provisioner.provision(agentId, { slug });

    // Both the PVC and the Deployment must exist.
    // The PVC name confirms the slug was threaded through pvcNameFor().
    // (The in-memory RecordedKubernetesClient does not capture volume mounts,
    // so this is tested at the manifest level in agent-manifest tests.)
    const resourceName = sanitizeAgentName(agentId);
    await expect(k8s.getPvc(NAMESPACE, expectedPvcName)).resolves.toBeDefined();
    await expect(
      k8s.getDeployment(NAMESPACE, resourceName),
    ).resolves.toBeDefined();
  });
});

// ─── AC 3: Reconcile respects the template ────────────────────────────────────

describe("KubernetesAgentProvisioner.reconcile() — template respected", () => {
  it("re-provisions using the pvcName function when a deployment is missing", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";

    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      // Template with no slug falls back to resourceName
      pvcName: (resourceName, slug) =>
        `vitals-os-agent-${slug ?? resourceName}-home`,
    };

    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      config,
    );

    // Reconcile with a missing deployment — should provision and use the template
    const result = await provisioner.reconcile([agentId]);

    expect(result.recreated).toEqual([agentId]);
    expect(result.failed).toEqual([]);

    // PVC was created using the template (with resourceName as fallback for slug)
    const resourceName = sanitizeAgentName(agentId);
    const expectedPvcName = `vitals-os-agent-${resourceName}-home`;
    await expect(k8s.getPvc(NAMESPACE, expectedPvcName)).resolves.toBeDefined();
  });
});

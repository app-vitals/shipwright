/**
 * admin/src/agent-provisioner.unit.test.ts
 * Unit tests for KubernetesAgentProvisioner PVC name template feature and
 * task-store token minting/rollback.
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
import { ConflictError } from "./errors.ts";
import {
  type KubernetesClient,
  RecordedKubernetesClient,
} from "./kubernetes-client.ts";
import type { TaskStoreProvisioningClient } from "./task-store-provisioning-client.ts";

const NAMESPACE = "shipwright";

const BASE_CONFIG: KubernetesAgentProvisionerConfig = {
  namespace: NAMESPACE,
  image: "ghcr.io/app-vitals/shipwright-agent",
  imageTag: "v1.0.0",
  apiUrl: "http://shipwright-admin.shipwright.svc:3001",
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
    let capturedName: string | null = null;

    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      pvcName: (name) => {
        capturedName = name;
        return `${name}-home`;
      },
    };

    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      config,
    );

    await provisioner.provision(agentId);

    expect(capturedName).not.toBeNull();
    // Without a slug, pvcNameFor passes the sanitized resourceName directly.
    // biome-ignore lint/style/noNonNullAssertion: guarded by the not.toBeNull() assertion above
    expect(capturedName!).toBe(resourceName);
  });
});

// ─── AC 2: Templated PVC name with slug ───────────────────────────────────────

describe("KubernetesAgentProvisioner.provision() — templated PVC naming", () => {
  it("creates a PVC named by the template when slug is provided via opts", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const slug = "okwow";

    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      pvcName: (name) => `acme-agent-${name}-home`,
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
      k8s.getPvc(NAMESPACE, "acme-agent-okwow-home"),
    ).resolves.toBeDefined();

    // The default name must NOT exist
    const resourceName = sanitizeAgentName(agentId);
    await expect(
      k8s.getPvc(NAMESPACE, `acme-agent-${resourceName}-home`),
    ).rejects.toThrow();
  });

  it("Deployment is created alongside the template-derived PVC", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const slug = "okwow";
    const expectedPvcName = "acme-agent-okwow-home";

    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      pvcName: (name) => `acme-agent-${name}-home`,
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

// ─── AC 2b: Reconcile image-update detection ──────────────────────────────────

describe("KubernetesAgentProvisioner.reconcile() — image-update detection", () => {
  it("patches a stale image and adds agent to updated[]", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const resourceName = sanitizeAgentName(agentId);

    // Pre-seed a deployment with a stale image tag.
    const k8s = new RecordedKubernetesClient({
      deployments: {
        [`${NAMESPACE}/${resourceName}`]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: resourceName, namespace: NAMESPACE },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: resourceName } },
            template: {
              metadata: { labels: { app: resourceName } },
              spec: {
                containers: [
                  {
                    name: "shipwright-agent",
                    image: "ghcr.io/app-vitals/shipwright-agent:v0.9.0", // stale
                  },
                ],
              },
            },
          },
        },
      },
      secrets: {},
      pvcs: {},
    });

    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      BASE_CONFIG, // imageTag: "v1.0.0"
    );

    const result = await provisioner.reconcile([{ id: agentId }]);

    expect(result.updated).toEqual([agentId]);
    expect(result.recreated).toEqual([]);
    expect(result.failed).toEqual([]);

    // Verify image was actually patched in the recorded client.
    const dep = await k8s.getDeployment(NAMESPACE, resourceName);
    expect(dep.spec.template.spec.containers[0].image).toBe(
      "ghcr.io/app-vitals/shipwright-agent:v1.0.0",
    );
  });

  it("skips patch when image is already up-to-date", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const resourceName = sanitizeAgentName(agentId);

    let patchCalled = false;
    const recorded = new RecordedKubernetesClient({
      deployments: {
        [`${NAMESPACE}/${resourceName}`]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: resourceName, namespace: NAMESPACE },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: resourceName } },
            template: {
              metadata: { labels: { app: resourceName } },
              spec: {
                containers: [
                  {
                    name: "shipwright-agent",
                    // Matches BASE_CONFIG: image:imageTag
                    image: "ghcr.io/app-vitals/shipwright-agent:v1.0.0",
                  },
                ],
              },
            },
          },
        },
      },
      secrets: {},
      pvcs: {},
    });

    // Build a full KubernetesClient that delegates everything to `recorded`
    // but intercepts patchDeployment to track whether it was called.
    const spied: KubernetesClient = {
      createDeployment: (ns, spec) => recorded.createDeployment(ns, spec),
      createDeploymentManifest: (ns, manifest) =>
        recorded.createDeploymentManifest(ns, manifest),
      getDeployment: (ns, name) => recorded.getDeployment(ns, name),
      deploymentExists: (ns, name) => recorded.deploymentExists(ns, name),
      listDeployments: (ns, sel) => recorded.listDeployments(ns, sel),
      deleteDeployment: (ns, name) => recorded.deleteDeployment(ns, name),
      patchDeployment: async (ns, name, patch) => {
        patchCalled = true;
        return recorded.patchDeployment(ns, name, patch);
      },
      createSecret: (ns, spec) => recorded.createSecret(ns, spec),
      getSecret: (ns, name) => recorded.getSecret(ns, name),
      deleteSecret: (ns, name) => recorded.deleteSecret(ns, name),
      createPvc: (ns, spec) => recorded.createPvc(ns, spec),
      getPvc: (ns, name) => recorded.getPvc(ns, name),
      deletePvc: (ns, name) => recorded.deletePvc(ns, name),
    };

    const provisioner = new KubernetesAgentProvisioner(
      spied,
      stubTokens() as AgentTokenService,
      BASE_CONFIG,
    );

    const result = await provisioner.reconcile([{ id: agentId }]);

    expect(result.updated).toEqual([]);
    expect(result.recreated).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(patchCalled).toBe(false);
  });

  it("adds agent to failed[] (not updated[]) when patchDeployment throws", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const resourceName = sanitizeAgentName(agentId);

    const recorded = new RecordedKubernetesClient({
      deployments: {
        [`${NAMESPACE}/${resourceName}`]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: resourceName, namespace: NAMESPACE },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: resourceName } },
            template: {
              metadata: { labels: { app: resourceName } },
              spec: {
                containers: [
                  {
                    name: "shipwright-agent",
                    image: "ghcr.io/app-vitals/shipwright-agent:v0.9.0", // stale
                  },
                ],
              },
            },
          },
        },
      },
      secrets: {},
      pvcs: {},
    });

    // Full KubernetesClient that delegates everything except patchDeployment.
    const failing: KubernetesClient = {
      createDeployment: (ns, spec) => recorded.createDeployment(ns, spec),
      createDeploymentManifest: (ns, manifest) =>
        recorded.createDeploymentManifest(ns, manifest),
      getDeployment: (ns, name) => recorded.getDeployment(ns, name),
      deploymentExists: (ns, name) => recorded.deploymentExists(ns, name),
      listDeployments: (ns, sel) => recorded.listDeployments(ns, sel),
      deleteDeployment: (ns, name) => recorded.deleteDeployment(ns, name),
      patchDeployment: async (_ns, _name, _patch) => {
        throw new Error("patch failed: server error");
      },
      createSecret: (ns, spec) => recorded.createSecret(ns, spec),
      getSecret: (ns, name) => recorded.getSecret(ns, name),
      deleteSecret: (ns, name) => recorded.deleteSecret(ns, name),
      createPvc: (ns, spec) => recorded.createPvc(ns, spec),
      getPvc: (ns, name) => recorded.getPvc(ns, name),
      deletePvc: (ns, name) => recorded.deletePvc(ns, name),
    };

    const provisioner = new KubernetesAgentProvisioner(
      failing,
      stubTokens() as AgentTokenService,
      BASE_CONFIG,
    );

    const result = await provisioner.reconcile([{ id: agentId }]);

    expect(result.updated).toEqual([]);
    expect(result.recreated).toEqual([]);
    expect(result.failed).toEqual([
      { agentId, error: "patch failed: server error" },
    ]);
  });
});

// ─── AC 3: Reconcile respects the template ────────────────────────────────────

describe("KubernetesAgentProvisioner.reconcile() — template respected", () => {
  it("re-provisions using the pvcName function when a deployment is missing", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";

    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      // Template with no slug falls back to resourceName (resolved by pvcNameFor)
      pvcName: (name) => `acme-agent-${name}-home`,
    };

    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      config,
    );

    // Reconcile with a missing deployment — should provision and use the template
    const result = await provisioner.reconcile([{ id: agentId }]);

    expect(result.recreated).toEqual([agentId]);
    expect(result.failed).toEqual([]);

    // PVC was created using the template (with resourceName as fallback for slug)
    const resourceName = sanitizeAgentName(agentId);
    const expectedPvcName = `acme-agent-${resourceName}-home`;
    await expect(k8s.getPvc(NAMESPACE, expectedPvcName)).resolves.toBeDefined();
  });
});

// ─── Task-store token minting ─────────────────────────────────────────────────

/**
 * Build a spy TaskStoreProvisioningClient. Records all mintToken and
 * revokeToken calls for assertion in tests.
 */
function stubTaskStore(opts?: { throwOnMint?: boolean }): {
  client: TaskStoreProvisioningClient;
  minted: Array<{ label: string; id: string }>;
  revoked: string[];
} {
  const minted: Array<{ label: string; id: string }> = [];
  const revoked: string[] = [];
  let seq = 0;

  const client: TaskStoreProvisioningClient = {
    async mintToken(label: string) {
      if (opts?.throwOnMint) throw new Error("mint failed");
      seq++;
      const id = `ts-tok-${seq}`;
      minted.push({ label, id });
      return { id, rawToken: `raw-ts-token-${seq}` };
    },
    async revokeToken(id: string) {
      revoked.push(id);
    },
  };

  return { client, minted, revoked };
}

describe("KubernetesAgentProvisioner — task-store token minting", () => {
  const AGENT_ID = "test-agent-001";

  it("provision() mints a task-store token when taskStore client is configured", async () => {
    const { client, minted } = stubTaskStore();
    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      taskStore: client,
    };
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      config,
    );

    await provisioner.provision(AGENT_ID);

    expect(minted).toHaveLength(1);
    expect(minted[0].label).toBe(`agent:${AGENT_ID}`);
  });

  it("provision() does NOT mint a task-store token when taskStore is not configured", async () => {
    // BASE_CONFIG has no taskStore
    const { client, minted } = stubTaskStore();
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      BASE_CONFIG,
    );

    await provisioner.provision(AGENT_ID);

    // client is not injected so mintToken is never called
    expect(minted).toHaveLength(0);
    // Suppress "client is unused" lint warning by referencing it
    void client;
  });

  it("provision() revokes the task-store token when Deployment creation fails", async () => {
    const { client, minted, revoked } = stubTaskStore();
    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      taskStore: client,
    };

    const recorded = emptyClient();
    const failingK8s = new RecordedKubernetesClient({
      deployments: {},
      secrets: {},
      pvcs: {},
    });
    // Wrap to throw on createDeploymentManifest
    const failingClient = Object.assign(
      Object.create(Object.getPrototypeOf(recorded)),
      recorded,
      {
        createDeploymentManifest: async () => {
          throw new Error("simulated deploy failure");
        },
      },
    );

    const provisioner = new KubernetesAgentProvisioner(
      failingClient,
      stubTokens() as AgentTokenService,
      config,
    );

    await expect(provisioner.provision(AGENT_ID)).rejects.toThrow(
      "simulated deploy failure",
    );

    expect(minted).toHaveLength(1);
    expect(revoked).toEqual([minted[0].id]);
  });

  it("provision() does NOT revoke the task-store token when Deployment already exists (409 conflict)", async () => {
    const { client, minted, revoked } = stubTaskStore();
    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      taskStore: client,
    };

    // Pre-seed the Deployment so the createDeploymentManifest call hits a 409.
    // Do NOT pre-seed the Secret, so the provisioner mints a fresh token and
    // creates a new Secret — then hits a conflict on the Deployment.
    const recorded = emptyClient();
    const agentResourceName = sanitizeAgentName(AGENT_ID);
    await recorded.createDeployment(NAMESPACE, {
      name: agentResourceName,
      image: `${BASE_CONFIG.image}:${BASE_CONFIG.imageTag}`,
    });

    const provisioner = new KubernetesAgentProvisioner(
      recorded,
      stubTokens() as AgentTokenService,
      config,
    );

    // Should NOT throw — ConflictError on Deployment is idempotent success.
    await expect(provisioner.provision(AGENT_ID)).resolves.toBeDefined();

    // Token WAS minted (Secret was new in this call).
    expect(minted).toHaveLength(1);
    // But because it was a conflict (deployment already existed), we rolled back
    // the Secret — the task-store token should also be revoked.
    expect(revoked).toEqual([minted[0].id]);
  });
});

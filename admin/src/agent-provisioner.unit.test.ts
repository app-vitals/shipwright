/**
 * admin/src/agent-provisioner.unit.test.ts
 * Unit tests for KubernetesAgentProvisioner PVC name template feature and
 * task-store token minting/rollback.
 *
 * Uses RecordedKubernetesClient (in-memory K8s double) and a stub AgentTokenService
 * so no real DB or cluster is required.
 */

import { describe, expect, it } from "bun:test";
import {
  buildAgentDeploymentManifest,
  sanitizeAgentName,
} from "./agent-manifest.ts";
import {
  containerDrifted,
  KubernetesAgentProvisioner,
  type KubernetesAgentProvisionerConfig,
  NoopAgentProvisioner,
  policyDrifted,
} from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { ChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
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

  it("skips patch when the container already matches the manifest", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const resourceName = sanitizeAgentName(agentId);

    let patchCalled = false;
    const recorded = new RecordedKubernetesClient({
      deployments: {
        // Seed the exact desired manifest (image, env, resources) so there is
        // no drift of any kind.
        [`${NAMESPACE}/${resourceName}`]: buildAgentDeploymentManifest({
          agentId,
          namespace: NAMESPACE,
          image: BASE_CONFIG.image,
          imageTag: BASE_CONFIG.imageTag,
          apiUrl: BASE_CONFIG.apiUrl,
          pvcName: `${resourceName}-home`,
          secretName: `${resourceName}-token`,
          tokenSecretKey: "token",
        }),
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

  it("patches a Deployment whose env is missing manifest vars, preserving manual extras", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const resourceName = sanitizeAgentName(agentId);

    // Seed the desired manifest, then simulate a Deployment provisioned by an
    // older admin: strip the workspace-dir vars and add a manual kubectl var.
    const stale = buildAgentDeploymentManifest({
      agentId,
      namespace: NAMESPACE,
      image: BASE_CONFIG.image,
      imageTag: BASE_CONFIG.imageTag,
      apiUrl: BASE_CONFIG.apiUrl,
      pvcName: `${resourceName}-home`,
      secretName: `${resourceName}-token`,
      tokenSecretKey: "token",
    });
    const container = stale.spec.template.spec.containers[0];
    container.env = [
      ...(container.env ?? []).filter(
        (e) =>
          e.name !== "SHIPWRIGHT_REPO_DIR" &&
          e.name !== "SHIPWRIGHT_WORKTREE_DIR",
      ),
      { name: "STARTUP_TIMEOUT_MS", value: "300000" },
    ];

    const k8s = new RecordedKubernetesClient({
      deployments: { [`${NAMESPACE}/${resourceName}`]: stale },
      secrets: {},
      pvcs: {},
    });
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      BASE_CONFIG,
    );

    const result = await provisioner.reconcile([{ id: agentId }]);

    expect(result.updated).toEqual([agentId]);
    expect(result.failed).toEqual([]);

    const dep = await k8s.getDeployment(NAMESPACE, resourceName);
    const env = dep.spec.template.spec.containers[0].env ?? [];
    const names = env.map((e) => e.name);
    expect(names).toContain("SHIPWRIGHT_REPO_DIR");
    expect(names).toContain("SHIPWRIGHT_WORKTREE_DIR");
    // The manually-added var survives the strategic-merge patch.
    expect(names).toContain("STARTUP_TIMEOUT_MS");
  });

  it("patches a Deployment with drifted resources, preserving Autopilot-injected resource keys", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const resourceName = sanitizeAgentName(agentId);

    // Seed the desired manifest, then simulate GKE Autopilot having injected a
    // cpu key into requests and limits that the manifest doesn't specify.
    const stale = buildAgentDeploymentManifest({
      agentId,
      namespace: NAMESPACE,
      image: BASE_CONFIG.image,
      imageTag: BASE_CONFIG.imageTag,
      apiUrl: BASE_CONFIG.apiUrl,
      pvcName: `${resourceName}-home`,
      secretName: `${resourceName}-token`,
      tokenSecretKey: "token",
    });
    const container = stale.spec.template.spec.containers[0];
    // Simulate Autopilot injecting cpu — and also strip the memory limit so
    // containerDrifted() detects drift and triggers a patch.
    container.resources = {
      requests: { ...container.resources?.requests, cpu: "500m" },
      limits: { cpu: "2" }, // missing memory limit → drift
    };

    const k8s = new RecordedKubernetesClient({
      deployments: { [`${NAMESPACE}/${resourceName}`]: stale },
      secrets: {},
      pvcs: {},
    });
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      BASE_CONFIG,
    );

    const result = await provisioner.reconcile([{ id: agentId }]);

    expect(result.updated).toEqual([agentId]);
    expect(result.failed).toEqual([]);

    const dep = await k8s.getDeployment(NAMESPACE, resourceName);
    const resources = dep.spec.template.spec.containers[0].resources;
    // Desired manifest values are applied.
    expect(resources?.requests?.memory).toBe("2Gi");
    expect(resources?.limits?.memory).toBe("8Gi");
    // Autopilot-injected cpu key survives the strategic-merge patch.
    expect(resources?.requests?.cpu).toBe("500m");
    expect(resources?.limits?.cpu).toBe("2");
  });
});

// ─── containerDrifted ─────────────────────────────────────────────────────────

describe("containerDrifted", () => {
  const desired = () =>
    buildAgentDeploymentManifest({
      agentId: "agent-1",
      namespace: NAMESPACE,
      image: BASE_CONFIG.image,
      imageTag: BASE_CONFIG.imageTag,
      apiUrl: BASE_CONFIG.apiUrl,
      pvcName: "agent-1-home",
      secretName: "agent-1-token",
      tokenSecretKey: "token",
    }).spec.template.spec.containers[0];

  it("no drift when current equals desired", () => {
    expect(containerDrifted(desired(), desired())).toBe(false);
  });

  it("drifts on image change", () => {
    const current = { ...desired(), image: "other:v0" };
    expect(containerDrifted(current, desired())).toBe(true);
  });

  it("drifts when a desired env var is missing", () => {
    const current = desired();
    current.env = (current.env ?? []).filter(
      (e) => e.name !== "SHIPWRIGHT_WORKTREE_DIR",
    );
    expect(containerDrifted(current, desired())).toBe(true);
  });

  it("drifts when a desired env value differs", () => {
    const current = desired();
    current.env = (current.env ?? []).map((e) =>
      e.name === "SHIPWRIGHT_WORKTREE_DIR" ? { ...e, value: "/elsewhere" } : e,
    );
    expect(containerDrifted(current, desired())).toBe(true);
  });

  it("extra live env vars are not drift", () => {
    const current = desired();
    current.env = [
      ...(current.env ?? []),
      { name: "STARTUP_TIMEOUT_MS", value: "300000" },
    ];
    expect(containerDrifted(current, desired())).toBe(false);
  });

  it("extra live resource keys (e.g. Autopilot-injected) are not drift", () => {
    const current = desired();
    current.resources = {
      requests: { ...current.resources?.requests, cpu: "500m" },
      limits: { ...current.resources?.limits, cpu: "2" },
    };
    expect(containerDrifted(current, desired())).toBe(false);
  });

  it("drifts when a desired resource value is missing or different", () => {
    const current = desired();
    current.resources = { requests: current.resources?.requests }; // no limits
    expect(containerDrifted(current, desired())).toBe(true);
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
  minted: Array<{ label: string; agentId: string | undefined; id: string }>;
  revoked: string[];
} {
  const minted: Array<{
    label: string;
    agentId: string | undefined;
    id: string;
  }> = [];
  const revoked: string[] = [];
  let seq = 0;

  const client: TaskStoreProvisioningClient = {
    async mintToken(label: string, agentId?: string) {
      if (opts?.throwOnMint) throw new Error("mint failed");
      seq++;
      const id = `ts-tok-${seq}`;
      minted.push({ label, agentId, id });
      return { id, rawToken: `raw-ts-token-${seq}` };
    },
    async revokeToken(id: string) {
      revoked.push(id);
    },
    async listTokensForAgent(_agentId: string) {
      return [];
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
    expect(minted[0].agentId).toBe(AGENT_ID);
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
    const _failingK8s = new RecordedKubernetesClient({
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

// ─── deprovision() deletes the PVC ────────────────────────────────────────────

/**
 * Wraps a RecordedKubernetesClient, delegating every call through to it while
 * recording each deletePvc invocation for assertion.
 */
function spyOnDeletePvc(recorded: RecordedKubernetesClient): {
  client: KubernetesClient;
  deletedPvcs: Array<{ namespace: string; name: string }>;
} {
  const deletedPvcs: Array<{ namespace: string; name: string }> = [];
  const client: KubernetesClient = {
    createDeployment: (ns, spec) => recorded.createDeployment(ns, spec),
    createDeploymentManifest: (ns, manifest) =>
      recorded.createDeploymentManifest(ns, manifest),
    getDeployment: (ns, name) => recorded.getDeployment(ns, name),
    deploymentExists: (ns, name) => recorded.deploymentExists(ns, name),
    listDeployments: (ns, sel) => recorded.listDeployments(ns, sel),
    deleteDeployment: (ns, name) => recorded.deleteDeployment(ns, name),
    patchDeployment: (ns, name, patch) =>
      recorded.patchDeployment(ns, name, patch),
    createSecret: (ns, spec) => recorded.createSecret(ns, spec),
    getSecret: (ns, name) => recorded.getSecret(ns, name),
    deleteSecret: (ns, name) => recorded.deleteSecret(ns, name),
    createPvc: (ns, spec) => recorded.createPvc(ns, spec),
    getPvc: (ns, name) => recorded.getPvc(ns, name),
    deletePvc: (ns, name) => {
      deletedPvcs.push({ namespace: ns, name });
      return recorded.deletePvc(ns, name);
    },
  };
  return { client, deletedPvcs };
}

describe("KubernetesAgentProvisioner.deprovision() — PVC deletion", () => {
  it("calls deletePvc with the default {resourceName}-home name", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const resourceName = sanitizeAgentName(agentId);
    const expectedPvcName = `${resourceName}-home`;

    const { client, deletedPvcs } = spyOnDeletePvc(emptyClient());
    const provisioner = new KubernetesAgentProvisioner(
      client,
      stubTokens() as AgentTokenService,
      BASE_CONFIG,
    );

    await provisioner.provision(agentId);
    await provisioner.deprovision(agentId);

    expect(deletedPvcs).toEqual([
      { namespace: NAMESPACE, name: expectedPvcName },
    ]);
  });

  it("calls deletePvc with the templated name derived from slug", async () => {
    const agentId = "cmqalfjcm000m4101iharq28k";
    const slug = "okwow";
    const expectedPvcName = "acme-agent-okwow-home";

    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      pvcName: (name) => `acme-agent-${name}-home`,
    };
    const { client, deletedPvcs } = spyOnDeletePvc(emptyClient());
    const provisioner = new KubernetesAgentProvisioner(
      client,
      stubTokens() as AgentTokenService,
      config,
    );

    await provisioner.provision(agentId, { slug });
    await provisioner.deprovision(agentId, { slug });

    expect(deletedPvcs).toEqual([
      { namespace: NAMESPACE, name: expectedPvcName },
    ]);
  });
});

// ─── Chat-service token minting ───────────────────────────────────────────────

/**
 * Build a spy ChatServiceProvisioningClient. Records all mintToken and
 * revokeToken calls for assertion in tests.
 */
function stubChatService(opts?: { throwOnMint?: boolean }): {
  client: ChatServiceProvisioningClient;
  minted: Array<{ label: string; agentId: string | undefined; id: string }>;
  revoked: string[];
} {
  const minted: Array<{
    label: string;
    agentId: string | undefined;
    id: string;
  }> = [];
  const revoked: string[] = [];
  let seq = 0;

  const client: ChatServiceProvisioningClient = {
    async mintToken(label: string, agentId?: string) {
      if (opts?.throwOnMint) throw new Error("mint failed");
      seq++;
      const id = `cs-tok-${seq}`;
      minted.push({ label, agentId, id });
      return { id, rawToken: `raw-cs-token-${seq}` };
    },
    async revokeToken(id: string) {
      revoked.push(id);
    },
    async listTokensForAgent(_agentId: string) {
      return [];
    },
    async deleteThreadsForAgent(_agentId: string) {
      return { deleted: 0 };
    },
  };

  return { client, minted, revoked };
}

describe("KubernetesAgentProvisioner — chat-service token minting", () => {
  const AGENT_ID = "test-agent-001";

  it("provision() mints a chat-service token when chatService client is configured", async () => {
    const { client, minted } = stubChatService();
    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      chatService: client,
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
    expect(minted[0].agentId).toBe(AGENT_ID);

    // Verify the Secret contains the chat-service-token key (stored as base64 data).
    const resourceName = sanitizeAgentName(AGENT_ID);
    const secretName = `${resourceName}-token`;
    const secret = await k8s.getSecret(NAMESPACE, secretName);
    expect(secret.data["chat-service-token"]).toBeDefined();
  });

  it("provision() does NOT mint a chat-service token when chatService is not configured", async () => {
    // BASE_CONFIG has no chatService
    const { client, minted } = stubChatService();
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

  it("provision() revokes the chat-service token when Deployment creation fails", async () => {
    const { client, minted, revoked } = stubChatService();
    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      chatService: client,
    };

    const recorded = emptyClient();
    const _failingK8s = new RecordedKubernetesClient({
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

  it("provision() revokes the chat-service token when Deployment already exists (409 conflict)", async () => {
    const { client, minted, revoked } = stubChatService();
    const config: KubernetesAgentProvisionerConfig = {
      ...BASE_CONFIG,
      chatService: client,
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
    // Deployment conflict rolled back the Secret — chat-service token must also be revoked.
    expect(revoked).toEqual([minted[0].id]);
  });
});

// ─── canProvision ─────────────────────────────────────────────────────────────

describe("canProvision", () => {
  it("is false on the no-op provisioner — it creates no cluster resources", () => {
    expect(new NoopAgentProvisioner().canProvision).toBe(false);
  });

  it("is true on the Kubernetes provisioner", () => {
    const provisioner = new KubernetesAgentProvisioner(
      emptyClient(),
      stubTokens() as AgentTokenService,
      BASE_CONFIG,
    );
    expect(provisioner.canProvision).toBe(true);
  });
});

describe("KubernetesAgentProvisioner.reconcile() — tenant drift (SSP-7.1)", () => {
  const agentId = "cmqalfjcm000m4101iharq28k";
  const resourceName = sanitizeAgentName(agentId);

  async function seededWithPlatformManifest() {
    const k8s = new RecordedKubernetesClient({
      deployments: {},
      secrets: {},
      pvcs: {},
    });
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens() as AgentTokenService,
      BASE_CONFIG,
    );
    await provisioner.provision(agentId); // created as a platform agent
    return { k8s, provisioner };
  }

  it("detects a missing tenant label + CPU limit as drift and patches", async () => {
    const { k8s, provisioner } = await seededWithPlatformManifest();

    const result = await provisioner.reconcile([
      { id: agentId, accountId: "acct_1" },
    ]);

    expect(result.updated).toEqual([agentId]);
    const dep = await k8s.getDeployment(NAMESPACE, resourceName);
    expect(dep.spec.template.metadata.labels["shipwright.dev/tenant"]).toBe(
      "true",
    );
    expect(dep.spec.template.spec.containers[0]?.resources?.limits?.cpu).toBe(
      "2",
    );
  });

  it("is a no-op once the tenant Deployment matches", async () => {
    const { provisioner } = await seededWithPlatformManifest();
    await provisioner.reconcile([{ id: agentId, accountId: "acct_1" }]);
    const second = await provisioner.reconcile([
      { id: agentId, accountId: "acct_1" },
    ]);
    expect(second.updated).toEqual([]);
  });

  it("does not touch platform agents (no accountId)", async () => {
    const { provisioner } = await seededWithPlatformManifest();
    const result = await provisioner.reconcile([{ id: agentId }]);
    expect(result.updated).toEqual([]);
  });
});

// ─── Claude policy drift + reconcile patch ──────────────────────────────────

const POLICY_AGENT_ID = "cmqalfjcm000m4101iharq28k";
const POLICY_RESOURCE = sanitizeAgentName(POLICY_AGENT_ID);
const POLICY_VOLUME_PATH = "claude-policy";

function manifestWith(
  claudePolicy?: { configMapName: string; hash?: string },
  overrides: { imageTag?: string } = {},
) {
  return buildAgentDeploymentManifest({
    agentId: POLICY_AGENT_ID,
    namespace: NAMESPACE,
    image: BASE_CONFIG.image,
    imageTag: overrides.imageTag ?? BASE_CONFIG.imageTag,
    apiUrl: BASE_CONFIG.apiUrl,
    pvcName: `${POLICY_RESOURCE}-home`,
    secretName: `${POLICY_RESOURCE}-token`,
    tokenSecretKey: "token",
    claudePolicy,
  });
}

/** Records every patch body sent through the client. */
function patchSpy(rec: RecordedKubernetesClient): {
  client: KubernetesClient;
  patches: object[];
} {
  const patches: object[] = [];
  const client: KubernetesClient = {
    createDeployment: (ns, spec) => rec.createDeployment(ns, spec),
    createDeploymentManifest: (ns, m) => rec.createDeploymentManifest(ns, m),
    getDeployment: (ns, n) => rec.getDeployment(ns, n),
    deploymentExists: (ns, n) => rec.deploymentExists(ns, n),
    listDeployments: (ns, s) => rec.listDeployments(ns, s),
    deleteDeployment: (ns, n) => rec.deleteDeployment(ns, n),
    patchDeployment: async (ns, n, patch) => {
      patches.push(patch);
      return rec.patchDeployment(ns, n, patch);
    },
    createSecret: (ns, s) => rec.createSecret(ns, s),
    getSecret: (ns, n) => rec.getSecret(ns, n),
    deleteSecret: (ns, n) => rec.deleteSecret(ns, n),
    createPvc: (ns, s) => rec.createPvc(ns, s),
    getPvc: (ns, n) => rec.getPvc(ns, n),
    deletePvc: (ns, n) => rec.deletePvc(ns, n),
  };
  return { client, patches };
}

function seeded(live: ReturnType<typeof manifestWith>) {
  return new RecordedKubernetesClient({
    deployments: { [`${NAMESPACE}/${POLICY_RESOURCE}`]: live },
    secrets: {},
    pvcs: {},
  });
}

const POLICY_A = { configMapName: "claude-policy-cm", hash: "hash-a" };

describe("policyDrifted()", () => {
  it("is drifted when the policy is desired but the live Deployment lacks it", () => {
    expect(policyDrifted(manifestWith(), manifestWith(POLICY_A))).toBe(true);
  });

  it("is drifted when the hash annotation differs", () => {
    expect(
      policyDrifted(
        manifestWith({ ...POLICY_A, hash: "old" }),
        manifestWith(POLICY_A),
      ),
    ).toBe(true);
  });

  it("is not drifted when the hash matches", () => {
    expect(policyDrifted(manifestWith(POLICY_A), manifestWith(POLICY_A))).toBe(
      false,
    );
  });

  it("is drifted when the volume points at a different ConfigMap", () => {
    expect(
      policyDrifted(
        manifestWith({ ...POLICY_A, configMapName: "other" }),
        manifestWith(POLICY_A),
      ),
    ).toBe(true);
  });

  it("is drifted when only the mount is missing", () => {
    const live = manifestWith(POLICY_A);
    const c = live.spec.template.spec.containers[0];
    if (c) {
      c.volumeMounts = c.volumeMounts?.filter(
        (m) => m.mountPath !== "/etc/claude-code",
      );
    }
    expect(policyDrifted(live, manifestWith(POLICY_A))).toBe(true);
  });

  it("is drifted when the policy mount is not read-only", () => {
    const live = manifestWith(POLICY_A);
    const mount = live.spec.template.spec.containers[0]?.volumeMounts?.find(
      (m) => m.mountPath === "/etc/claude-code",
    );
    if (mount) mount.readOnly = false;
    expect(policyDrifted(live, manifestWith(POLICY_A))).toBe(true);
  });

  it("ignores a same-named mount at another path once the policy mount is in sync", () => {
    const live = manifestWith(POLICY_A);
    live.spec.template.spec.containers[0]?.volumeMounts?.unshift({
      name: "claude-policy",
      mountPath: "/etc/other",
    });
    expect(policyDrifted(live, manifestWith(POLICY_A))).toBe(false);
  });

  it("is drifted when a live hash annotation is extra (desired hash absent)", () => {
    expect(
      policyDrifted(
        manifestWith(POLICY_A),
        manifestWith({ configMapName: POLICY_A.configMapName }),
      ),
    ).toBe(true);
  });

  it("is drifted when the policy is disabled but the live Deployment still has it", () => {
    expect(policyDrifted(manifestWith(POLICY_A), manifestWith())).toBe(true);
  });

  it("is not drifted when the policy is disabled and absent", () => {
    expect(policyDrifted(manifestWith(), manifestWith())).toBe(false);
  });
});

describe("KubernetesAgentProvisioner.reconcile() — claude policy", () => {
  function provisionerFor(
    client: KubernetesClient,
    claudePolicy?: { configMapName: string; hash?: string },
  ) {
    return new KubernetesAgentProvisioner(
      client,
      stubTokens() as AgentTokenService,
      { ...BASE_CONFIG, claudePolicy },
    );
  }

  it("adds the volume, mount and annotation when the policy is configured", async () => {
    const rec = seeded(manifestWith());
    const { client, patches } = patchSpy(rec);
    const result = await provisionerFor(client, POLICY_A).reconcile([
      { id: POLICY_AGENT_ID },
    ]);

    expect(result.updated).toEqual([POLICY_AGENT_ID]);
    const desired = manifestWith(POLICY_A);
    const volume = desired.spec.template.spec.volumes?.find(
      (v) => v.name === POLICY_VOLUME_PATH,
    );
    const mount = desired.spec.template.spec.containers[0]?.volumeMounts?.find(
      (m) => m.name === POLICY_VOLUME_PATH,
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      spec: {
        template: {
          metadata: {
            annotations: { "shipwright.dev/claude-policy-hash": "hash-a" },
          },
          spec: {
            volumes: [volume],
            containers: [{ volumeMounts: [mount] }],
          },
        },
      },
    });

    // Converged: a second pass is a no-op.
    const again = await provisionerFor(client, POLICY_A).reconcile([
      { id: POLICY_AGENT_ID },
    ]);
    expect(again.updated).toEqual([]);
    expect(patches).toHaveLength(1);
  });

  it("updates the hash annotation without touching the volume or mount", async () => {
    const rec = seeded(manifestWith({ ...POLICY_A, hash: "old" }));
    const { client, patches } = patchSpy(rec);
    await provisionerFor(client, POLICY_A).reconcile([{ id: POLICY_AGENT_ID }]);

    expect(patches).toHaveLength(1);
    const tpl = (
      patches[0] as {
        spec: { template: { spec: Record<string, unknown> } };
      }
    ).spec.template;
    expect(tpl).toMatchObject({
      metadata: {
        annotations: { "shipwright.dev/claude-policy-hash": "hash-a" },
      },
    });
    expect(tpl.spec.volumes).toBeUndefined();
    const live = await rec.getDeployment(NAMESPACE, POLICY_RESOURCE);
    expect(
      live.spec.template.metadata.annotations?.[
        "shipwright.dev/claude-policy-hash"
      ],
    ).toBe("hash-a");
  });

  it("removes the volume, mount and annotation when the policy is disabled", async () => {
    const rec = seeded(manifestWith(POLICY_A));
    const { client, patches } = patchSpy(rec);
    const result = await provisionerFor(client, undefined).reconcile([
      { id: POLICY_AGENT_ID },
    ]);

    expect(result.updated).toEqual([POLICY_AGENT_ID]);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      spec: {
        template: {
          metadata: {
            annotations: { "shipwright.dev/claude-policy-hash": null },
          },
          spec: {
            volumes: [{ name: "claude-policy", $patch: "delete" }],
            containers: [
              {
                volumeMounts: [
                  { mountPath: "/etc/claude-code", $patch: "delete" },
                ],
              },
            ],
          },
        },
      },
    });

    // The delete directives actually remove the entries.
    const live = await rec.getDeployment(NAMESPACE, POLICY_RESOURCE);
    expect(
      live.spec.template.spec.volumes?.some((v) => v.name === "claude-policy"),
    ).toBe(false);
    expect(
      live.spec.template.spec.containers[0]?.volumeMounts?.some(
        (m) => m.mountPath === "/etc/claude-code",
      ),
    ).toBe(false);
    expect(
      live.spec.template.metadata.annotations?.[
        "shipwright.dev/claude-policy-hash"
      ],
    ).toBeUndefined();
    // The PVC volume and home mount survive.
    expect(live.spec.template.spec.volumes?.length).toBe(1);
    expect(live.spec.template.spec.containers[0]?.volumeMounts?.length).toBe(1);
  });

  it("does not patch when nothing drifted", async () => {
    const rec = seeded(manifestWith(POLICY_A));
    const { client, patches } = patchSpy(rec);
    await provisionerFor(client, POLICY_A).reconcile([{ id: POLICY_AGENT_ID }]);
    expect(patches).toEqual([]);
  });

  it("policyOnly leaves image drift alone", async () => {
    const rec = seeded(manifestWith(POLICY_A, { imageTag: "v0.0.1" }));
    const { client, patches } = patchSpy(rec);
    const result = await provisionerFor(client, POLICY_A).reconcile(
      [{ id: POLICY_AGENT_ID }],
      { policyOnly: true },
    );
    expect(result.updated).toEqual([]);
    expect(patches).toEqual([]);
  });

  it("policyOnly patches only policy fields when both kinds drifted", async () => {
    const rec = seeded(manifestWith(undefined, { imageTag: "v0.0.1" }));
    const { client, patches } = patchSpy(rec);
    const result = await provisionerFor(client, POLICY_A).reconcile(
      [{ id: POLICY_AGENT_ID }],
      { policyOnly: true },
    );
    expect(result.updated).toEqual([POLICY_AGENT_ID]);
    expect(patches).toHaveLength(1);
    const container = (
      patches[0] as {
        spec: { template: { spec: { containers: Array<object> } } };
      }
    ).spec.template.spec.containers[0];
    expect(Object.keys(container ?? {}).sort()).toEqual([
      "name",
      "volumeMounts",
    ]);
    const live = await rec.getDeployment(NAMESPACE, POLICY_RESOURCE);
    expect(live.spec.template.spec.containers[0]?.image).toBe(
      `${BASE_CONFIG.image}:v0.0.1`,
    );
  });

  it("without policyOnly, image and policy drift go in one patch", async () => {
    const rec = seeded(manifestWith(undefined, { imageTag: "v0.0.1" }));
    const { client, patches } = patchSpy(rec);
    await provisionerFor(client, POLICY_A).reconcile([{ id: POLICY_AGENT_ID }]);
    expect(patches).toHaveLength(1);
    const live = await rec.getDeployment(NAMESPACE, POLICY_RESOURCE);
    expect(live.spec.template.spec.containers[0]?.image).toBe(
      `${BASE_CONFIG.image}:${BASE_CONFIG.imageTag}`,
    );
    expect(
      live.spec.template.spec.volumes?.some((v) => v.name === "claude-policy"),
    ).toBe(true);
  });
});

describe("NoopAgentProvisioner.reconcile()", () => {
  it("accepts the policyOnly option", async () => {
    const result = await new NoopAgentProvisioner().reconcile([{ id: "a" }], {
      policyOnly: true,
    });
    expect(result).toEqual({
      recreated: [],
      updated: [],
      orphans: [],
      failed: [],
    });
  });
});

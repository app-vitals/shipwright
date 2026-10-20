/**
 * admin/src/agent-provisioner-per-agent.integration.test.ts
 * Integration tests for KubernetesAgentProvisioner in perAgent identity mode:
 * PVC → Kubernetes ServiceAccount → Anthropic service account (+ workspace) →
 * federation rule → Secret → Deployment, with each ID saved as soon as it
 * exists, idempotent retries and best-effort rollback.
 *
 * Doubles are injected via the constructor — RecordedKubernetesClient (wrapped
 * to fail on demand), FakeAnthropicIdentityClient and an in-memory identity
 * store — so no DB, cluster or network is needed and no globals are touched.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentAnthropicIdentity } from "./agent-anthropic-identity.ts";
import {
  buildAgentDeploymentManifest,
  sanitizeAgentName,
} from "./agent-manifest.ts";
import {
  KubernetesAgentProvisioner,
  type KubernetesAgentProvisionerConfig,
} from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { KubernetesClient } from "./kubernetes-client.ts";
import {
  type KubernetesDeployment,
  RecordedKubernetesClient,
} from "./kubernetes-client.ts";
import {
  FakeAnthropicIdentityClient,
  faultyKubernetesClient,
  InMemoryAgentIdentityStore,
} from "./per-agent-identity.fixtures.ts";

const NAMESPACE = "agents";
const AGENT_ID = "cmqalfjcm000m4101iharq28k";
const RESOURCE = sanitizeAgentName(AGENT_ID);
const OWNER = "jane.doe@example.com";
const IDENTITY_NAME = "jane-doe-a1";
const SUBJECT = `system:serviceaccount:${NAMESPACE}:${RESOURCE}`;

const BASE_CONFIG: KubernetesAgentProvisionerConfig = {
  namespace: NAMESPACE,
  image: "ghcr.io/example/shipwright-agent",
  imageTag: "v1.0.0",
  apiUrl: "http://shipwright-admin.shipwright.svc:3001",
};

function stubTokens(): AgentTokenService {
  return {
    create: async (agentId: string) => ({
      id: `tok-${agentId}`,
      rawToken: `raw-${agentId}`,
    }),
  } as unknown as AgentTokenService;
}

interface Harness {
  events: string[];
  recorded: RecordedKubernetesClient;
  k8s: ReturnType<typeof faultyKubernetesClient>;
  anthropic: FakeAnthropicIdentityClient;
  store: InMemoryAgentIdentityStore;
  provisioner: KubernetesAgentProvisioner;
}

function harness(opts: { workspaceId?: string | null } = {}): Harness {
  const events: string[] = [];
  const recorded = new RecordedKubernetesClient({
    deployments: {},
    secrets: {},
    pvcs: {},
    serviceAccounts: {},
  });
  const k8s = faultyKubernetesClient(recorded, events);
  const anthropic = new FakeAnthropicIdentityClient(events);
  const store = new InMemoryAgentIdentityStore(events);
  const workspaceId =
    opts.workspaceId === undefined ? "wrkspc_1" : opts.workspaceId;
  const provisioner = new KubernetesAgentProvisioner(k8s, stubTokens(), {
    ...BASE_CONFIG,
    perAgentIdentity: {
      client: anthropic,
      identities: store,
      names: store,
      organizationId: "org-1",
      ...(workspaceId ? { workspaceId } : {}),
      issuerId: "fdis_cluster",
      audience: "https://api.anthropic.com",
      expirationSeconds: 600,
    },
  });
  return { events, recorded, k8s, anthropic, store, provisioner };
}

function envOf(dep: KubernetesDeployment): Record<string, string | undefined> {
  return Object.fromEntries(
    (dep.spec.template.spec.containers[0]?.env ?? []).map((e) => [
      e.name,
      e.value,
    ]),
  );
}

async function exists(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch {
    return false;
  }
}

/** The full set of side effects a completed provision leaves behind. */
async function expectFullyProvisioned(h: Harness): Promise<void> {
  const [sa] = h.anthropic.liveServiceAccounts();
  const [rule] = h.anthropic.liveRules();
  expect(h.anthropic.liveServiceAccounts()).toHaveLength(1);
  expect(h.anthropic.liveRules()).toHaveLength(1);
  expect(sa?.name).toBe(IDENTITY_NAME);
  expect(rule?.name).toBe(IDENTITY_NAME);
  expect(await h.store.get(AGENT_ID)).toEqual({
    ownerEmail: OWNER,
    anthropicIdentityName: IDENTITY_NAME,
    anthropicServiceAccountId: sa?.id ?? "missing",
    anthropicFederationRuleId: rule?.id ?? "missing",
    k8sServiceAccountName: RESOURCE,
  });
  expect(await exists(h.recorded.getServiceAccount(NAMESPACE, RESOURCE))).toBe(
    true,
  );
  const dep = await h.recorded.getDeployment(NAMESPACE, RESOURCE);
  expect(dep.spec.template.spec.serviceAccountName).toBe(RESOURCE);
  const env = envOf(dep);
  expect(env.ANTHROPIC_FEDERATION_RULE_ID).toBe(rule?.id);
  expect(env.ANTHROPIC_SERVICE_ACCOUNT_ID).toBe(sa?.id);
}

/** Nothing but the PVC (and the reserved identity name) survives a rollback. */
async function expectRolledBack(h: Harness): Promise<void> {
  expect(h.anthropic.liveServiceAccounts()).toHaveLength(0);
  expect(h.anthropic.liveRules()).toHaveLength(0);
  const identity = (await h.store.get(AGENT_ID)) as AgentAnthropicIdentity;
  expect(identity.anthropicServiceAccountId).toBeNull();
  expect(identity.anthropicFederationRuleId).toBeNull();
  expect(identity.k8sServiceAccountName).toBeNull();
  expect(await exists(h.recorded.getServiceAccount(NAMESPACE, RESOURCE))).toBe(
    false,
  );
  expect(
    await exists(h.recorded.getSecret(NAMESPACE, `${RESOURCE}-token`)),
  ).toBe(false);
  expect(await exists(h.recorded.getDeployment(NAMESPACE, RESOURCE))).toBe(
    false,
  );
  // Data safety: the PVC is never rolled back.
  expect(await exists(h.recorded.getPvc(NAMESPACE, `${RESOURCE}-home`))).toBe(
    true,
  );
}

describe("KubernetesAgentProvisioner.provision() — perAgent identity", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
    h.store.addAgent(AGENT_ID, { ownerEmail: OWNER });
  });

  it("runs PVC → K8s SA → Anthropic SA → workspace → rule → Secret → Deployment, saving each ID right after its create", async () => {
    await h.provisioner.provision(AGENT_ID);

    expect(h.events).toEqual([
      "k8s.createPvc",
      "k8s.createServiceAccount",
      "store.set(k8sServiceAccountName)",
      "store.allocate",
      "anthropic.createServiceAccount",
      "store.set(anthropicServiceAccountId)",
      "anthropic.addServiceAccountToWorkspace",
      "anthropic.createFederationRule",
      "store.set(anthropicFederationRuleId)",
      "k8s.getSecret",
      "k8s.createSecret",
      "k8s.createDeploymentManifest",
    ]);
    await expectFullyProvisioned(h);
  });

  it("creates the K8s ServiceAccount with the Deployment's name", async () => {
    await h.provisioner.provision(AGENT_ID);
    const sa = await h.recorded.getServiceAccount(NAMESPACE, RESOURCE);
    expect(sa.metadata.name).toBe(RESOURCE);
  });

  it("adds the Anthropic service account to the configured workspace", async () => {
    await h.provisioner.provision(AGENT_ID);
    const [sa] = h.anthropic.liveServiceAccounts();
    expect(h.anthropic.callsTo("addServiceAccountToWorkspace")).toEqual([
      { serviceAccountId: sa?.id, workspaceId: "wrkspc_1" },
    ]);
    expect(sa?.workspaces).toEqual(["wrkspc_1"]);
  });

  it("creates the rule for the exact pod subject, workspace:inference, 600s, on this cluster's issuer", async () => {
    await h.provisioner.provision(AGENT_ID);
    const [sa] = h.anthropic.liveServiceAccounts();
    const [rule] = h.anthropic.liveRules();
    expect(rule?.input).toMatchObject({
      name: IDENTITY_NAME,
      issuerId: "fdis_cluster",
      serviceAccountId: sa?.id,
      workspaceId: "wrkspc_1",
      oauthScope: "workspace:inference",
      match: { subjectPrefix: SUBJECT, audience: "https://api.anthropic.com" },
      tokenLifetimeSeconds: 600,
    });
    // No trailing `*`: the API treats subject_prefix as an exact match then.
    expect(rule?.input.match.subjectPrefix?.endsWith("*")).toBe(false);
  });

  it("builds the Deployment from this agent's own identity", async () => {
    await h.provisioner.provision(AGENT_ID);
    const [sa] = h.anthropic.liveServiceAccounts();
    const [rule] = h.anthropic.liveRules();
    const dep = await h.recorded.getDeployment(NAMESPACE, RESOURCE);
    expect(dep.spec.template.spec.serviceAccountName).toBe(RESOURCE);
    expect(envOf(dep)).toMatchObject({
      ANTHROPIC_IDENTITY_TOKEN_FILE: "/var/run/secrets/anthropic.com/token",
      ANTHROPIC_FEDERATION_RULE_ID: rule?.id,
      ANTHROPIC_ORGANIZATION_ID: "org-1",
      ANTHROPIC_SERVICE_ACCOUNT_ID: sa?.id,
      ANTHROPIC_WORKSPACE_ID: "wrkspc_1",
    });
  });

  it("never uses find-by-name on the happy path", async () => {
    await h.provisioner.provision(AGENT_ID);
    expect(h.anthropic.callsTo("findServiceAccountByName")).toHaveLength(0);
    expect(h.anthropic.callsTo("findFederationRuleByName")).toHaveLength(0);
  });

  it("is a no-op for the identity on a second provision (stored IDs are reused)", async () => {
    await h.provisioner.provision(AGENT_ID);
    await h.provisioner.provision(AGENT_ID);
    expect(h.anthropic.callsTo("createServiceAccount")).toHaveLength(1);
    expect(h.anthropic.callsTo("createFederationRule")).toHaveLength(1);
    await expectFullyProvisioned(h);
  });

  it("fails with a clear error before creating anything when the agent has no owner", async () => {
    const noOwner = harness();
    noOwner.store.addAgent(AGENT_ID);
    await expect(noOwner.provisioner.provision(AGENT_ID)).rejects.toThrow(
      /no owner/i,
    );
    expect(noOwner.events).toEqual([]);
  });

  it("fails with NotFound before creating anything when the agent row is missing", async () => {
    const missing = harness();
    await expect(missing.provisioner.provision(AGENT_ID)).rejects.toThrow(
      /not found/i,
    );
    expect(missing.events).toEqual([]);
  });

  it("skips the workspace step and omits the workspace when none is configured", async () => {
    const noWs = harness({ workspaceId: null });
    noWs.store.addAgent(AGENT_ID, { ownerEmail: OWNER });
    await noWs.provisioner.provision(AGENT_ID);
    expect(noWs.anthropic.callsTo("addServiceAccountToWorkspace")).toEqual([]);
    const [rule] = noWs.anthropic.liveRules();
    expect(rule?.input.workspaceId).toBeUndefined();
    const dep = await noWs.recorded.getDeployment(NAMESPACE, RESOURCE);
    expect(envOf(dep).ANTHROPIC_WORKSPACE_ID).toBeUndefined();
  });

  it("treats an existing K8s ServiceAccount (409) as already created and keeps it on rollback", async () => {
    await h.recorded.createServiceAccount(NAMESPACE, { name: RESOURCE });
    h.anthropic.failNext("createFederationRule");
    await expect(h.provisioner.provision(AGENT_ID)).rejects.toThrow();
    // Not created by this call, so not deleted by its rollback.
    expect(
      await exists(h.recorded.getServiceAccount(NAMESPACE, RESOURCE)),
    ).toBe(true);
    await h.provisioner.provision(AGENT_ID);
    await expectFullyProvisioned(h);
  });

  it("treats an existing workspace membership (409) as done", async () => {
    await h.provisioner.provision(AGENT_ID);
    // Simulate a retry that lost the rule ID but kept the SA ID.
    const [rule] = h.anthropic.liveRules();
    await h.anthropic.archiveFederationRule(rule?.id ?? "");
    await h.store.set(AGENT_ID, { anthropicFederationRuleId: null });
    await h.recorded.deleteDeployment(NAMESPACE, RESOURCE);
    await h.provisioner.provision(AGENT_ID);
    expect(h.anthropic.liveServiceAccounts()).toHaveLength(1);
    expect(h.anthropic.liveRules()).toHaveLength(1);
  });

  it("keeps the identity when the Deployment already exists (409)", async () => {
    await h.recorded.createDeploymentManifest(
      NAMESPACE,
      buildAgentDeploymentManifest({
        agentId: AGENT_ID,
        namespace: NAMESPACE,
        image: BASE_CONFIG.image,
        imageTag: BASE_CONFIG.imageTag,
        apiUrl: BASE_CONFIG.apiUrl,
        pvcName: `${RESOURCE}-home`,
        secretName: `${RESOURCE}-token`,
        tokenSecretKey: "token",
      }),
    );
    await h.provisioner.provision(AGENT_ID);
    expect(h.anthropic.liveServiceAccounts()).toHaveLength(1);
    expect(h.anthropic.liveRules()).toHaveLength(1);
    expect((await h.store.get(AGENT_ID))?.anthropicFederationRuleId).not.toBe(
      null,
    );
  });
});

// ─── Failure at each step, then retry ─────────────────────────────────────────

type Step = {
  name: string;
  inject: (h: Harness) => void;
};

const STEPS: Step[] = [
  {
    name: "K8s ServiceAccount create",
    inject: (h) => h.k8s.failNext("createServiceAccount"),
  },
  {
    name: "k8sServiceAccountName save",
    inject: (h) => h.store.failNextSetOf("k8sServiceAccountName"),
  },
  {
    name: "Anthropic service account create",
    inject: (h) => h.anthropic.failNext("createServiceAccount"),
  },
  {
    name: "anthropicServiceAccountId save",
    inject: (h) => h.store.failNextSetOf("anthropicServiceAccountId"),
  },
  {
    name: "add to workspace",
    inject: (h) => h.anthropic.failNext("addServiceAccountToWorkspace"),
  },
  {
    name: "federation rule create",
    inject: (h) => h.anthropic.failNext("createFederationRule"),
  },
  {
    name: "anthropicFederationRuleId save",
    inject: (h) => h.store.failNextSetOf("anthropicFederationRuleId"),
  },
  {
    name: "Secret create",
    inject: (h) => h.k8s.failNext("createSecret"),
  },
  {
    name: "Deployment create",
    inject: (h) => h.k8s.failNext("createDeploymentManifest"),
  },
];

describe("KubernetesAgentProvisioner.provision() — perAgent failure, rollback and retry", () => {
  for (const step of STEPS) {
    it(`rolls back after a ${step.name} failure, and a retry creates no duplicates`, async () => {
      const h = harness();
      h.store.addAgent(AGENT_ID, { ownerEmail: OWNER });
      step.inject(h);

      await expect(h.provisioner.provision(AGENT_ID)).rejects.toThrow();
      await expectRolledBack(h);

      await h.provisioner.provision(AGENT_ID);
      await expectFullyProvisioned(h);
    });
  }

  it("rolls back in reverse order: rule, Anthropic SA, K8s SA", async () => {
    const h = harness();
    h.store.addAgent(AGENT_ID, { ownerEmail: OWNER });
    h.k8s.failNext("createDeploymentManifest");
    await expect(h.provisioner.provision(AGENT_ID)).rejects.toThrow();
    const after = h.events.slice(
      h.events.indexOf("k8s.createDeploymentManifest") + 1,
    );
    const order = after.filter((e) =>
      [
        "k8s.deleteSecret",
        "anthropic.archiveFederationRule",
        "anthropic.archiveServiceAccount",
        "k8s.deleteServiceAccount",
      ].includes(e),
    );
    expect(order).toEqual([
      "k8s.deleteSecret",
      "anthropic.archiveFederationRule",
      "anthropic.archiveServiceAccount",
      "k8s.deleteServiceAccount",
    ]);
  });

  it("surfaces the original error when a rollback step fails too", async () => {
    const h = harness();
    h.store.addAgent(AGENT_ID, { ownerEmail: OWNER });
    const original = new Error("deployment create failed");
    h.k8s.failNext("createDeploymentManifest", original);
    h.anthropic.failNext("archiveFederationRule");
    h.k8s.failNext("deleteServiceAccount");
    await expect(h.provisioner.provision(AGENT_ID)).rejects.toBe(original);
    // The other rollback steps still ran.
    expect(h.anthropic.liveServiceAccounts()).toHaveLength(0);
  });
});

// ─── Lost-write recovery (find-by-name) ───────────────────────────────────────

describe("KubernetesAgentProvisioner.provision() — perAgent lost-write recovery", () => {
  it("recovers an Anthropic service account whose ID write was lost", async () => {
    const h = harness();
    h.store.addAgent(AGENT_ID, {
      ownerEmail: OWNER,
      anthropicIdentityName: IDENTITY_NAME,
    });
    const orphan = h.anthropic.seedServiceAccount(IDENTITY_NAME);

    await h.provisioner.provision(AGENT_ID);

    expect(h.anthropic.callsTo("findServiceAccountByName")).toEqual([
      IDENTITY_NAME,
    ]);
    expect((await h.store.get(AGENT_ID))?.anthropicServiceAccountId).toBe(
      orphan.id,
    );
    await expectFullyProvisioned(h);
  });

  it("recovers a federation rule whose ID write was lost", async () => {
    const h = harness();
    h.store.addAgent(AGENT_ID, {
      ownerEmail: OWNER,
      anthropicIdentityName: IDENTITY_NAME,
    });
    const sa = h.anthropic.seedServiceAccount(IDENTITY_NAME);
    await h.store.set(AGENT_ID, { anthropicServiceAccountId: sa.id });
    const orphan = h.anthropic.seedRule({
      name: IDENTITY_NAME,
      issuerId: "fdis_cluster",
      serviceAccountId: sa.id,
      match: { subjectPrefix: SUBJECT },
    });

    await h.provisioner.provision(AGENT_ID);

    expect(h.anthropic.callsTo("findFederationRuleByName")).toEqual([
      IDENTITY_NAME,
    ]);
    expect((await h.store.get(AGENT_ID))?.anthropicFederationRuleId).toBe(
      orphan.id,
    );
    await expectFullyProvisioned(h);
  });

  it("does not archive a recovered service account when a later step fails", async () => {
    const h = harness();
    h.store.addAgent(AGENT_ID, {
      ownerEmail: OWNER,
      anthropicIdentityName: IDENTITY_NAME,
    });
    const orphan = h.anthropic.seedServiceAccount(IDENTITY_NAME);
    h.anthropic.failNext("createFederationRule");

    await expect(h.provisioner.provision(AGENT_ID)).rejects.toThrow();

    expect(h.anthropic.callsTo("archiveServiceAccount")).toEqual([]);
    expect((await h.store.get(AGENT_ID))?.anthropicServiceAccountId).toBe(
      orphan.id,
    );
    await h.provisioner.provision(AGENT_ID);
    await expectFullyProvisioned(h);
  });

  it("rethrows the conflict when find-by-name finds nothing", async () => {
    const h = harness();
    h.store.addAgent(AGENT_ID, { ownerEmail: OWNER });
    const { AnthropicConflictError } = await import(
      "./anthropic-identity-client.ts"
    );
    const conflict = new AnthropicConflictError("createServiceAccount");
    h.anthropic.failNext("createServiceAccount", conflict);
    await expect(h.provisioner.provision(AGENT_ID)).rejects.toBe(conflict);
  });
});

// ─── reconcile ────────────────────────────────────────────────────────────────

describe("KubernetesAgentProvisioner.reconcile() — perAgent identity", () => {
  const SHARED_FED = {
    serviceAccountName: "shipwright-agent",
    ruleId: "fdrl_shared",
    organizationId: "org-1",
    serviceAccountId: "svac_shared",
    audience: "https://api.anthropic.com",
    expirationSeconds: 600,
  };

  function liveDeployment(fed?: typeof SHARED_FED) {
    return buildAgentDeploymentManifest({
      agentId: AGENT_ID,
      namespace: NAMESPACE,
      image: BASE_CONFIG.image,
      imageTag: BASE_CONFIG.imageTag,
      apiUrl: BASE_CONFIG.apiUrl,
      pvcName: `${RESOURCE}-home`,
      secretName: `${RESOURCE}-token`,
      tokenSecretKey: "token",
      ...(fed ? { anthropicFederation: fed } : {}),
    });
  }

  it("leaves federation untouched on an existing agent that has no per-agent identity yet", async () => {
    const h = harness();
    h.store.addAgent(AGENT_ID, { ownerEmail: OWNER });
    await h.recorded.createDeploymentManifest(
      NAMESPACE,
      liveDeployment(SHARED_FED),
    );

    const result = await h.provisioner.reconcile([{ id: AGENT_ID }]);

    expect(result.failed).toEqual([]);
    expect(result.updated).toEqual([]);
    const dep = await h.recorded.getDeployment(NAMESPACE, RESOURCE);
    expect(dep.spec.template.spec.serviceAccountName).toBe("shipwright-agent");
    expect(envOf(dep).ANTHROPIC_FEDERATION_RULE_ID).toBe("fdrl_shared");
    expect(h.anthropic.calls).toEqual([]);
  });

  it("does not fail an existing ownerless agent", async () => {
    const h = harness();
    h.store.addAgent(AGENT_ID);
    await h.recorded.createDeploymentManifest(NAMESPACE, liveDeployment());
    const result = await h.provisioner.reconcile([{ id: AGENT_ID }]);
    expect(result.failed).toEqual([]);
  });

  it("drift-corrects an existing Deployment to the agent's own identity", async () => {
    const h = harness();
    h.store.addAgent(AGENT_ID, {
      ownerEmail: OWNER,
      anthropicIdentityName: IDENTITY_NAME,
      anthropicServiceAccountId: "svac_own",
      anthropicFederationRuleId: "fdrl_own",
      k8sServiceAccountName: RESOURCE,
    });
    await h.recorded.createDeploymentManifest(
      NAMESPACE,
      liveDeployment(SHARED_FED),
    );

    const result = await h.provisioner.reconcile([{ id: AGENT_ID }], {
      policyOnly: true,
    });

    expect(result.updated).toEqual([AGENT_ID]);
    const dep = await h.recorded.getDeployment(NAMESPACE, RESOURCE);
    expect(dep.spec.template.spec.serviceAccountName).toBe(RESOURCE);
    expect(envOf(dep)).toMatchObject({
      ANTHROPIC_FEDERATION_RULE_ID: "fdrl_own",
      ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_own",
      ANTHROPIC_WORKSPACE_ID: "wrkspc_1",
    });
  });

  it("provisions a missing Deployment with a new per-agent identity", async () => {
    const h = harness();
    h.store.addAgent(AGENT_ID, { ownerEmail: OWNER });
    const result = await h.provisioner.reconcile([{ id: AGENT_ID }]);
    expect(result.recreated).toEqual([AGENT_ID]);
    await expectFullyProvisioned(h);
  });

  it("reports a missing Deployment for an ownerless agent as failed with the clear error", async () => {
    const h = harness();
    h.store.addAgent(AGENT_ID);
    const result = await h.provisioner.reconcile([{ id: AGENT_ID }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toMatch(/no owner/i);
  });
});

// ─── shared mode is untouched ─────────────────────────────────────────────────

describe("KubernetesAgentProvisioner.provision() — shared mode does not touch per-agent identity", () => {
  it("creates no ServiceAccount without perAgentIdentity config", async () => {
    const events: string[] = [];
    const recorded = new RecordedKubernetesClient({
      deployments: {},
      secrets: {},
      pvcs: {},
    });
    const k8s: KubernetesClient = faultyKubernetesClient(recorded, events);
    const provisioner = new KubernetesAgentProvisioner(
      k8s,
      stubTokens(),
      BASE_CONFIG,
    );
    await provisioner.provision(AGENT_ID);
    expect(events).toEqual([
      "k8s.createPvc",
      "k8s.getSecret",
      "k8s.createSecret",
      "k8s.createDeploymentManifest",
    ]);
  });
});

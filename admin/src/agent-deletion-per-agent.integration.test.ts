/**
 * admin/src/agent-deletion-per-agent.integration.test.ts
 * Integration tests for deleteAgentFully() against a real
 * KubernetesAgentProvisioner in perAgent identity mode: the anthropic-identity
 * step archives the federation rule, then the Anthropic service account, then
 * deletes the Kubernetes ServiceAccount, keeping the Agent row (and listing
 * what is left in the manual-steps checklist) when any piece fails.
 *
 * The agent is first provisioned for real so the identity it deletes is the one
 * provisioning created. Doubles are injected — RecordedKubernetesClient (wrapped
 * to fail on demand), FakeAnthropicIdentityClient, an in-memory identity store
 * and a tiny in-memory Prisma — so no DB, cluster or network is needed and no
 * globals are touched.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentAnthropicIdentity } from "./agent-anthropic-identity.ts";
import {
  type DeleteAgentFullyDeps,
  deleteAgentFully,
} from "./agent-deletion.ts";
import { sanitizeAgentName } from "./agent-manifest.ts";
import {
  KubernetesAgentProvisioner,
  type KubernetesAgentProvisionerConfig,
} from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import { AnthropicApiError } from "./anthropic-identity-client.ts";
import { RecordedKubernetesClient } from "./kubernetes-client.ts";
import {
  FakeAnthropicIdentityClient,
  faultyKubernetesClient,
  InMemoryAgentIdentityStore,
} from "./per-agent-identity.fixtures.ts";

const NAMESPACE = "agents";
const AGENT_ID = "cmqalfjcm000m4101iharq28k";
const AGENT_NAME = "dude-bot";
const RESOURCE = sanitizeAgentName(AGENT_ID);
const OWNER = "jane.doe@example.com";

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

/** Prisma double whose Agent identity columns live in the identity store. */
class StoreBackedPrisma {
  deleted = false;
  constructor(private readonly store: InMemoryAgentIdentityStore) {}

  agent = {
    findUnique: async (_args: {
      where: { id: string };
      select: {
        id: true;
        name: true;
        anthropicFederationRuleId: true;
        anthropicServiceAccountId: true;
        k8sServiceAccountName: true;
      };
    }) => {
      const row = this.store.rows.get(AGENT_ID);
      if (this.deleted || !row) return null;
      return {
        id: AGENT_ID,
        name: AGENT_NAME,
        anthropicFederationRuleId: row.anthropicFederationRuleId,
        anthropicServiceAccountId: row.anthropicServiceAccountId,
        k8sServiceAccountName: row.k8sServiceAccountName,
      };
    },
    delete: async (_args: { where: { id: string } }): Promise<unknown> => {
      this.deleted = true;
      return {};
    },
  };

  agentEnv = {
    findMany: async (_args: {
      where: { agentId: string };
      select: { key: true; value: true; secret: true };
    }): Promise<{ key: string; value: string; secret: boolean }[]> => [],
  };
}

interface Harness {
  events: string[];
  recorded: RecordedKubernetesClient;
  k8s: ReturnType<typeof faultyKubernetesClient>;
  anthropic: FakeAnthropicIdentityClient;
  store: InMemoryAgentIdentityStore;
  prisma: StoreBackedPrisma;
  provisioner: KubernetesAgentProvisioner;
  deps: DeleteAgentFullyDeps;
}

function harness(opts: { perAgent?: boolean } = {}): Harness {
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
  const perAgent = opts.perAgent ?? true;
  const provisioner = new KubernetesAgentProvisioner(k8s, stubTokens(), {
    ...BASE_CONFIG,
    ...(perAgent
      ? {
          perAgentIdentity: {
            client: anthropic,
            identities: store,
            names: store,
            organizationId: "org-1",
            workspaceId: "wrkspc_1",
            issuerId: "fdis_cluster",
            audience: "https://api.anthropic.com",
            expirationSeconds: 600,
          },
        }
      : {}),
  });
  const prisma = new StoreBackedPrisma(store);
  const deps: DeleteAgentFullyDeps = {
    prisma,
    provisioner,
    taskStore: {
      listTokensForAgent: async () => [],
      revokeToken: async () => {},
    },
    chatService: {
      listTokensForAgent: async () => [],
      revokeToken: async () => {},
      deleteThreadsForAgent: async () => ({ deleted: 0 }),
    },
    slack: { deleteApp: async () => {} },
    decrypt: (value) => value,
  };
  return { events, recorded, k8s, anthropic, store, prisma, provisioner, deps };
}

/** Provision the agent for real, then forget the provisioning events. */
async function provisioned(h: Harness): Promise<void> {
  h.store.addAgent(AGENT_ID, { ownerEmail: OWNER });
  await h.provisioner.provision(AGENT_ID, { slug: AGENT_NAME });
  h.events.length = 0;
}

async function exists(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch {
    return false;
  }
}

function identityOf(h: Harness): AgentAnthropicIdentity {
  return h.store.rows.get(AGENT_ID) as AgentAnthropicIdentity;
}

describe("deleteAgentFully — per-agent Anthropic identity", () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await provisioned(h);
  });

  it("removes the rule, then the Anthropic service account, then the K8s ServiceAccount, clearing each ID, and deletes the row", async () => {
    const result = await deleteAgentFully(AGENT_ID, h.deps);

    expect(result.failed).toEqual([]);
    expect(result.agentDeleted).toBe(true);
    expect(result.completed).toContain("anthropic-identity");
    expect(h.prisma.deleted).toBe(true);

    const start = h.events.indexOf("anthropic.archiveFederationRule");
    expect(h.events.slice(start)).toEqual([
      "anthropic.archiveFederationRule",
      "store.set(anthropicFederationRuleId)",
      "anthropic.archiveServiceAccount",
      "store.set(anthropicServiceAccountId)",
      "k8s.deleteServiceAccount",
      "store.set(k8sServiceAccountName)",
    ]);
    // The workload is torn down before its identity is pulled.
    expect(h.events.indexOf("k8s.deleteDeployment")).toBeLessThan(start);

    expect(h.anthropic.liveRules()).toHaveLength(0);
    expect(h.anthropic.liveServiceAccounts()).toHaveLength(0);
    expect(
      await exists(h.recorded.getServiceAccount(NAMESPACE, RESOURCE)),
    ).toBe(false);
    expect(identityOf(h).anthropicFederationRuleId).toBeNull();
    expect(identityOf(h).anthropicServiceAccountId).toBeNull();
    expect(identityOf(h).k8sServiceAccountName).toBeNull();
    expect(result.manualStepsRequired).toEqual([]);
  });

  it("keeps the row and lists the remaining pieces when the service account archive fails, then a retry finishes", async () => {
    h.anthropic.failNext("archiveServiceAccount");

    const first = await deleteAgentFully(AGENT_ID, h.deps);

    expect(first.agentDeleted).toBe(false);
    expect(h.prisma.deleted).toBe(false);
    expect(first.failed.map((f) => f.step)).toEqual(["anthropic-identity"]);
    // The rule was archived and its ID cleared before the failure.
    expect(h.anthropic.liveRules()).toHaveLength(0);
    expect(identityOf(h).anthropicFederationRuleId).toBeNull();
    expect(identityOf(h).anthropicServiceAccountId).not.toBeNull();
    expect(identityOf(h).k8sServiceAccountName).toBe(RESOURCE);
    // The K8s ServiceAccount is untouched: it is removed last.
    expect(
      await exists(h.recorded.getServiceAccount(NAMESPACE, RESOURCE)),
    ).toBe(true);
    expect(first.manualStepsRequired.map((s) => s.key)).toEqual([
      "anthropicServiceAccountId",
      "k8sServiceAccountName",
    ]);

    const retry = await deleteAgentFully(AGENT_ID, h.deps);

    expect(retry.failed).toEqual([]);
    expect(retry.agentDeleted).toBe(true);
    expect(h.prisma.deleted).toBe(true);
    expect(h.anthropic.liveServiceAccounts()).toHaveLength(0);
    // The retry only redid what was left: the rule was archived exactly once.
    expect(h.anthropic.callsTo("archiveFederationRule")).toHaveLength(1);
  });

  it("never archives the service account while the rule is still live", async () => {
    h.anthropic.failNext("archiveFederationRule");

    const result = await deleteAgentFully(AGENT_ID, h.deps);

    expect(result.agentDeleted).toBe(false);
    expect(h.anthropic.callsTo("archiveServiceAccount")).toEqual([]);
    expect(h.anthropic.liveRules()).toHaveLength(1);
    expect(result.manualStepsRequired.map((s) => s.key)).toEqual([
      "anthropicFederationRuleId",
      "anthropicServiceAccountId",
      "k8sServiceAccountName",
    ]);
  });

  it("keeps the row when the K8s ServiceAccount delete fails and lists only it", async () => {
    h.k8s.failNext("deleteServiceAccount");

    const result = await deleteAgentFully(AGENT_ID, h.deps);

    expect(result.agentDeleted).toBe(false);
    expect(result.manualStepsRequired.map((s) => s.key)).toEqual([
      "k8sServiceAccountName",
    ]);
    expect(identityOf(h).anthropicServiceAccountId).toBeNull();
  });

  it("treats an already-removed piece as done", async () => {
    await h.recorded.deleteServiceAccount(NAMESPACE, RESOURCE);
    const ruleId = identityOf(h).anthropicFederationRuleId as string;
    await h.anthropic.archiveFederationRule(ruleId);
    h.anthropic.failNext(
      "archiveFederationRule",
      new AnthropicApiError("archiveFederationRule", 404),
    );

    const result = await deleteAgentFully(AGENT_ID, h.deps);

    expect(ruleId).toBeTruthy();
    expect(result.failed).toEqual([]);
    expect(result.agentDeleted).toBe(true);
  });
});

describe("deleteAgentFully — provisioner without per-agent identity", () => {
  it("fails the step and checklists the saved pieces rather than leaking them", async () => {
    const h = harness({ perAgent: false });
    h.store.addAgent(AGENT_ID, {
      ownerEmail: OWNER,
      anthropicServiceAccountId: "svac_1",
      anthropicFederationRuleId: "fdrl_1",
    });

    const result = await deleteAgentFully(AGENT_ID, h.deps);

    expect(result.agentDeleted).toBe(false);
    expect(result.failed.map((f) => f.step)).toEqual(["anthropic-identity"]);
    expect(result.manualStepsRequired.map((s) => s.key)).toEqual([
      "anthropicFederationRuleId",
      "anthropicServiceAccountId",
    ]);
  });

  it("behaves exactly as before for an agent with no identity", async () => {
    const h = harness({ perAgent: false });
    h.store.addAgent(AGENT_ID);

    const result = await deleteAgentFully(AGENT_ID, h.deps);

    expect(result.agentDeleted).toBe(true);
    expect(result.completed).not.toContain("anthropic-identity");
  });
});

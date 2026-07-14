/**
 * admin/src/agent-provisioner.integration.test.ts
 * Integration tests for KubernetesAgentProvisioner.
 *
 * Composes the REAL AgentTokenService against a real Postgres test DB with an
 * injected in-memory KubernetesClient (RecordedKubernetesClient) standing in
 * for the cluster. No globals are overridden — the fake is injected via the
 * constructor.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise (CI provides it).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import {
  type DeleteAgentFullyDeps,
  deleteAgentFully,
} from "./agent-deletion.ts";
import {
  buildAgentSecretManifest,
  sanitizeAgentName,
} from "./agent-manifest.ts";
import {
  type AgentProvisioner,
  KubernetesAgentProvisioner,
  type KubernetesAgentProvisionerConfig,
  NoopAgentProvisioner,
} from "./agent-provisioner.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import type { ChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import { ConflictError } from "./errors.ts";
import {
  type DeploymentSpec,
  type KubernetesClient,
  type KubernetesDeployment,
  type KubernetesPvc,
  type KubernetesSecret,
  type PvcSpec,
  RecordedKubernetesClient,
  type SecretSpec,
} from "./kubernetes-client.ts";
import type { SlackProvisioningClient } from "./slack-provisioning-client.ts";
import type { TaskStoreProvisioningClient } from "./task-store-provisioning-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const NAMESPACE = "shipwright";

const CONFIG: KubernetesAgentProvisionerConfig = {
  namespace: NAMESPACE,
  image: "ghcr.io/app-vitals/shipwright-agent",
  imageTag: "v1.2.3",
  apiUrl: "http://shipwright-admin.shipwright.svc:3001",
};

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

function emptyClient(): RecordedKubernetesClient {
  return new RecordedKubernetesClient({
    deployments: {},
    secrets: {},
    pvcs: {},
  });
}

/** Decode the token value the Secret carries under the default "token" key. */
function decodeSecretToken(secret: KubernetesSecret): string {
  return Buffer.from(secret.data.token, "base64").toString("utf-8");
}

describeOrSkip("KubernetesAgentProvisioner (integration)", () => {
  let prisma: PrismaClient;
  let tokens: AgentTokenService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    tokens = new AgentTokenService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  async function createAgent(name = "Test Agent"): Promise<string> {
    const agent = await prisma.agent.create({ data: { name } });
    return agent.id;
  }

  // ─── provision ──────────────────────────────────────────────────────────────

  it("provision() mints a token, then creates the Secret and Deployment", async () => {
    const agentId = await createAgent();
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    const result = await provisioner.provision(agentId);

    const name = sanitizeAgentName(agentId);
    expect(result.resourceName).toBe(name);
    expect(result.secretName).toBe(`${name}-token`);
    expect(result.deploymentName).toBe(name);
    expect(result.rawToken).toBeDefined();

    // Secret carries the minted token, and the token validates via the service.
    const secret = await k8s.getSecret(NAMESPACE, `${name}-token`);
    const carried = decodeSecretToken(secret);
    expect(result.rawToken).toBeDefined();
    expect(carried).toBe(result.rawToken as string);
    const validated = await tokens.validate(carried);
    expect(validated?.agentId).toBe(agentId);

    // Deployment exists and points at the right image.
    const dep = await k8s.getDeployment(NAMESPACE, name);
    expect(dep.spec.template.spec.containers[0].image).toBe(
      "ghcr.io/app-vitals/shipwright-agent:v1.2.3",
    );
  });

  it("provision() creates the Secret BEFORE the Deployment (order)", async () => {
    const agentId = await createAgent();
    const order: string[] = [];
    const recorded = emptyClient();
    const ordered: KubernetesClient = {
      createSecret: (ns: string, spec: SecretSpec) => {
        order.push("secret");
        return recorded.createSecret(ns, spec);
      },
      createDeployment: (ns: string, spec: DeploymentSpec) => {
        return recorded.createDeployment(ns, spec);
      },
      createDeploymentManifest: (
        ns: string,
        manifest: KubernetesDeployment,
      ) => {
        order.push("deployment");
        return recorded.createDeploymentManifest(ns, manifest);
      },
      createPvc: (ns: string, spec: PvcSpec) => {
        order.push("pvc");
        return recorded.createPvc(ns, spec);
      },
      getSecret: (ns, n) => recorded.getSecret(ns, n),
      getDeployment: (ns, n) => recorded.getDeployment(ns, n),
      getPvc: (ns, n) => recorded.getPvc(ns, n),
      deleteSecret: (ns, n) => recorded.deleteSecret(ns, n),
      deleteDeployment: (ns, n) => recorded.deleteDeployment(ns, n),
      deletePvc: (ns, n) => recorded.deletePvc(ns, n),
      deploymentExists: (ns, n) => recorded.deploymentExists(ns, n),
      listDeployments: (ns, sel) => recorded.listDeployments(ns, sel),
      patchDeployment: (ns, n, p) => recorded.patchDeployment(ns, n, p),
    };
    const provisioner = new KubernetesAgentProvisioner(ordered, tokens, CONFIG);

    await provisioner.provision(agentId);
    expect(order).toEqual(["pvc", "secret", "deployment"]);
  });

  it("deprovision() deletes Deployment, Secret, and PVC", async () => {
    const agentId = await createAgent();
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    await provisioner.provision(agentId);
    await provisioner.deprovision(agentId);

    const name = sanitizeAgentName(agentId);
    // Deployment, Secret, and PVC must all be gone — a deliberate full agent
    // delete (unlike provision()'s rollback path) also removes the PVC so
    // deleted agents don't leak storage indefinitely.
    await expect(k8s.getDeployment(NAMESPACE, name)).rejects.toThrow();
    await expect(k8s.getSecret(NAMESPACE, `${name}-token`)).rejects.toThrow();
    await expect(k8s.getPvc(NAMESPACE, `${name}-home`)).rejects.toThrow();
  });

  it("provision() is safe to retry (provision twice → no throw)", async () => {
    const agentId = await createAgent();
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    await provisioner.provision(agentId);
    // Second call hits ConflictError on both create calls; must not throw.
    await expect(provisioner.provision(agentId)).resolves.toBeDefined();

    const name = sanitizeAgentName(agentId);
    // Resources still present after the retry.
    await expect(
      k8s.getSecret(NAMESPACE, `${name}-token`),
    ).resolves.toBeDefined();
    await expect(k8s.getDeployment(NAMESPACE, name)).resolves.toBeDefined();
  });

  // ─── failure / rollback ───────────────────────────────────────────────────────

  it("provision() rolls back the Secret if Deployment creation fails", async () => {
    const agentId = await createAgent();
    const recorded = emptyClient();
    const failing: KubernetesClient = {
      createPvc: (ns, spec) => recorded.createPvc(ns, spec),
      createSecret: (ns, spec) => recorded.createSecret(ns, spec),
      createDeployment: async () => {
        throw new Error("simulated API server failure");
      },
      createDeploymentManifest: async () => {
        throw new Error("simulated API server failure");
      },
      getSecret: (ns, n) => recorded.getSecret(ns, n),
      getDeployment: (ns, n) => recorded.getDeployment(ns, n),
      getPvc: (ns, n) => recorded.getPvc(ns, n),
      deleteSecret: (ns, n) => recorded.deleteSecret(ns, n),
      deleteDeployment: (ns, n) => recorded.deleteDeployment(ns, n),
      deletePvc: (ns, n) => recorded.deletePvc(ns, n),
      deploymentExists: (ns, n) => recorded.deploymentExists(ns, n),
      listDeployments: (ns, sel) => recorded.listDeployments(ns, sel),
      patchDeployment: (ns, n, p) => recorded.patchDeployment(ns, n, p),
    };
    const provisioner = new KubernetesAgentProvisioner(failing, tokens, CONFIG);

    await expect(provisioner.provision(agentId)).rejects.toThrow(
      "simulated API server failure",
    );

    const name = sanitizeAgentName(agentId);
    // Secret must have been cleaned up so a retry starts clean.
    await expect(
      recorded.getSecret(NAMESPACE, `${name}-token`),
    ).rejects.toThrow();
  });

  it("provision() rolls back the freshly-minted Secret when the Deployment already exists (409)", async () => {
    const agentId = await createAgent();
    const name = sanitizeAgentName(agentId);
    // Seed ONLY the Deployment — the Secret does NOT pre-exist. This call mints
    // a token and creates a new Secret, then hits a 409 on the Deployment. The
    // orphaned Secret (carrying a fresh, unused token) must be rolled back.
    const k8s = emptyClient();
    await k8s.createDeployment(NAMESPACE, {
      name,
      image: `${CONFIG.image}:${CONFIG.imageTag}`,
    });
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    // (a) Idempotent success — does NOT throw despite the Deployment conflict.
    await expect(provisioner.provision(agentId)).resolves.toBeDefined();

    // (b) The Secret created during THIS call was deleted, not left behind.
    await expect(k8s.getSecret(NAMESPACE, `${name}-token`)).rejects.toThrow();
  });

  it("provision() succeeds idempotently when both resources already exist", async () => {
    const agentId = await createAgent();
    const name = sanitizeAgentName(agentId);
    // Pre-seed both resources as if a prior provision had completed.
    const seededSecret = buildAgentSecretManifest({
      name: `${name}-token`,
      namespace: NAMESPACE,
      token: "preexisting",
    });
    const k8s = new RecordedKubernetesClient({
      deployments: {},
      secrets: { [`${NAMESPACE}/${name}-token`]: seededSecret },
    });
    // Pre-create the deployment too.
    await k8s.createDeployment(NAMESPACE, {
      name,
      image: `${CONFIG.image}:${CONFIG.imageTag}`,
    });
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    await expect(provisioner.provision(agentId)).resolves.toBeDefined();
  });

  // ─── reconcile ────────────────────────────────────────────────────────────────

  it("reconcile() returns empty arrays when there are no agents and no k8s deployments", async () => {
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);
    const result = await provisioner.reconcile([]);
    expect(result).toEqual({
      recreated: [],
      updated: [],
      orphans: [],
      failed: [],
    });
  });

  it("reconcile() recreates a Deployment for a known agent missing from K8s", async () => {
    const agentId = await createAgent("ReconcileAgent");
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    // Agent exists in DB, but no k8s Deployment provisioned yet.
    const result = await provisioner.reconcile([{ id: agentId }]);

    expect(result.orphans).toEqual([]);
    expect(result.recreated).toEqual([agentId]);

    // The deployment was actually created in k8s.
    const name = sanitizeAgentName(agentId);
    await expect(k8s.getDeployment(NAMESPACE, name)).resolves.toBeDefined();
  });

  it("reconcile() reports orphan deployments not in the known agent list", async () => {
    const k8s = emptyClient();
    // Pre-seed an orphaned deployment in k8s (not tied to any DB agent).
    const orphanName = sanitizeAgentName("orphaned-agent-id-xyz");
    await k8s.createDeployment(NAMESPACE, {
      name: orphanName,
      image: `${CONFIG.image}:${CONFIG.imageTag}`,
      labels: {
        "app.kubernetes.io/name": "shipwright-agent",
        "app.kubernetes.io/managed-by": "shipwright-admin",
      },
    });
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    // No known agents — the k8s deployment is an orphan.
    const result = await provisioner.reconcile([]);

    expect(result.recreated).toEqual([]);
    expect(result.orphans).toEqual([orphanName]);
  });

  it("reconcile() returns no recreated/orphans when everything matches", async () => {
    const agentId = await createAgent("MatchingAgent");
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    // First provision it properly.
    await provisioner.provision(agentId);

    // Now reconcile — should be a clean no-op.
    const result = await provisioner.reconcile([{ id: agentId }]);
    expect(result.recreated).toEqual([]);
    expect(result.orphans).toEqual([]);
  });

  it("reconcile() detects a stale image, patches the deployment, and adds to updated[]", async () => {
    const agentId = await createAgent("StaleImageAgent");
    const resourceName = sanitizeAgentName(agentId);
    const k8s = emptyClient();

    // Seed a deployment with a stale image directly in the cassette.
    const staleDeployment: KubernetesDeployment = {
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
                image: `${CONFIG.image}:v0.0.1`, // stale — CONFIG.imageTag is v1.2.3
              },
            ],
          },
        },
      },
    };
    // Inject directly via the internal map by provisioning with a fake client,
    // then overwriting through createDeploymentManifest on an empty client.
    await k8s.createDeploymentManifest(NAMESPACE, staleDeployment);

    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    const result = await provisioner.reconcile([{ id: agentId }]);

    expect(result.updated).toEqual([agentId]);
    expect(result.recreated).toEqual([]);
    expect(result.failed).toEqual([]);

    // RecordedKubernetesClient mutates containers[0].image on patchDeployment.
    const dep = await k8s.getDeployment(NAMESPACE, resourceName);
    expect(dep.spec.template.spec.containers[0].image).toBe(
      `${CONFIG.image}:${CONFIG.imageTag}`,
    );
  });

  // ─── PVC name template ───────────────────────────────────────────────────────

  it("provision() uses slug for PVC name when pvcName template is configured", async () => {
    const agentId = await createAgent("OkWOW Agent");
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, {
      ...CONFIG,
      pvcName: (name) => `acme-agent-${name}-home`,
    });

    await provisioner.provision(agentId, { slug: "okwow" });

    // PVC must use the slug, not the sanitized agentId.
    await expect(
      k8s.getPvc(NAMESPACE, "acme-agent-okwow-home"),
    ).resolves.toBeDefined();
    // Default-named PVC must NOT exist.
    const resourceName = sanitizeAgentName(agentId);
    await expect(
      k8s.getPvc(NAMESPACE, `acme-agent-${resourceName}-home`),
    ).rejects.toThrow();
  });

  it("provision() falls back to resourceName when slug is absent and pvcName is configured", async () => {
    const agentId = await createAgent("FallbackAgent");
    const k8s = emptyClient();
    const resourceName = sanitizeAgentName(agentId);
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, {
      ...CONFIG,
      pvcName: (name) => `acme-agent-${name}-home`,
    });

    // Call provision() with no opts — slug is absent.
    await provisioner.provision(agentId);

    // PVC must use the sanitized resourceName (not a slug).
    await expect(
      k8s.getPvc(NAMESPACE, `acme-agent-${resourceName}-home`),
    ).resolves.toBeDefined();
  });

  it("provision() sanitizes an unsafe slug before passing to pvcName template", async () => {
    const agentId = await createAgent("Uppercase Spaces Agent");
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, {
      ...CONFIG,
      pvcName: (name) => `acme-agent-${name}-home`,
    });

    // slug contains uppercase and spaces — must be RFC1123 sanitized.
    await provisioner.provision(agentId, { slug: "My Agent" });

    // sanitizeAgentName("My Agent") → "my-agent-<hash>" (lossy path → hash suffix)
    const sanitized = sanitizeAgentName("My Agent");
    await expect(
      k8s.getPvc(NAMESPACE, `acme-agent-${sanitized}-home`),
    ).resolves.toBeDefined();
    // Raw unsanitized PVC name must NOT exist.
    await expect(
      k8s.getPvc(NAMESPACE, "acme-agent-My Agent-home"),
    ).rejects.toThrow();
  });

  it("reconcile() uses slug for PVC name when template is configured", async () => {
    const agentId = await createAgent("ReconcileSlugAgent");
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, {
      ...CONFIG,
      pvcName: (name) => `acme-agent-${name}-home`,
    });

    // Agent exists in DB, no k8s Deployment — reconcile should provision it.
    const result = await provisioner.reconcile([
      { id: agentId, slug: "okwow" },
    ]);

    expect(result.recreated).toEqual([agentId]);
    // PVC must use the slug passed through reconcile.
    await expect(
      k8s.getPvc(NAMESPACE, "acme-agent-okwow-home"),
    ).resolves.toBeDefined();
  });

  // ─── deprovision ──────────────────────────────────────────────────────────────

  it("deprovision() deletes both the Deployment and the Secret", async () => {
    const agentId = await createAgent();
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    await provisioner.provision(agentId);
    await provisioner.deprovision(agentId);

    const name = sanitizeAgentName(agentId);
    await expect(k8s.getSecret(NAMESPACE, `${name}-token`)).rejects.toThrow();
    await expect(k8s.getDeployment(NAMESPACE, name)).rejects.toThrow();
    await expect(k8s.getPvc(NAMESPACE, `${name}-home`)).rejects.toThrow();
  });

  it("deprovision() tolerates already-absent resources (no throw)", async () => {
    const agentId = await createAgent();
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    // Nothing provisioned — deprovision must be a no-op.
    await expect(provisioner.deprovision(agentId)).resolves.toBeUndefined();
    // And a second deprovision after a real one is still a no-op.
    await provisioner.provision(agentId);
    await provisioner.deprovision(agentId);
    await expect(provisioner.deprovision(agentId)).resolves.toBeUndefined();
  });

  it("deprovision() tolerates an already-absent PVC (idempotent re-delete, no throw)", async () => {
    const agentId = await createAgent();
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    // Provision, then deprovision once — the PVC is deleted along with the
    // Deployment and Secret. A second deprovision call must not throw even
    // though the PVC (and everything else) is already gone (404 swallowed).
    await provisioner.provision(agentId);
    await provisioner.deprovision(agentId);

    const name = sanitizeAgentName(agentId);
    await expect(k8s.getPvc(NAMESPACE, `${name}-home`)).rejects.toThrow();
    await expect(provisioner.deprovision(agentId)).resolves.toBeUndefined();
  });

  it("deprovision() deletes the templated PVC name derived from slug", async () => {
    const agentId = await createAgent("OkWOW Agent");
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, {
      ...CONFIG,
      pvcName: (name) => `acme-agent-${name}-home`,
    });

    await provisioner.provision(agentId, { slug: "okwow" });
    await expect(
      k8s.getPvc(NAMESPACE, "acme-agent-okwow-home"),
    ).resolves.toBeDefined();

    await provisioner.deprovision(agentId, { slug: "okwow" });

    await expect(
      k8s.getPvc(NAMESPACE, "acme-agent-okwow-home"),
    ).rejects.toThrow();
  });

  // ─── task-store token in Secret ──────────────────────────────────────────────

  it("provision() stores task-store token in the Secret under 'task-store-token' key", async () => {
    const agentId = await createAgent("TaskStoreAgent");
    const k8s = emptyClient();

    const EXPECTED_RAW_TOKEN = "ts-raw-token-abc123";

    const fakeTaskStore: TaskStoreProvisioningClient = {
      async mintToken(_label: string) {
        return { id: "ts-id-1", rawToken: EXPECTED_RAW_TOKEN };
      },
      async revokeToken(_id: string) {
        // no-op in this test
      },
      async listTokensForAgent(_agentId: string) {
        return [];
      },
    };

    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, {
      ...CONFIG,
      taskStore: fakeTaskStore,
    });

    await provisioner.provision(agentId);

    const name = sanitizeAgentName(agentId);
    const secret = await k8s.getSecret(NAMESPACE, `${name}-token`);

    // The 'task-store-token' key must be present in the Secret's data.
    const encoded = secret.data["task-store-token"];
    expect(encoded).toBeDefined();
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    expect(decoded).toBe(EXPECTED_RAW_TOKEN);
  });
});

// ─── Composed provisioning → deletion journey (T-006) ──────────────────────────
//
// Exercises KubernetesAgentProvisioner.provision() and deleteAgentFully() TOGETHER
// in one run, across all 5 injected external clients (K8s, task-store, chat
// service, Slack, DB/Prisma). A single shared `order: string[]` array is wired
// into every fake so the whole journey's call order can be asserted in one
// place, proving both documented invariants:
//   - provision(): token → Secret → Deployment (module docstring above).
//   - deleteAgentFully(): the Agent DB row is deleted LAST (agent-deletion.ts).

describeOrSkip(
  "agent provisioning journey (provision → delete, integration)",
  () => {
    let prisma: PrismaClient;
    let tokens: AgentTokenService;

    beforeEach(async () => {
      prisma = makePrisma();
      await prisma.agentToken.deleteMany();
      await prisma.agentCronJob.deleteMany();
      await prisma.agentTool.deleteMany();
      await prisma.agentEnv.deleteMany();
      await prisma.agent.deleteMany();
      tokens = new AgentTokenService(prisma);
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    async function createAgentWithSlackEnv(
      name = "Journey Agent",
    ): Promise<string> {
      const agent = await prisma.agent.create({ data: { name } });
      // Plaintext SLACK_APP_ID — identity `decrypt` below treats env values as
      // unencrypted in this test, matching agent-deletion.unit.test.ts's FakePrisma
      // convention, so the Slack deletion branch is exercised end-to-end.
      await prisma.agentEnv.create({
        data: {
          agentId: agent.id,
          key: "SLACK_APP_ID",
          value: "A-JOURNEY-APP",
          secret: true,
        },
      });
      return agent.id;
    }

    /**
     * Wrap a RecordedKubernetesClient so createSecret / createDeploymentManifest
     * push into the shared `order` array — same pattern as the standalone
     * "provision() creates the Secret BEFORE the Deployment (order)" test above,
     * but this instance is reused for BOTH provision() (via the full
     * KubernetesClient interface) and deprovision() (via the narrower
     * Pick<AgentProvisioner, "deprovision"> deps.provisioner in deleteAgentFully).
     */
    function orderedK8s(
      order: string[],
      recorded: RecordedKubernetesClient,
    ): KubernetesClient {
      return {
        createPvc: (ns: string, spec: PvcSpec) => recorded.createPvc(ns, spec),
        createSecret: (ns: string, spec: SecretSpec) => {
          order.push("k8s:secret");
          return recorded.createSecret(ns, spec);
        },
        createDeployment: (ns: string, spec: DeploymentSpec) =>
          recorded.createDeployment(ns, spec),
        createDeploymentManifest: (
          ns: string,
          manifest: KubernetesDeployment,
        ) => {
          order.push("k8s:deployment");
          return recorded.createDeploymentManifest(ns, manifest);
        },
        getSecret: (ns, n) => recorded.getSecret(ns, n),
        getDeployment: (ns, n) => recorded.getDeployment(ns, n),
        getPvc: (ns, n) => recorded.getPvc(ns, n),
        deleteSecret: (ns, n) => recorded.deleteSecret(ns, n),
        deleteDeployment: (ns, n) => recorded.deleteDeployment(ns, n),
        deletePvc: (ns, n) => recorded.deletePvc(ns, n),
        deploymentExists: (ns, n) => recorded.deploymentExists(ns, n),
        listDeployments: (ns, sel) => recorded.listDeployments(ns, sel),
        patchDeployment: (ns, n, p) => recorded.patchDeployment(ns, n, p),
      };
    }

    /** Fake TaskStoreProvisioningClient that records into the shared order array. */
    function orderedTaskStore(
      order: string[],
      opts: { revokeError?: Error } = {},
    ): TaskStoreProvisioningClient {
      return {
        async mintToken(_label: string, _agentId?: string) {
          order.push("task-store:mintToken");
          return { id: "ts-journey-id", rawToken: "ts-journey-raw" };
        },
        async revokeToken(_id: string) {
          order.push("task-store:revoke");
          if (opts.revokeError) throw opts.revokeError;
        },
        async listTokensForAgent(_agentId: string) {
          return [{ id: "ts-journey-id" }];
        },
      };
    }

    /** Fake ChatServiceProvisioningClient that records into the shared order array. */
    function orderedChatService(
      order: string[],
      opts: { revokeError?: Error; deleteThreadsError?: Error } = {},
    ): ChatServiceProvisioningClient {
      return {
        async mintToken(_label: string, _agentId?: string) {
          order.push("chat:mintToken");
          return { id: "cs-journey-id", rawToken: "cs-journey-raw" };
        },
        async revokeToken(_id: string) {
          order.push("chat:revoke");
          if (opts.revokeError) throw opts.revokeError;
        },
        async listTokensForAgent(_agentId: string) {
          return [{ id: "cs-journey-id" }];
        },
        async deleteThreadsForAgent(_agentId: string) {
          order.push("chat:deleteThreads");
          if (opts.deleteThreadsError) throw opts.deleteThreadsError;
          return { deleted: 0 };
        },
      };
    }

    /** Fake SlackProvisioningClient (only deleteApp is used) recording into order. */
    function orderedSlack(
      order: string[],
      opts: { deleteAppError?: Error } = {},
    ): Pick<SlackProvisioningClient, "deleteApp"> {
      return {
        async deleteApp(_xoxpToken: string, _appId: string) {
          order.push("slack:deleteApp");
          if (opts.deleteAppError) throw opts.deleteAppError;
        },
      };
    }

    /** Build DeleteAgentFullyDeps around a shared order array + real Prisma. */
    function makeDeleteDeps(
      order: string[],
      provisioner: Pick<AgentProvisioner, "deprovision">,
      overrides: {
        taskStore?: Pick<
          TaskStoreProvisioningClient,
          "listTokensForAgent" | "revokeToken"
        >;
        chatService?: Pick<
          ChatServiceProvisioningClient,
          "listTokensForAgent" | "revokeToken" | "deleteThreadsForAgent"
        >;
        slack?: Pick<SlackProvisioningClient, "deleteApp">;
      } = {},
    ): DeleteAgentFullyDeps {
      return {
        prisma: {
          agent: {
            findUnique: async (args) => {
              const row = await prisma.agent.findUnique({
                where: args.where,
                select: { id: true, name: true },
              });
              return row;
            },
            delete: async (args) => {
              order.push("db:agent-delete");
              return prisma.agent.delete({ where: args.where });
            },
          },
          agentEnv: {
            findMany: async (args) =>
              prisma.agentEnv.findMany({
                where: args.where,
                select: { key: true, value: true, secret: true },
              }),
          },
        },
        provisioner: {
          deprovision: async (agentId, opts) => {
            order.push("k8s:deprovision");
            await provisioner.deprovision(agentId, opts);
          },
        },
        taskStore: overrides.taskStore ?? orderedTaskStore(order),
        chatService: overrides.chatService ?? orderedChatService(order),
        slack: overrides.slack ?? orderedSlack(order),
        // Identity decrypt — SLACK_APP_ID is stored plaintext in this test.
        decrypt: (value) => value,
      };
    }

    it(
      "composes provision() → deleteAgentFully() across all 5 external clients " +
        "in documented order (token→Secret→Deployment, then DB row deleted LAST)",
      async () => {
        const order: string[] = [];
        const agentId = await createAgentWithSlackEnv();
        const recorded = emptyClient();
        const k8s = orderedK8s(order, recorded);

        // Wrap AgentTokenService.create so the real DB-backed token mint is
        // captured in the shared order array too (positioned before k8s:secret).
        const orderedTokens = {
          create: async (id: string, label?: string) => {
            const result = await tokens.create(id, label);
            order.push("db:token");
            return result;
          },
        } as AgentTokenService;

        const provisioner = new KubernetesAgentProvisioner(
          k8s,
          orderedTokens,
          {
            ...CONFIG,
            taskStore: orderedTaskStore(order),
            chatService: orderedChatService(order),
          },
        );

        // ── Provision ────────────────────────────────────────────────────────
        const provisionResult = await provisioner.provision(agentId);
        expect(provisionResult.rawToken).toBeDefined();

        // Documented order: token minting (task-store, chat, then the agent's
        // own DB-backed token) happens BEFORE the Secret, which happens BEFORE
        // the Deployment.
        expect(order).toEqual([
          "task-store:mintToken",
          "chat:mintToken",
          "db:token",
          "k8s:secret",
          "k8s:deployment",
        ]);
        const tokenIdx = order.indexOf("db:token");
        const secretIdx = order.indexOf("k8s:secret");
        const deploymentIdx = order.indexOf("k8s:deployment");
        expect(tokenIdx).toBeLessThan(secretIdx);
        expect(secretIdx).toBeLessThan(deploymentIdx);

        // ── Delete ───────────────────────────────────────────────────────────
        const deleteDeps = makeDeleteDeps(order, provisioner);
        const deleteResult = await deleteAgentFully(agentId, deleteDeps, {
          xoxpToken: "xoxp-journey-token",
        });

        expect(deleteResult.agentDeleted).toBe(true);
        expect(deleteResult.failed).toEqual([]);

        // The DB row delete is the LAST entry in the shared order array — proving
        // "DB row deleted LAST" across the whole composed journey, not just
        // within deleteAgentFully() in isolation.
        expect(order[order.length - 1]).toBe("db:agent-delete");
        expect(order).toContain("k8s:deprovision");
        expect(order).toContain("task-store:revoke");
        expect(order).toContain("chat:revoke");
        expect(order).toContain("chat:deleteThreads");
        expect(order).toContain("slack:deleteApp");

        // The Agent row is actually gone from Postgres.
        const remaining = await prisma.agent.findUnique({
          where: { id: agentId },
        });
        expect(remaining).toBeNull();
      },
    );

    it(
      "retries deleteAgentFully() after a partial failure: row is preserved on " +
        "failure, then deleted on a healthy re-run",
      async () => {
        const order: string[] = [];
        const agentId = await createAgentWithSlackEnv("Retry Journey Agent");
        const recorded = emptyClient();
        const k8s = orderedK8s(order, recorded);
        const provisioner = new KubernetesAgentProvisioner(k8s, tokens, {
          ...CONFIG,
          taskStore: orderedTaskStore(order),
          chatService: orderedChatService(order),
        });

        await provisioner.provision(agentId);

        // First delete call: chat-service revoke fails. The step is recorded as
        // failed but every other step (k8s deprovision, task-store revoke, and
        // the Slack app delete) still runs — only the DB row delete is gated.
        const firstOrder = order; // continue accumulating into the same array
        const failingChatService = orderedChatService(firstOrder, {
          revokeError: new Error("chat-service unavailable"),
        });
        const firstDeleteDeps = makeDeleteDeps(firstOrder, provisioner, {
          chatService: failingChatService,
        });

        const firstResult = await deleteAgentFully(agentId, firstDeleteDeps, {
          xoxpToken: "xoxp-journey-token",
        });

        expect(firstResult.agentDeleted).toBe(false);
        expect(firstResult.failed).toEqual([
          {
            step: "chat-service-tokens-and-threads",
            error: "chat-service unavailable",
          },
        ]);
        expect(firstResult.completed).toContain("k8s");
        expect(firstResult.completed).toContain("task-store-tokens");
        expect(firstResult.completed).toContain("slack-app");
        expect(order).not.toContain("db:agent-delete");

        // Agent row still present in Postgres after the partial failure.
        const stillThere = await prisma.agent.findUnique({
          where: { id: agentId },
        });
        expect(stillThere).not.toBeNull();

        // Second call: healthy chat-service this time. Underlying steps are all
        // individually idempotent (k8s deprovision swallows 404, revoke on an
        // already-revoked token is a no-op, thread delete tolerates 404), so the
        // retry completes cleanly and the row is deleted last.
        const healthyChatService = orderedChatService(order);
        const secondDeleteDeps = makeDeleteDeps(order, provisioner, {
          chatService: healthyChatService,
        });

        const secondResult = await deleteAgentFully(
          agentId,
          secondDeleteDeps,
          { xoxpToken: "xoxp-journey-token" },
        );

        expect(secondResult.agentDeleted).toBe(true);
        expect(secondResult.failed).toEqual([]);
        expect(order[order.length - 1]).toBe("db:agent-delete");

        const gone = await prisma.agent.findUnique({ where: { id: agentId } });
        expect(gone).toBeNull();
      },
    );
  },
);

// ─── NoopAgentProvisioner (no DB required) ────────────────────────────────────

describe("NoopAgentProvisioner", () => {
  it("provision() returns derived names without touching any cluster", async () => {
    const provisioner = new NoopAgentProvisioner();
    const result = await provisioner.provision("agent_42");
    const name = sanitizeAgentName("agent_42");
    expect(result.resourceName).toBe(name);
    expect(result.secretName).toBe(`${name}-token`);
    expect(result.deploymentName).toBe(name);
    expect(result.rawToken).toBeUndefined();
  });

  it("deprovision() resolves to nothing", async () => {
    const provisioner = new NoopAgentProvisioner();
    await expect(provisioner.deprovision("agent_42")).resolves.toBeUndefined();
  });

  it("reconcile() returns empty arrays (no-op)", async () => {
    const provisioner = new NoopAgentProvisioner();
    const result = await provisioner.reconcile([
      { id: "agent_42" },
      { id: "agent_99" },
    ]);
    expect(result).toEqual({
      recreated: [],
      updated: [],
      orphans: [],
      failed: [],
    });
  });

  it("ConflictError remains importable for typed-error narrowing", () => {
    expect(new ConflictError().statusCode).toBe(409);
  });
});

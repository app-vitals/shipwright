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
  buildAgentSecretManifest,
  sanitizeAgentName,
} from "./agent-manifest.ts";
import {
  type KubernetesAgentProvisionerConfig,
  KubernetesAgentProvisioner,
  NoopAgentProvisioner,
} from "./agent-provisioner.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { ConflictError } from "./errors.ts";
import {
  type DeploymentSpec,
  type KubernetesClient,
  type KubernetesPvc,
  type KubernetesSecret,
  RecordedKubernetesClient,
  type PvcSpec,
  type SecretSpec,
} from "./kubernetes-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const NAMESPACE = "shipwright";

const CONFIG: KubernetesAgentProvisionerConfig = {
  namespace: NAMESPACE,
  image: "ghcr.io/app-vitals/shipwright-agent",
  imageTag: "v1.2.3",
  apiUrl: "http://shipwright-admin.shipwright.svc:3001",
  adminDeploymentName: "shipwright-admin",
  adminDeploymentUid: "11112222-3333-4444-5555-666677778888",
};

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

function emptyClient(): RecordedKubernetesClient {
  return new RecordedKubernetesClient({ deployments: {}, secrets: {}, pvcs: {} });
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
        order.push("deployment");
        return recorded.createDeployment(ns, spec);
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
    };
    const provisioner = new KubernetesAgentProvisioner(ordered, tokens, CONFIG);

    await provisioner.provision(agentId);
    expect(order).toEqual(["pvc", "secret", "deployment"]);
  });

  it("deprovision() deletes Deployment and Secret but leaves PVC", async () => {
    const agentId = await createAgent();
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    await provisioner.provision(agentId);
    await provisioner.deprovision(agentId);

    const name = sanitizeAgentName(agentId);
    // Deployment and Secret must be gone
    await expect(k8s.getDeployment(NAMESPACE, name)).rejects.toThrow();
    await expect(k8s.getSecret(NAMESPACE, `${name}-token`)).rejects.toThrow();
    // PVC must still be present (data safety)
    await expect(k8s.getPvc(NAMESPACE, `${name}-home`)).resolves.toBeDefined();
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
      getSecret: (ns, n) => recorded.getSecret(ns, n),
      getDeployment: (ns, n) => recorded.getDeployment(ns, n),
      getPvc: (ns, n) => recorded.getPvc(ns, n),
      deleteSecret: (ns, n) => recorded.deleteSecret(ns, n),
      deleteDeployment: (ns, n) => recorded.deleteDeployment(ns, n),
      deletePvc: (ns, n) => recorded.deletePvc(ns, n),
      deploymentExists: (ns, n) => recorded.deploymentExists(ns, n),
      listDeployments: (ns, sel) => recorded.listDeployments(ns, sel),
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
      adminDeploymentName: CONFIG.adminDeploymentName,
      adminDeploymentUid: CONFIG.adminDeploymentUid,
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
    expect(result).toEqual({ recreated: [], orphans: [], failed: [] });
  });

  it("reconcile() recreates a Deployment for a known agent missing from K8s", async () => {
    const agentId = await createAgent("ReconcileAgent");
    const k8s = emptyClient();
    const provisioner = new KubernetesAgentProvisioner(k8s, tokens, CONFIG);

    // Agent exists in DB, but no k8s Deployment provisioned yet.
    const result = await provisioner.reconcile([agentId]);

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
    const result = await provisioner.reconcile([agentId]);
    expect(result.recreated).toEqual([]);
    expect(result.orphans).toEqual([]);
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
});

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
    const result = await provisioner.reconcile(["agent_42", "agent_99"]);
    expect(result).toEqual({ recreated: [], orphans: [], failed: [] });
  });

  it("ConflictError remains importable for typed-error narrowing", () => {
    expect(new ConflictError().statusCode).toBe(409);
  });
});

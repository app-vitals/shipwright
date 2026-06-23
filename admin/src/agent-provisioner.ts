/**
 * admin/src/agent-provisioner.ts
 *
 * Provisions (and tears down) the Kubernetes resources backing a single
 * Shipwright agent. This module COMPOSES three lower-level pieces:
 *
 *   - AgentTokenService (./agent-tokens.ts) — mints the scoped per-agent token.
 *   - the pure manifest builders (./agent-manifest.ts) — shape the Secret +
 *     Deployment wire objects (RFC1123 name derivation, owner references, env).
 *   - a KubernetesClient (./kubernetes-client.ts) — performs the actual
 *     namespace-scoped create/get/delete API calls.
 *
 * Provisioning order is token → Secret → Deployment: the Deployment references
 * the Secret by name (`secretKeyRef`), so the Secret must exist first.
 *
 * Both operations are SAFE TO RETRY:
 *   - provision() treats an already-existing Secret/Deployment (ConflictError /
 *     409) as already-provisioned rather than failing, and if Deployment
 *     creation fails after the Secret was created it best-effort deletes the
 *     Secret so a retry starts from a clean slate.
 *   - deprovision() deletes the Deployment then the Secret and swallows
 *     NotFoundError (404) so tearing down an absent / half-absent agent is a
 *     no-op rather than an error.
 */

import {
  type AgentVoiceEnv,
  buildAgentDeploymentManifest,
  buildAgentSecretManifest,
  sanitizeAgentName,
} from "./agent-manifest.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import type {
  KubernetesClient,
  PvcSpec,
  SecretSpec,
} from "./kubernetes-client.ts";

// ─── Interface ──────────────────────────────────────────────────────────────

/** Outcome of a successful (or already-satisfied) provision. */
export interface ProvisionResult {
  /** RFC1123 Kubernetes object name shared by the Secret + Deployment. */
  resourceName: string;
  /** Name of the per-agent Secret carrying the token. */
  secretName: string;
  /** Name of the per-agent Deployment. */
  deploymentName: string;
  /**
   * The raw token minted for this provision, or `undefined` when the resources
   * already existed (ConflictError) and no new token was issued.
   */
  rawToken?: string;
}

/** Outcome of a reconcile pass. */
export interface ReconcileResult {
  /** Agent IDs whose Deployments were missing and have been re-provisioned. */
  recreated: string[];
  /** K8s Deployment names that exist but are not tied to any known agent ID. */
  orphans: string[];
  /**
   * Agent IDs whose re-provisioning failed with a transient or permanent error.
   * These are not counted in `recreated`. The caller should retry or alert on
   * non-empty `failed` arrays.
   */
  failed: Array<{ agentId: string; error: string }>;
}

export interface AgentProvisioner {
  /** Mint a token and create the agent's Secret + Deployment. Idempotent. */
  provision(
    agentId: string,
    opts?: { slug?: string },
  ): Promise<ProvisionResult>;
  /** Delete the agent's Deployment + Secret. Tolerates already-absent. */
  deprovision(agentId: string): Promise<void>;
  /**
   * Reconcile K8s Deployment state against a list of known agent IDs.
   * Re-provisions agents whose Deployments are missing; surfaces orphaned
   * Deployments that have no corresponding agent.
   */
  reconcile(
    agents: Array<{ id: string; slug?: string }>,
  ): Promise<ReconcileResult>;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface KubernetesAgentProvisionerConfig {
  /** Namespace the agent resources live in. */
  namespace: string;
  /** Agent container image (without tag). */
  image: string;
  /** Image tag, joined as `image:tag`. */
  imageTag: string;
  /** In-cluster admin/API base URL the agent calls home to. */
  apiUrl: string;
  /**
   * Build the PVC name for an agent from a single pre-resolved, RFC1123-safe
   * name string. When a slug is provided (via `provision(agentId, { slug })`),
   * `pvcNameFor` sanitizes it via `sanitizeAgentName` and passes the result as
   * the sole argument; otherwise the sanitized `resourceName` (derived from
   * `agentId`) is passed. Defaults to `<resourceName>-home`.
   */
  pvcName?: (resourceName: string) => string;
  /**
   * Build the Secret name from the sanitized resource name.
   * Defaults to `<name>-token`.
   */
  secretName?: (resourceName: string) => string;
  /** Key under which the token is stored in the Secret. Defaults to "token". */
  tokenSecretKey?: string;
  /** Replica count for the agent Deployment. Defaults to 1. */
  replicas?: number;
  /** Storage size in Gi for the agent home PVC. Defaults to 40. */
  pvcStorageGi?: number;
  /**
   * Optional agent-voice env flowed into provisioned agent pods. The admin reads
   * these from its OWN env (sourced from the chart's voice Secret + the in-cluster
   * Whisper Service URL). Omitted/empty → voice disabled (no voice env injected).
   */
  voice?: AgentVoiceEnv;
  /**
   * Container resource requests/limits for provisioned agent pods. When omitted,
   * the manifest builder applies GKE Autopilot-safe defaults (4Gi/8Gi
   * ephemeral-storage) to prevent eviction on clusters with strict local-storage caps.
   */
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
}

function isConflict(err: unknown): boolean {
  return err instanceof ConflictError;
}

function isNotFound(err: unknown): boolean {
  return err instanceof NotFoundError;
}

// ─── Kubernetes implementation ──────────────────────────────────────────────

export class KubernetesAgentProvisioner implements AgentProvisioner {
  private readonly tokenKey: string;

  constructor(
    private readonly k8s: KubernetesClient,
    private readonly tokens: AgentTokenService,
    private readonly config: KubernetesAgentProvisionerConfig,
  ) {
    this.tokenKey = config.tokenSecretKey ?? "token";
  }

  private resourceName(agentId: string): string {
    return sanitizeAgentName(agentId);
  }

  private secretNameFor(resourceName: string): string {
    return this.config.secretName
      ? this.config.secretName(resourceName)
      : `${resourceName}-token`;
  }

  private pvcNameFor(resourceName: string, slug?: string): string {
    return this.config.pvcName
      ? this.config.pvcName(slug ? sanitizeAgentName(slug) : resourceName)
      : `${resourceName}-home`;
  }

  async provision(
    agentId: string,
    opts?: { slug?: string },
  ): Promise<ProvisionResult> {
    const resourceName = this.resourceName(agentId);
    const secretName = this.secretNameFor(resourceName);
    const pvcName = this.pvcNameFor(resourceName, opts?.slug);
    const result: ProvisionResult = {
      resourceName,
      secretName,
      deploymentName: resourceName,
    };

    // 1. PVC — must exist before the Deployment that mounts it. A 409 means the
    //    PVC already exists from a prior provision; treat as idempotent success.
    //    On any subsequent failure, do NOT delete the PVC (data safety policy).
    try {
      await this.k8s.createPvc(this.config.namespace, this.pvcSpec(pvcName));
    } catch (err) {
      if (!isConflict(err)) throw err;
    }

    // 2. Token — mint only when the Secret does NOT already exist. If the Secret
    //    is already present (a prior provision completed or partially ran), we
    //    skip minting so no orphaned token rows accumulate in the DB and the
    //    returned rawToken correctly signals "use the existing credential" via
    //    undefined. Only mint a fresh token when we're about to write a new Secret.
    let secretCreated = false;
    let secretAlreadyExists = false;
    try {
      await this.k8s.getSecret(this.config.namespace, secretName);
      secretAlreadyExists = true;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    if (!secretAlreadyExists) {
      const { rawToken } = await this.tokens.create(agentId, "k8s-provision");
      result.rawToken = rawToken;

      // 3. Secret — must exist before the Deployment that references it.
      //    A 409 here is unexpected (we just confirmed it was absent), but treat
      //    it as already-present and continue to the Deployment step.
      try {
        await this.k8s.createSecret(
          this.config.namespace,
          this.secretSpec(secretName, rawToken),
        );
        secretCreated = true;
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }

    // 4. Deployment. If creation fails AFTER we created the Secret in THIS call,
    //    roll the Secret back (best-effort) so a retry starts clean and never
    //    leaks a half-provisioned state. The PVC is NOT rolled back (data safety).
    try {
      await this.k8s.createDeploymentManifest(
        this.config.namespace,
        buildAgentDeploymentManifest({
          agentId,
          namespace: this.config.namespace,
          image: this.config.image,
          imageTag: this.config.imageTag,
          apiUrl: this.config.apiUrl,
          pvcName: this.pvcNameFor(resourceName, opts?.slug),
          secretName,
          tokenSecretKey: this.tokenKey,
          replicas: this.config.replicas,
          voice: this.config.voice,
          resources: this.config.resources,
        }),
      );
    } catch (err) {
      if (isConflict(err)) {
        // Deployment already exists — idempotent success. But if we minted and
        // created a NEW Secret in THIS call, the pre-existing Deployment isn't
        // using it; roll the orphaned Secret (and its fresh token) back so we
        // never leak it. Only ever delete a Secret THIS call created.
        if (secretCreated) {
          await this.deleteSecretBestEffort(secretName);
        }
        return result;
      }
      if (secretCreated) {
        await this.deleteSecretBestEffort(secretName);
      }
      throw err;
    }

    return result;
  }

  async deprovision(agentId: string): Promise<void> {
    const resourceName = this.resourceName(agentId);
    const secretName = this.secretNameFor(resourceName);

    // Delete the Deployment first (it depends on the Secret), then the Secret.
    // Already-absent resources (404) are swallowed so teardown is idempotent.
    await this.deleteDeploymentBestEffort(resourceName);
    await this.deleteSecretBestEffort(secretName);
  }

  async reconcile(
    agents: Array<{ id: string; slug?: string }>,
  ): Promise<ReconcileResult> {
    const labelSelector =
      "app.kubernetes.io/name=shipwright-agent,app.kubernetes.io/managed-by=shipwright-admin";

    // List all agent Deployments currently in k8s.
    const k8sNames = await this.k8s.listDeployments(
      this.config.namespace,
      labelSelector,
    );
    const k8sNameSet = new Set(k8sNames);

    // Build a map from sanitized resource name → original agent entry, and track
    // the full set of expected k8s names.
    const expectedNames = new Map<string, { id: string; slug?: string }>(); // resourceName → agent
    for (const agent of agents) {
      expectedNames.set(this.resourceName(agent.id), agent);
    }

    const recreated: string[] = [];
    const orphans: string[] = [];
    const failed: Array<{ agentId: string; error: string }> = [];

    // Recreate Deployments that should exist but are missing in k8s.
    // Each provision() call is wrapped in try/catch so a single transient K8s
    // error does not abort the loop — the remaining agents are always checked.
    for (const [resourceName, agent] of expectedNames) {
      if (!k8sNameSet.has(resourceName)) {
        // provision() is idempotent — it handles ConflictError on Secret/Deployment.
        if (this.config.pvcName && !agent.slug) {
          // When a pvcName template is active, the PVC name is derived from the slug.
          // If slug is absent, reconcile falls back to resourceName — which may not
          // match the slug-based PVC created by the original provision() call, risking
          // a mount to an empty volume. Callers should populate slug in the agents array.
          console.warn(
            `[reconcile] pvcName template is set but agent ${agent.id} has no slug; PVC will be named from resourceName (${resourceName}) — verify this matches the PVC created at provision time`,
          );
        }
        try {
          await this.provision(agent.id, { slug: agent.slug });
          recreated.push(agent.id);
        } catch (err) {
          failed.push({
            agentId: agent.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Collect k8s Deployments that have no known agent.
    for (const k8sName of k8sNames) {
      if (!expectedNames.has(k8sName)) {
        orphans.push(k8sName);
      }
    }

    return { recreated, orphans, failed };
  }

  // ─── Spec derivation (via the pure manifest builders) ─────────────────────

  private pvcSpec(pvcName: string): PvcSpec {
    return {
      name: pvcName,
      namespace: this.config.namespace,
      storageGi: this.config.pvcStorageGi ?? 40,
    };
  }

  private secretSpec(secretName: string, rawToken: string): SecretSpec {
    // The pure builder is the single source of truth for the Secret body (name,
    // token key, base64 encoding). Derive the KubernetesClient SecretSpec from
    // its output so the builder actually drives the secret — decoding `data`
    // back to plain `stringData` since createSecret re-encodes it itself.
    const manifest = buildAgentSecretManifest({
      name: secretName,
      namespace: this.config.namespace,
      token: rawToken,
      tokenKey: this.tokenKey,
    });
    const stringData: Record<string, string> = {};
    for (const [key, value] of Object.entries(manifest.data)) {
      stringData[key] = Buffer.from(value, "base64").toString("utf-8");
    }
    return { name: manifest.metadata.name, stringData };
  }

  private async deleteSecretBestEffort(name: string): Promise<void> {
    try {
      await this.k8s.deleteSecret(this.config.namespace, name);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  private async deleteDeploymentBestEffort(name: string): Promise<void> {
    try {
      await this.k8s.deleteDeployment(this.config.namespace, name);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

// ─── No-op implementation ─────────────────────────────────────────────────────

/**
 * No-op provisioner used when Kubernetes provisioning is disabled. Lets the
 * admin service construct and run unchanged without a cluster.
 */
export class NoopAgentProvisioner implements AgentProvisioner {
  async provision(
    agentId: string,
    _opts?: { slug?: string },
  ): Promise<ProvisionResult> {
    const resourceName = sanitizeAgentName(agentId);
    return {
      resourceName,
      secretName: `${resourceName}-token`,
      deploymentName: resourceName,
    };
  }

  async deprovision(_agentId: string): Promise<void> {
    // intentionally a no-op
  }

  async reconcile(
    _agents: Array<{ id: string; slug?: string }>,
  ): Promise<ReconcileResult> {
    return { recreated: [], orphans: [], failed: [] };
  }
}

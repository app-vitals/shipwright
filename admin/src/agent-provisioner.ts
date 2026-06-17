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
  buildAgentDeploymentManifest,
  buildAgentSecretManifest,
  sanitizeAgentName,
} from "./agent-manifest.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import type {
  DeploymentSpec,
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

export interface AgentProvisioner {
  /** Mint a token and create the agent's Secret + Deployment. Idempotent. */
  provision(agentId: string): Promise<ProvisionResult>;
  /** Delete the agent's Deployment + Secret. Tolerates already-absent. */
  deprovision(agentId: string): Promise<void>;
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
  /** Admin Deployment name — ownerReference target for GC. */
  adminDeploymentName: string;
  /** Admin Deployment uid — ownerReference target for GC. */
  adminDeploymentUid: string;
  /**
   * Build the PVC name for an agent from its sanitized resource name.
   * Defaults to `<name>-home`.
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

  private pvcNameFor(resourceName: string): string {
    return this.config.pvcName
      ? this.config.pvcName(resourceName)
      : `${resourceName}-home`;
  }

  async provision(agentId: string): Promise<ProvisionResult> {
    const resourceName = this.resourceName(agentId);
    const secretName = this.secretNameFor(resourceName);
    const pvcName = this.pvcNameFor(resourceName);
    const result: ProvisionResult = {
      resourceName,
      secretName,
      deploymentName: resourceName,
    };

    // 1. PVC — must exist before the Deployment that mounts it. A 409 means the
    //    PVC already exists from a prior provision; treat as idempotent success.
    //    On any subsequent failure, do NOT delete the PVC (data safety policy).
    try {
      await this.k8s.createPvc(
        this.config.namespace,
        this.pvcSpec(pvcName),
      );
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
      await this.k8s.createDeployment(
        this.config.namespace,
        this.deploymentSpec(agentId, resourceName, secretName),
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
      adminDeploymentName: this.config.adminDeploymentName,
      adminDeploymentUid: this.config.adminDeploymentUid,
    });
    const stringData: Record<string, string> = {};
    for (const [key, value] of Object.entries(manifest.data)) {
      stringData[key] = Buffer.from(value, "base64").toString("utf-8");
    }
    return { name: manifest.metadata.name, stringData };
  }

  private deploymentSpec(
    agentId: string,
    resourceName: string,
    secretName: string,
  ): DeploymentSpec {
    const manifest = buildAgentDeploymentManifest({
      agentId,
      namespace: this.config.namespace,
      image: this.config.image,
      imageTag: this.config.imageTag,
      apiUrl: this.config.apiUrl,
      pvcName: this.pvcNameFor(resourceName),
      secretName,
      tokenSecretKey: this.tokenKey,
      adminDeploymentName: this.config.adminDeploymentName,
      adminDeploymentUid: this.config.adminDeploymentUid,
      replicas: this.config.replicas,
    });
    const container = manifest.spec.template.spec.containers[0];
    // Pull the env entries directly from the manifest so the Deployment spec
    // faithfully reflects what the pure builder produced — including the
    // SHIPWRIGHT_AGENT_API_KEY valueFrom/secretKeyRef entry that cannot be
    // expressed in the plain `env: Record<string, string>` map.
    return {
      name: resourceName,
      image: container.image,
      replicas: manifest.spec.replicas,
      labels: manifest.spec.selector.matchLabels,
      envVars: container.env,
    };
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
  async provision(agentId: string): Promise<ProvisionResult> {
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
}

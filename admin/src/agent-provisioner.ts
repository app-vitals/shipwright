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
  KubernetesContainer,
  KubernetesEnvVar,
  PvcSpec,
  SecretSpec,
} from "./kubernetes-client.ts";
import type { ChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import type { TaskStoreProvisioningClient } from "./task-store-provisioning-client.ts";

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
  /**
   * Agent IDs whose Deployments had drifted from the desired container spec
   * (image, env, or resources) and have been patched back to it.
   */
  updated: string[];
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
   * When set, the provisioner will mint a per-agent task-store token on
   * provision() and store it in the agent Secret under "task-store-token".
   * The Deployment manifest will include SHIPWRIGHT_TASK_STORE_TOKEN (from the
   * Secret) and SHIPWRIGHT_TASK_STORE_URL (from taskStoreUrl). On rollback,
   * the minted token is revoked via revokeToken().
   *
   * Omit to skip task-store wiring (for agents that don't need it or when
   * SHIPWRIGHT_TASK_STORE_URL / SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN are not set).
   */
  taskStore?: TaskStoreProvisioningClient;
  /**
   * In-cluster base URL of the task-store service. Injected into the agent
   * Deployment as SHIPWRIGHT_TASK_STORE_URL. Required when taskStore is set.
   */
  taskStoreUrl?: string;
  /**
   * When set, the provisioner will mint a per-agent chat-service token on
   * provision() and store it in the agent Secret under "chat-service-token".
   * The Deployment manifest will include SHIPWRIGHT_CHAT_SERVICE_TOKEN (from the
   * Secret) and SHIPWRIGHT_CHAT_SERVICE_URL (from chatServiceUrl). On rollback,
   * the minted token is revoked via revokeToken().
   *
   * Omit to skip chat-service wiring (for agents that don't need it or when
   * SHIPWRIGHT_CHAT_SERVICE_URL / SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN are not set).
   */
  chatService?: ChatServiceProvisioningClient;
  /**
   * In-cluster base URL of the chat service. Injected into the agent
   * Deployment as SHIPWRIGHT_CHAT_SERVICE_URL. Required when chatService is set.
   */
  chatServiceUrl?: string;
}

function envEntryEqual(a: KubernetesEnvVar, b: KubernetesEnvVar): boolean {
  return (
    a.value === b.value &&
    a.valueFrom?.secretKeyRef?.name === b.valueFrom?.secretKeyRef?.name &&
    a.valueFrom?.secretKeyRef?.key === b.valueFrom?.secretKeyRef?.key
  );
}

/**
 * True when the live container is missing anything the desired container
 * specifies (image, env entries, resource values).
 *
 * Subset semantics: extra live env vars (added manually via kubectl) and extra
 * resource keys (injected by cluster autoscalers like GKE Autopilot) are NOT
 * drift — reconcile must not fight other actors. Only a desired value that is
 * absent or different counts.
 */
export function containerDrifted(
  current: KubernetesContainer,
  desired: KubernetesContainer,
): boolean {
  if (current.image !== desired.image) return true;

  const currentEnv = new Map((current.env ?? []).map((e) => [e.name, e]));
  for (const entry of desired.env ?? []) {
    const live = currentEnv.get(entry.name);
    if (!live || !envEntryEqual(live, entry)) return true;
  }

  const cur = current.resources ?? {};
  for (const bucket of ["requests", "limits"] as const) {
    for (const [key, value] of Object.entries(
      desired.resources?.[bucket] ?? {},
    )) {
      if (cur[bucket]?.[key] !== value) return true;
    }
  }

  return false;
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

  /**
   * The desired Deployment manifest for an agent — the single source of truth
   * used both to create (provision) and to drift-correct (reconcile).
   */
  private deploymentManifestFor(agentId: string, slug?: string) {
    const resourceName = this.resourceName(agentId);
    return buildAgentDeploymentManifest({
      agentId,
      namespace: this.config.namespace,
      image: this.config.image,
      imageTag: this.config.imageTag,
      apiUrl: this.config.apiUrl,
      pvcName: this.pvcNameFor(resourceName, slug),
      secretName: this.secretNameFor(resourceName),
      tokenSecretKey: this.tokenKey,
      replicas: this.config.replicas,
      voice: this.config.voice,
      taskStoreUrl: this.config.taskStoreUrl,
      chatServiceUrl: this.config.chatServiceUrl,
    });
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

    // Track the task-store and chat-service tokens minted in THIS call so we
    // can revoke them on rollback. Only set when the respective config is provided
    // and we actually minted.
    let tsTokenId: string | undefined;
    let csTokenId: string | undefined;

    if (!secretAlreadyExists) {
      // Optionally mint a task-store token to co-locate in the same Secret write.
      let tsRawToken: string | undefined;
      if (this.config.taskStore) {
        const { id, rawToken } = await this.config.taskStore.mintToken(
          `agent:${agentId}`,
          agentId,
        );
        tsTokenId = id;
        tsRawToken = rawToken;
      }

      // Optionally mint a chat-service token to co-locate in the same Secret write.
      let csRawToken: string | undefined;
      if (this.config.chatService) {
        const { id, rawToken } = await this.config.chatService.mintToken(
          `agent:${agentId}`,
          agentId,
        );
        csTokenId = id;
        csRawToken = rawToken;
      }

      const { rawToken } = await this.tokens.create(agentId, "k8s-provision");
      result.rawToken = rawToken;

      // 3. Secret — must exist before the Deployment that references it.
      //    A 409 here is unexpected (we just confirmed it was absent), but treat
      //    it as already-present and continue to the Deployment step.
      try {
        await this.k8s.createSecret(
          this.config.namespace,
          this.secretSpec(secretName, rawToken, tsRawToken, csRawToken),
        );
        secretCreated = true;
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }

    // 4. Deployment. If creation fails AFTER we created the Secret in THIS call,
    //    roll the Secret back (best-effort) so a retry starts clean and never
    //    leaks a half-provisioned state. The PVC is NOT rolled back (data safety).
    //    Also revoke any task-store and chat-service tokens minted in THIS call.
    try {
      await this.k8s.createDeploymentManifest(
        this.config.namespace,
        this.deploymentManifestFor(agentId, opts?.slug),
      );
    } catch (err) {
      if (isConflict(err)) {
        // Deployment already exists — idempotent success. But if we minted and
        // created a NEW Secret in THIS call, the pre-existing Deployment isn't
        // using it; roll the orphaned Secret (and its fresh tokens) back so we
        // never leak it. Only ever delete a Secret THIS call created.
        if (secretCreated) {
          await this.deleteSecretBestEffort(secretName);
          await this.revokeTaskStoreTokenBestEffort(tsTokenId);
          await this.revokeChatServiceTokenBestEffort(csTokenId);
        }
        return result;
      }
      if (secretCreated) {
        await this.deleteSecretBestEffort(secretName);
        await this.revokeTaskStoreTokenBestEffort(tsTokenId);
        await this.revokeChatServiceTokenBestEffort(csTokenId);
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
    const updated: string[] = [];
    const orphans: string[] = [];
    const failed: Array<{ agentId: string; error: string }> = [];

    // Recreate Deployments that should exist but are missing in k8s.
    // For Deployments that already exist, check whether the image is stale and
    // patch it if so. Each operation is wrapped in try/catch so a single transient
    // K8s error does not abort the loop — the remaining agents are always checked.
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
      } else {
        // Deployment already exists — re-apply the desired container spec when
        // it has drifted. The manifest builder is the single source of truth
        // for image, env, and resources; the strategic-merge patch upserts env
        // entries by name, so manually-added extra vars survive. (Patching only
        // the image here would mean existing Deployments never pick up env or
        // resource changes shipped in a new admin version.)
        try {
          const deployment = await this.k8s.getDeployment(
            this.config.namespace,
            resourceName,
          );
          const current = deployment.spec.template.spec.containers[0];
          const desired = this.deploymentManifestFor(agent.id, agent.slug).spec
            .template.spec.containers[0];
          if (current && desired && containerDrifted(current, desired)) {
            await this.k8s.patchDeployment(
              this.config.namespace,
              resourceName,
              {
                spec: {
                  template: {
                    spec: {
                      containers: [
                        {
                          name: desired.name,
                          image: desired.image,
                          env: desired.env,
                          resources: desired.resources,
                        },
                      ],
                    },
                  },
                },
              },
            );
            updated.push(agent.id);
          }
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

    return { recreated, updated, orphans, failed };
  }

  // ─── Spec derivation (via the pure manifest builders) ─────────────────────

  private pvcSpec(pvcName: string): PvcSpec {
    return {
      name: pvcName,
      namespace: this.config.namespace,
      storageGi: this.config.pvcStorageGi ?? 40,
    };
  }

  private secretSpec(
    secretName: string,
    rawToken: string,
    taskStoreToken?: string,
    chatServiceToken?: string,
  ): SecretSpec {
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
    // When a task-store token was minted for this agent, include it in the same
    // Secret so a single Secret holds all per-agent credentials.
    if (taskStoreToken !== undefined) {
      stringData["task-store-token"] = taskStoreToken;
    }
    // When a chat-service token was minted for this agent, include it alongside
    // the other per-agent credentials in the same Secret.
    if (chatServiceToken !== undefined) {
      stringData["chat-service-token"] = chatServiceToken;
    }
    return { name: manifest.metadata.name, stringData };
  }

  private async revokeTaskStoreTokenBestEffort(
    tsTokenId: string | undefined,
  ): Promise<void> {
    if (!tsTokenId || !this.config.taskStore) return;
    try {
      await this.config.taskStore.revokeToken(tsTokenId);
    } catch {
      // Best-effort — log but don't propagate so the original error surfaces.
      console.warn(
        `[provisioner] failed to revoke task-store token ${tsTokenId} during rollback`,
      );
    }
  }

  private async revokeChatServiceTokenBestEffort(
    csTokenId: string | undefined,
  ): Promise<void> {
    if (!csTokenId || !this.config.chatService) return;
    try {
      await this.config.chatService.revokeToken(csTokenId);
    } catch {
      // Best-effort — log but don't propagate so the original error surfaces.
      console.warn(
        `[provisioner] failed to revoke chat-service token ${csTokenId} during rollback`,
      );
    }
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
    return { recreated: [], updated: [], orphans: [], failed: [] };
  }
}

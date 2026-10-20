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
 * In perAgent identity mode (config.perAgentIdentity) each agent also gets its
 * own Anthropic identity, created between the PVC and the Secret: Kubernetes
 * ServiceAccount (named like the Deployment) → Anthropic service account
 * (added to the workspace) → federation rule trusting exactly that
 * ServiceAccount's token subject. Each ID is saved on the Agent row as soon as
 * it exists; a retry reuses saved IDs, and find-by-name is only used when a
 * create conflicts because an earlier ID write was lost.
 *
 * Both operations are SAFE TO RETRY:
 *   - provision() treats an already-existing Secret/Deployment (ConflictError /
 *     409) as already-provisioned rather than failing, and if Deployment
 *     creation fails after the Secret was created it best-effort deletes the
 *     Secret so a retry starts from a clean slate. In perAgent mode any later
 *     failure also undoes, in reverse, the identity pieces THIS call created
 *     (rule, Anthropic service account, ServiceAccount) and clears their IDs.
 *   - deprovision() deletes the Deployment, then the Secret, then the PVC
 *     (unlike provision()'s rollback path, a deliberate full deprovision DOES
 *     remove the PVC) and swallows NotFoundError (404) so tearing down an
 *     absent / half-absent agent is a no-op rather than an error.
 *   - removeAnthropicIdentity() (perAgent mode, called by agent deletion after
 *     deprovision()) archives the federation rule, then the Anthropic service
 *     account, then deletes the ServiceAccount — strictly in that order,
 *     throwing at the first failure (Anthropic refuses to archive a service
 *     account a live rule references) and clearing each saved ID as its piece
 *     goes, so a retry only redoes what is left.
 */

import type {
  AgentAnthropicIdentity,
  AgentAnthropicIdentityService,
} from "./agent-anthropic-identity.ts";
import {
  type AgentAnthropicFederation,
  type AgentContainerResourceOverrides,
  type AgentVoiceEnv,
  ANTHROPIC_FEDERATION_ENV_NAMES,
  ANTHROPIC_TOKEN_MOUNT_PATH,
  ANTHROPIC_TOKEN_VOLUME,
  buildAgentDeploymentManifest,
  buildAgentSecretManifest,
  CLAUDE_POLICY_HASH_ANNOTATION,
  CLAUDE_POLICY_MOUNT_PATH,
  CLAUDE_POLICY_VOLUME,
  sanitizeAgentName,
  TENANT_LABEL,
} from "./agent-manifest.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import {
  AnthropicApiError,
  AnthropicConflictError,
  type AnthropicIdentityClient,
} from "./anthropic-identity-client.ts";
import type { AnthropicIdentityNameAllocator } from "./anthropic-identity-name.ts";
import type { ChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import {
  ConflictError,
  NotFoundError,
  UnprocessableEntityError,
} from "./errors.ts";
import type {
  KubernetesClient,
  KubernetesContainer,
  KubernetesDeployment,
  KubernetesEnvVar,
  PvcSpec,
  SecretSpec,
} from "./kubernetes-client.ts";
import {
  provisionableIntegrations,
  type ServiceIntegration,
} from "./service-integration.ts";

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
   * (image, env, resources), Claude policy wiring or Anthropic federation
   * wiring and have been patched back to it. In a dry run: the ones that
   * would be.
   */
  updated: string[];
  /**
   * perAgent mode: agent IDs moved off the shared ServiceAccount onto their own
   * newly created identity (also listed in `updated`, as their Deployment was
   * patched). In a dry run: the ones that would be. Always empty in shared mode
   * and under `policyOnly`.
   */
  migrated: string[];
  /**
   * perAgent mode: agent IDs skipped because they have no owner to name their
   * identity after. Their federation wiring is left as it is, and a missing
   * Deployment is not created. Not counted in `failed`.
   */
  noOwner: string[];
  /** True when the pass only reported: nothing was created, patched or saved. */
  dryRun: boolean;
}

/**
 * An agent as reconcile sees it. The identity fields (the Agent row's owner and
 * per-agent identity IDs) are optional: a target that carries them (`ownerEmail`
 * defined, null when unset) is used as read; a bare `{ id }` target makes
 * reconcile read them from the identity store itself.
 */
export interface ReconcileTarget extends Partial<AgentAnthropicIdentity> {
  id: string;
  slug?: string;
  accountId?: string | null;
}

export interface AgentProvisioner {
  /**
   * Whether this provisioner actually creates cluster resources. `false` on the
   * no-op implementation (Kubernetes provisioning disabled), where provision()
   * returns plausible names without touching a cluster. Callers that offer an
   * "in-cluster" runtime choice must check this first — otherwise an operator
   * picks it, provision() silently succeeds, and they get an agent row with no
   * pod behind it.
   */
  readonly canProvision: boolean;
  /** Mint a token and create the agent's Secret + Deployment. Idempotent. */
  provision(
    agentId: string,
    opts?: { slug?: string; accountId?: string | null },
  ): Promise<ProvisionResult>;
  /**
   * Delete the agent's Deployment, Secret, and PVC. Tolerates already-absent
   * resources (idempotent). `opts.slug` mirrors provision()'s shape and is
   * used to resolve the PVC name when a `pvcName` template is configured.
   */
  deprovision(agentId: string, opts?: { slug?: string }): Promise<void>;
  /**
   * Remove the agent's per-agent Anthropic identity: archive the federation
   * rule, then the Anthropic service account, then delete the Kubernetes
   * ServiceAccount, clearing each saved ID as soon as its piece is gone.
   * Strictly in that order and stopping at the first failure (it throws):
   * Anthropic refuses to archive a service account while a live rule
   * references it. Already-absent pieces count as removed, so a retry only
   * redoes what is left. Optional: provisioners without per-agent identities
   * (the no-op one, test doubles) need not implement it.
   */
  removeAnthropicIdentity?(agentId: string): Promise<void>;
  /**
   * Reconcile K8s Deployment state against a list of known agent IDs.
   * Re-provisions agents whose Deployments are missing; surfaces orphaned
   * Deployments that have no corresponding agent.
   *
   * `opts.policyOnly` restricts drift correction of existing Deployments to the
   * Claude policy wiring (volume, mount, hash annotation) and the Anthropic
   * federation wiring (ServiceAccount, token volume, mount, federation env
   * entries); image, other env and resource drift is left untouched. Missing
   * Deployments are still recreated.
   *
   * In perAgent identity mode a full pass (not `policyOnly`) also moves each
   * existing agent that has an owner but no identity of its own onto a new one:
   * it creates the identity and patches the Deployment off the shared
   * ServiceAccount. The startup pass is `policyOnly` and so never creates
   * Anthropic resources on a boot; an operator runs the full pass (first with
   * `dryRun`) through POST /agents/reconcile. Agents without an owner are
   * reported in `noOwner` and left alone.
   *
   * `opts.dryRun` makes the pass report only: nothing is created in Anthropic or
   * Kubernetes, nothing is saved and no Deployment is patched; the result lists
   * what would be recreated, updated and migrated.
   */
  reconcile(
    agents: ReconcileTarget[],
    opts?: { policyOnly?: boolean; dryRun?: boolean },
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
   * Optional container resource overrides (cpuRequest, memoryRequest,
   * memoryLimit, ephemeralStorage), merged field-by-field over the defaults in
   * `resolveAgentContainerResources` (agent-manifest.ts). Sourced from the
   * SHIPWRIGHT_K8S_AGENT_* env vars in main.ts's buildProvisioner. Omit (or
   * leave individual fields unset) to keep today's defaults for those fields.
   */
  resources?: AgentContainerResourceOverrides;
  /**
   * Optional agent-voice env flowed into provisioned agent pods. The admin reads
   * these from its OWN env (sourced from the chart's voice Secret + the in-cluster
   * Whisper Service URL). Omitted/empty → voice disabled (no voice env injected).
   */
  voice?: AgentVoiceEnv;
  /**
   * Optional service integrations (see service-integration.ts), supplied by the
   * composition root (e.g. task-store, registered by the coding extension).
   * For each integration with a `url`, provision() mints a per-agent token
   * (in list order, before the built-in chat-service token), stores it in the
   * agent Secret under the integration's `secretKey`, and the Deployment
   * manifest injects its token/URL env. On rollback each minted token is
   * revoked via revokeToken(). Integrations without a `url` are skipped.
   */
  serviceIntegrations?: readonly ServiceIntegration[];
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
  /**
   * Claude Code managed-policy ConfigMap to mount into provisioned agent pods
   * (see AgentDeploymentOpts.claudePolicy). Sourced from
   * SHIPWRIGHT_K8S_AGENT_CLAUDE_POLICY_CONFIGMAP / _HASH in main.ts. Omit to
   * leave the manifest unchanged.
   */
  claudePolicy?: { configMapName: string; hash?: string };
  /**
   * Anthropic Workload Identity Federation wiring for provisioned agent pods
   * (see AgentDeploymentOpts.anthropicFederation). Sourced from
   * SHIPWRIGHT_K8S_AGENT_SERVICE_ACCOUNT and
   * SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_* in main.ts. Omit to leave the
   * manifest unchanged.
   */
  anthropicFederation?: AgentAnthropicFederation;
  /**
   * perAgent identity mode: give every agent its own Kubernetes ServiceAccount,
   * Anthropic service account and federation rule at provision time, and build
   * its Deployment from those IDs. Wired in main.ts's buildProvisioner when
   * SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_IDENTITY_MODE=perAgent; mutually
   * exclusive with `anthropicFederation` (shared mode).
   */
  perAgentIdentity?: PerAgentIdentityConfig;
}

// ─── perAgent identity ──────────────────────────────────────────────────────

/** Read/save of an agent's owner and identity IDs (AgentAnthropicIdentityService). */
export type AgentIdentityStore = Pick<
  AgentAnthropicIdentityService,
  "get" | "set"
>;

/** Idempotent identity-name allocation (AnthropicIdentityNameAllocator). */
export type AgentIdentityNameSource = Pick<
  AnthropicIdentityNameAllocator,
  "allocate"
>;

export interface PerAgentIdentityConfig {
  /** Anthropic Admin API client (the admin pod's own federated sign-in). */
  client: AnthropicIdentityClient;
  identities: AgentIdentityStore;
  names: AgentIdentityNameSource;
  /** → ANTHROPIC_ORGANIZATION_ID */
  organizationId: string;
  /**
   * Workspace each service account is added to and each rule is scoped to
   * (→ ANTHROPIC_WORKSPACE_ID). Unset: no workspace step, and the rule and pod
   * carry no workspace.
   */
  workspaceId?: string;
  /** This cluster's Anthropic federation issuer (the rules' issuer). */
  issuerId: string;
  /** Audience of the agent pods' projected token (also matched by the rule). */
  audience: string;
  /** Lifetime of the agent pods' projected token. */
  expirationSeconds: number;
}

/** OAuth scope of every per-agent federation rule. */
export const PER_AGENT_RULE_SCOPE = "workspace:inference";
/** Lifetime of the Anthropic access tokens a per-agent rule mints. */
export const PER_AGENT_RULE_TOKEN_LIFETIME_SECONDS = 600;

/** The token subject Kubernetes stamps on a pod's projected ServiceAccount token. */
export function serviceAccountSubject(
  namespace: string,
  serviceAccountName: string,
): string {
  return `system:serviceaccount:${namespace}:${serviceAccountName}`;
}

/** True when the agent has an owner and every per-agent identity ID saved. */
export function hasPerAgentIdentity(
  identity: AgentAnthropicIdentity | null,
): boolean {
  return Boolean(
    identity?.ownerEmail &&
      identity.k8sServiceAccountName &&
      identity.anthropicServiceAccountId &&
      identity.anthropicFederationRuleId,
  );
}

/**
 * The Deployment federation wiring for an agent's OWN identity.
 * @throws NotFoundError when the agent row is missing
 * @throws UnprocessableEntityError when the agent has no owner, or an ID is
 *   not provisioned yet
 */
export function perAgentFederation(
  config: Pick<
    PerAgentIdentityConfig,
    "organizationId" | "workspaceId" | "audience" | "expirationSeconds"
  >,
  agentId: string,
  identity: AgentAnthropicIdentity | null,
): AgentAnthropicFederation {
  const ids = requireOwner(agentId, identity);
  const {
    k8sServiceAccountName,
    anthropicServiceAccountId,
    anthropicFederationRuleId,
  } = ids;
  if (
    !k8sServiceAccountName ||
    !anthropicServiceAccountId ||
    !anthropicFederationRuleId
  ) {
    const missing = (
      [
        "k8sServiceAccountName",
        "anthropicServiceAccountId",
        "anthropicFederationRuleId",
      ] as const
    ).filter((key) => !ids[key]);
    throw new UnprocessableEntityError(
      `Agent ${agentId} has no per-agent Anthropic identity yet (missing ${missing.join(", ")}); provision it first`,
    );
  }
  return {
    serviceAccountName: k8sServiceAccountName,
    ruleId: anthropicFederationRuleId,
    organizationId: config.organizationId,
    serviceAccountId: anthropicServiceAccountId,
    ...(config.workspaceId ? { workspaceId: config.workspaceId } : {}),
    audience: config.audience,
    expirationSeconds: config.expirationSeconds,
  };
}

function requireOwner(
  agentId: string,
  identity: AgentAnthropicIdentity | null,
): AgentAnthropicIdentity & { ownerEmail: string } {
  if (!identity) throw new NotFoundError(`Agent ${agentId} not found`);
  const { ownerEmail } = identity;
  if (!ownerEmail) {
    throw new UnprocessableEntityError(
      `Agent ${agentId} has no owner; perAgent identity mode needs an owner email to name the agent's Anthropic identity`,
    );
  }
  return { ...identity, ownerEmail };
}

/** Identity pieces created by THIS provision() call — the rollback set. */
interface CreatedIdentity {
  k8sServiceAccount?: string;
  serviceAccountId?: string;
  ruleId?: string;
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

type PolicyVolume = NonNullable<
  KubernetesDeployment["spec"]["template"]["spec"]["volumes"]
>[number];
type PolicyMount = NonNullable<KubernetesContainer["volumeMounts"]>[number];

/** The policy-relevant slice of a Deployment; parts are undefined when absent. */
function policyParts(dep: KubernetesDeployment): {
  volume?: PolicyVolume;
  mount?: PolicyMount;
  hash?: string;
} {
  return {
    volume: dep.spec.template.spec.volumes?.find(
      (v) => v.name === CLAUDE_POLICY_VOLUME,
    ),
    // Keyed by mountPath, the strategic-merge key the patch operates on, so a
    // stray same-named mount elsewhere can't make every pass look drifted.
    mount: dep.spec.template.spec.containers[0]?.volumeMounts?.find(
      (m) => m.mountPath === CLAUDE_POLICY_MOUNT_PATH,
    ),
    hash: dep.spec.template.metadata?.annotations?.[
      CLAUDE_POLICY_HASH_ANNOTATION
    ],
  };
}

/**
 * Strategic-merge fragments that bring the live Claude policy wiring (pod-level
 * volume, container mount, hash annotation) to the desired state. A field is
 * omitted when that part is already in sync.
 *
 * Removal needs explicit directives: strategic merge keys volumes by `name` and
 * volumeMounts by `mountPath`, so omitting an entry would leave it in place.
 * `$patch: delete` removes it, and a null annotation value deletes the key.
 */
interface PolicyPatch {
  volumes?: object[];
  volumeMounts?: object[];
  annotations?: Record<string, string | null>;
}

/** The policy patch for a live Deployment, or undefined when already in sync. */
function policyPatch(
  live: KubernetesDeployment,
  desired: KubernetesDeployment,
): PolicyPatch | undefined {
  const cur = policyParts(live);
  const want = policyParts(desired);
  const patch: PolicyPatch = {};

  if (want.volume) {
    if (cur.volume?.configMap?.name !== want.volume.configMap?.name) {
      patch.volumes = [want.volume];
    }
  } else if (cur.volume) {
    patch.volumes = [{ name: CLAUDE_POLICY_VOLUME, $patch: "delete" }];
  }

  if (want.mount) {
    if (
      cur.mount?.name !== want.mount.name ||
      cur.mount.readOnly !== want.mount.readOnly
    ) {
      patch.volumeMounts = [want.mount];
    }
  } else if (cur.mount) {
    patch.volumeMounts = [{ mountPath: cur.mount.mountPath, $patch: "delete" }];
  }

  if (cur.hash !== want.hash) {
    patch.annotations = { [CLAUDE_POLICY_HASH_ANNOTATION]: want.hash ?? null };
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * True when the live Deployment's Claude policy wiring differs from the desired
 * one: a missing, extra or differently-pointed volume, a missing or extra
 * mount, or a differing hash annotation. Covers "policy disabled but still
 * present" too.
 */
export function policyDrifted(
  live: KubernetesDeployment,
  desired: KubernetesDeployment,
): boolean {
  return policyPatch(live, desired) !== undefined;
}

/** The federation-relevant slice of a Deployment; parts are undefined when absent. */
function federationParts(dep: KubernetesDeployment): {
  serviceAccountName?: string;
  volume?: PolicyVolume;
  mount?: PolicyMount;
  env: Map<string, KubernetesEnvVar>;
} {
  const podSpec = dep.spec.template.spec;
  const container = podSpec.containers[0];
  const names = new Set<string>(ANTHROPIC_FEDERATION_ENV_NAMES);
  return {
    serviceAccountName:
      typeof podSpec.serviceAccountName === "string"
        ? podSpec.serviceAccountName
        : undefined,
    volume: podSpec.volumes?.find((v) => v.name === ANTHROPIC_TOKEN_VOLUME),
    mount: container?.volumeMounts?.find(
      (m) => m.mountPath === ANTHROPIC_TOKEN_MOUNT_PATH,
    ),
    env: new Map(
      (container?.env ?? [])
        .filter((e) => names.has(e.name))
        .map((e) => [e.name, e]),
    ),
  };
}

interface TokenSource {
  audience?: string;
  expirationSeconds?: number;
  path?: string;
}

/**
 * True when two projected token volumes request the same token. Compares only
 * the fields the builder sets, so server-defaulted fields (projected
 * defaultMode) on the live volume are not drift.
 */
function tokenSourceEqual(a: PolicyVolume, b: PolicyVolume): boolean {
  const src = (v: PolicyVolume): TokenSource | undefined =>
    (v.projected as { sources?: Array<{ serviceAccountToken?: TokenSource }> })
      ?.sources?.[0]?.serviceAccountToken;
  const x = src(a);
  const y = src(b);
  return (
    x?.audience === y?.audience &&
    x?.expirationSeconds === y?.expirationSeconds &&
    x?.path === y?.path
  );
}

/**
 * Strategic-merge fragments that bring the live federation wiring (pod
 * ServiceAccount, projected token volume, container mount, federation env) to
 * the desired state. A field is omitted when that part is already in sync.
 *
 * Removal uses explicit directives like policyPatch: `$patch: delete` on the
 * volume (by name), mount (by mountPath) and each env entry (by name), and a
 * null serviceAccountName. The deprecated `serviceAccount` alias is nulled too:
 * the API server mirrors serviceAccountName into it and falls back to it when
 * serviceAccountName is empty, so leaving it would resurrect the old name.
 */
interface FederationPatch {
  serviceAccountName?: string | null;
  serviceAccount?: null;
  volumes?: object[];
  volumeMounts?: object[];
  env?: object[];
}

/** The federation patch for a live Deployment, or undefined when already in sync. */
export function federationPatch(
  live: KubernetesDeployment,
  desired: KubernetesDeployment,
): FederationPatch | undefined {
  const cur = federationParts(live);
  const want = federationParts(desired);
  const patch: FederationPatch = {};

  if (want.serviceAccountName) {
    if (cur.serviceAccountName !== want.serviceAccountName) {
      patch.serviceAccountName = want.serviceAccountName;
    }
  } else if (cur.serviceAccountName && (cur.volume || cur.env.size > 0)) {
    // Only unset a ServiceAccount that came with federation wiring; one set on
    // the Deployment by another actor is left alone.
    patch.serviceAccountName = null;
    patch.serviceAccount = null;
  }

  if (want.volume) {
    if (!cur.volume || !tokenSourceEqual(cur.volume, want.volume)) {
      patch.volumes = [want.volume];
    }
  } else if (cur.volume) {
    patch.volumes = [{ name: ANTHROPIC_TOKEN_VOLUME, $patch: "delete" }];
  }

  if (want.mount) {
    if (
      cur.mount?.name !== want.mount.name ||
      cur.mount.readOnly !== want.mount.readOnly
    ) {
      patch.volumeMounts = [want.mount];
    }
  } else if (cur.mount) {
    patch.volumeMounts = [{ mountPath: cur.mount.mountPath, $patch: "delete" }];
  }

  const env: object[] = [];
  for (const name of ANTHROPIC_FEDERATION_ENV_NAMES) {
    const wantEntry = want.env.get(name);
    const curEntry = cur.env.get(name);
    if (wantEntry) {
      if (!curEntry || !envEntryEqual(curEntry, wantEntry)) env.push(wantEntry);
    } else if (curEntry) {
      env.push({ name, $patch: "delete" });
    }
  }
  if (env.length > 0) patch.env = env;

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function isConflict(err: unknown): boolean {
  return err instanceof ConflictError;
}

function isNotFound(err: unknown): boolean {
  return err instanceof NotFoundError;
}

/** An Anthropic archive that 404s means the resource is already gone. */
function isAnthropicNotFound(err: unknown): boolean {
  return err instanceof AnthropicApiError && err.status === 404;
}

/**
 * Create an Anthropic resource and return its ID (reporting it via
 * `onCreated`). A name conflict means an earlier call created it but its ID
 * write was lost: recover the live resource by name. If nothing by that name
 * is live, the conflict is rethrown.
 */
async function createOrRecover(
  create: () => Promise<{ id: string }>,
  findByName: () => Promise<{ id: string } | null>,
  onCreated: (id: string) => void,
): Promise<string> {
  try {
    const { id } = await create();
    onCreated(id);
    return id;
  } catch (err) {
    if (!(err instanceof AnthropicConflictError)) throw err;
    const found = await findByName();
    if (!found) throw err;
    return found.id;
  }
}

async function tolerateAnthropicNotFound(
  step: () => Promise<unknown>,
): Promise<void> {
  try {
    await step();
  } catch (err) {
    if (!isAnthropicNotFound(err)) throw err;
  }
}

/** Run a rollback step; log (never throw) on failure so the original error surfaces. */
async function bestEffort(
  what: string,
  step: () => Promise<unknown>,
): Promise<void> {
  try {
    await step();
  } catch (err) {
    console.warn(
      `[provisioner] rollback: failed to ${what}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Kubernetes implementation ──────────────────────────────────────────────

export class KubernetesAgentProvisioner implements AgentProvisioner {
  readonly canProvision = true;

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
   * The agent's owner and identity IDs for reconcile: the target's own fields
   * when it carries them, else the identity store's row (null: no such agent).
   */
  private async identityOf(
    agent: ReconcileTarget,
  ): Promise<AgentAnthropicIdentity | null> {
    if (agent.ownerEmail !== undefined) {
      return {
        ownerEmail: agent.ownerEmail,
        anthropicIdentityName: agent.anthropicIdentityName ?? null,
        anthropicServiceAccountId: agent.anthropicServiceAccountId ?? null,
        anthropicFederationRuleId: agent.anthropicFederationRuleId ?? null,
        k8sServiceAccountName: agent.k8sServiceAccountName ?? null,
      };
    }
    const perAgent = this.config.perAgentIdentity;
    return perAgent ? perAgent.identities.get(agent.id) : null;
  }

  /**
   * The federation wiring reconcile drift-corrects an existing Deployment to.
   * `manage: false` means leave the live federation wiring as it is: in
   * perAgent mode an agent without its own identity keeps whatever it runs with
   * until it is migrated (`move` set: it has an owner, so a full pass can
   * create the identity) or for good (`noOwner` set: it has none).
   */
  private async reconcileFederationFor(agent: ReconcileTarget): Promise<{
    federation?: AgentAnthropicFederation;
    manage: boolean;
    move?: AgentAnthropicIdentity & { ownerEmail: string };
    noOwner?: boolean;
  }> {
    const perAgent = this.config.perAgentIdentity;
    if (!perAgent) {
      return { federation: this.config.anthropicFederation, manage: true };
    }
    const identity = await this.identityOf(agent);
    if (!identity) return { manage: false };
    if (hasPerAgentIdentity(identity)) {
      return {
        federation: perAgentFederation(perAgent, agent.id, identity),
        manage: true,
      };
    }
    const { ownerEmail } = identity;
    return ownerEmail
      ? { manage: false, move: { ...identity, ownerEmail } }
      : { manage: false, noOwner: true };
  }

  /**
   * The desired Deployment manifest for an agent — the single source of truth
   * used both to create (provision) and to drift-correct (reconcile).
   * `federation` is the agent's resolved wiring: the shared identity, its own
   * per-agent identity (provision / reconcileFederationFor), or none.
   */
  private deploymentManifestFor(
    agentId: string,
    slug: string | undefined,
    accountId: string | null | undefined,
    federation: AgentAnthropicFederation | undefined,
  ) {
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
      resources: this.config.resources,
      voice: this.config.voice,
      serviceIntegrations: provisionableIntegrations(
        this.config.serviceIntegrations,
      ),
      chatServiceUrl: this.config.chatServiceUrl,
      claudePolicy: this.config.claudePolicy,
      anthropicFederation: federation,
      accountId,
    });
  }

  async provision(
    agentId: string,
    opts?: { slug?: string; accountId?: string | null },
  ): Promise<ProvisionResult> {
    const resourceName = this.resourceName(agentId);
    const secretName = this.secretNameFor(resourceName);
    const pvcName = this.pvcNameFor(resourceName, opts?.slug);
    const result: ProvisionResult = {
      resourceName,
      secretName,
      deploymentName: resourceName,
    };

    // perAgent mode needs an owner to name the identity: check it BEFORE
    // creating anything, so an ownerless agent fails cleanly.
    const perAgent = this.config.perAgentIdentity;
    const identity = perAgent
      ? requireOwner(agentId, await perAgent.identities.get(agentId))
      : undefined;

    // 1. PVC — must exist before the Deployment that mounts it. A 409 means the
    //    PVC already exists from a prior provision; treat as idempotent success.
    //    On any subsequent failure, do NOT delete the PVC (data safety policy).
    try {
      await this.k8s.createPvc(this.config.namespace, this.pvcSpec(pvcName));
    } catch (err) {
      if (!isConflict(err)) throw err;
    }

    if (!perAgent || !identity) {
      return this.provisionSecretAndDeployment(
        agentId,
        opts,
        result,
        this.config.anthropicFederation,
      );
    }

    // perAgent: the identity steps, then Secret + Deployment with the agent's
    // own IDs. Any failure undoes (best-effort, in reverse) the identity pieces
    // THIS call created; the Secret step rolls itself back first.
    const created: CreatedIdentity = {};
    try {
      const federation = perAgentFederation(
        perAgent,
        agentId,
        await this.provisionIdentity(
          perAgent,
          agentId,
          resourceName,
          identity,
          created,
        ),
      );
      return await this.provisionSecretAndDeployment(
        agentId,
        opts,
        result,
        federation,
      );
    } catch (err) {
      await this.rollbackIdentity(perAgent, agentId, created);
      throw err;
    }
  }

  /**
   * Steps 1a–1d of perAgent provisioning. Each ID already saved on the agent is
   * reused; each new one is saved right after its create call. Returns the
   * agent's identity with every ID set. Records what it creates in `created`.
   */
  private async provisionIdentity(
    perAgent: PerAgentIdentityConfig,
    agentId: string,
    resourceName: string,
    initial: AgentAnthropicIdentity & { ownerEmail: string },
    created: CreatedIdentity,
  ): Promise<AgentAnthropicIdentity> {
    const { client, identities, workspaceId } = perAgent;
    let identity: AgentAnthropicIdentity = initial;

    // 1a. Kubernetes ServiceAccount, named like the Deployment. 409 = it already
    //     exists (an earlier call created it), so it is not ours to roll back.
    try {
      await this.k8s.createServiceAccount(this.config.namespace, {
        name: resourceName,
      });
      created.k8sServiceAccount = resourceName;
    } catch (err) {
      if (!isConflict(err)) throw err;
    }
    if (identity.k8sServiceAccountName !== resourceName) {
      identity = await identities.set(agentId, {
        k8sServiceAccountName: resourceName,
      });
    }

    // The Anthropic service account and rule share the agent's identity name.
    const name = await perAgent.names.allocate(agentId, initial.ownerEmail);
    const description = `Shipwright agent ${agentId}`;

    // 1b. Anthropic service account.
    let serviceAccountId = identity.anthropicServiceAccountId;
    if (!serviceAccountId) {
      serviceAccountId = await createOrRecover(
        () => client.createServiceAccount({ name, description }),
        () => client.findServiceAccountByName(name),
        (id) => {
          created.serviceAccountId = id;
        },
      );
      identity = await identities.set(agentId, {
        anthropicServiceAccountId: serviceAccountId,
      });
    }

    // 1c. Workspace membership. 409 = already a member (an earlier call).
    if (workspaceId) {
      try {
        await client.addServiceAccountToWorkspace({
          serviceAccountId,
          workspaceId,
        });
      } catch (err) {
        if (!(err instanceof AnthropicConflictError)) throw err;
      }
    }

    // 1d. Federation rule: trusts exactly this pod's ServiceAccount token
    //     (no trailing `*`, so subject_prefix is an exact match).
    if (!identity.anthropicFederationRuleId) {
      const ruleId = await createOrRecover(
        () =>
          client.createFederationRule({
            name,
            description,
            issuerId: perAgent.issuerId,
            serviceAccountId,
            ...(workspaceId ? { workspaceId } : {}),
            oauthScope: PER_AGENT_RULE_SCOPE,
            match: {
              subjectPrefix: serviceAccountSubject(
                this.config.namespace,
                resourceName,
              ),
              audience: perAgent.audience,
            },
            tokenLifetimeSeconds: PER_AGENT_RULE_TOKEN_LIFETIME_SECONDS,
          }),
        () => client.findFederationRuleByName(name),
        (id) => {
          created.ruleId = id;
        },
      );
      identity = await identities.set(agentId, {
        anthropicFederationRuleId: ruleId,
      });
    }

    return identity;
  }

  /**
   * Best-effort undo of the identity pieces one provision() call created, in
   * reverse creation order, then clear their saved IDs. Never throws: the
   * caller's original error is what surfaces. A piece whose undo fails is left
   * live under the agent's identity name, so a retry recovers it by name.
   */
  private async rollbackIdentity(
    perAgent: PerAgentIdentityConfig,
    agentId: string,
    created: CreatedIdentity,
  ): Promise<void> {
    const { client, identities } = perAgent;
    const clear: Partial<AgentAnthropicIdentity> = {};
    if (created.ruleId) {
      await bestEffort(`archive federation rule ${created.ruleId}`, () =>
        client.archiveFederationRule(created.ruleId as string),
      );
      clear.anthropicFederationRuleId = null;
    }
    if (created.serviceAccountId) {
      await bestEffort(
        `archive Anthropic service account ${created.serviceAccountId}`,
        () => client.archiveServiceAccount(created.serviceAccountId as string),
      );
      clear.anthropicServiceAccountId = null;
    }
    if (created.k8sServiceAccount) {
      await bestEffort(
        `delete ServiceAccount ${created.k8sServiceAccount}`,
        () =>
          this.k8s.deleteServiceAccount(
            this.config.namespace,
            created.k8sServiceAccount as string,
          ),
      );
      clear.k8sServiceAccountName = null;
    }
    if (Object.keys(clear).length > 0) {
      await bestEffort(`clear identity IDs of agent ${agentId}`, () =>
        identities.set(agentId, clear),
      );
    }
  }

  /** Steps 2–4: token(s) → Secret → Deployment (the original provision flow). */
  private async provisionSecretAndDeployment(
    agentId: string,
    opts: { slug?: string; accountId?: string | null } | undefined,
    result: ProvisionResult,
    federation: AgentAnthropicFederation | undefined,
  ): Promise<ProvisionResult> {
    const { secretName } = result;

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

    // Track the integration and chat-service tokens minted in THIS call so we
    // can revoke them on rollback. Only set when the respective config is provided
    // and we actually minted.
    const integrations = provisionableIntegrations(
      this.config.serviceIntegrations,
    );
    const integrationTokens: {
      integration: ServiceIntegration;
      id: string;
      rawToken: string;
    }[] = [];
    let csTokenId: string | undefined;

    if (!secretAlreadyExists) {
      // Optionally mint a token per service integration (list order, before
      // chat) to co-locate in the same Secret write.
      for (const integration of integrations) {
        const { id, rawToken } = await integration.mintToken(
          `agent:${agentId}`,
          agentId,
        );
        integrationTokens.push({ integration, id, rawToken });
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
          this.secretSpec(
            secretName,
            rawToken,
            integrationTokens.map((t) => ({
              secretKey: t.integration.secretKey,
              rawToken: t.rawToken,
            })),
            csRawToken,
          ),
        );
        secretCreated = true;
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }

    // 4. Deployment. If creation fails AFTER we created the Secret in THIS call,
    //    roll the Secret back (best-effort) so a retry starts clean and never
    //    leaks a half-provisioned state. The PVC is NOT rolled back (data safety).
    //    Also revoke any integration and chat-service tokens minted in THIS call.
    try {
      await this.k8s.createDeploymentManifest(
        this.config.namespace,
        this.deploymentManifestFor(
          agentId,
          opts?.slug,
          opts?.accountId,
          federation,
        ),
      );
    } catch (err) {
      if (isConflict(err)) {
        // Deployment already exists — idempotent success. But if we minted and
        // created a NEW Secret in THIS call, the pre-existing Deployment isn't
        // using it; roll the orphaned Secret (and its fresh tokens) back so we
        // never leak it. Only ever delete a Secret THIS call created.
        if (secretCreated) {
          await this.deleteSecretBestEffort(secretName);
          await this.revokeIntegrationTokensBestEffort(integrationTokens);
          await this.revokeChatServiceTokenBestEffort(csTokenId);
        }
        return result;
      }
      if (secretCreated) {
        await this.deleteSecretBestEffort(secretName);
        await this.revokeIntegrationTokensBestEffort(integrationTokens);
        await this.revokeChatServiceTokenBestEffort(csTokenId);
      }
      throw err;
    }

    return result;
  }

  async removeAnthropicIdentity(agentId: string): Promise<void> {
    const perAgent = this.config.perAgentIdentity;
    if (!perAgent) {
      throw new Error(
        "per-agent Anthropic identity is not configured on this provisioner, so the agent's identity cannot be removed automatically",
      );
    }
    const { client, identities } = perAgent;
    const identity = await identities.get(agentId);
    if (!identity) return;

    // Strict order, no best-effort: a failure throws so the caller keeps the
    // Agent row. Each ID is cleared right after its piece is gone, so a retry
    // only redoes what is left.
    if (identity.anthropicFederationRuleId) {
      await tolerateAnthropicNotFound(() =>
        client.archiveFederationRule(
          identity.anthropicFederationRuleId as string,
        ),
      );
      await identities.set(agentId, { anthropicFederationRuleId: null });
    }
    if (identity.anthropicServiceAccountId) {
      await tolerateAnthropicNotFound(() =>
        client.archiveServiceAccount(
          identity.anthropicServiceAccountId as string,
        ),
      );
      await identities.set(agentId, { anthropicServiceAccountId: null });
    }
    if (identity.k8sServiceAccountName) {
      try {
        await this.k8s.deleteServiceAccount(
          this.config.namespace,
          identity.k8sServiceAccountName,
        );
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      await identities.set(agentId, { k8sServiceAccountName: null });
    }
  }

  async deprovision(agentId: string, opts?: { slug?: string }): Promise<void> {
    const resourceName = this.resourceName(agentId);
    const secretName = this.secretNameFor(resourceName);
    const pvcName = this.pvcNameFor(resourceName, opts?.slug);

    // Delete the Deployment first (it depends on the Secret), then the Secret,
    // then the PVC. Already-absent resources (404) are swallowed so teardown
    // is idempotent. Unlike provision()'s rollback path (which deliberately
    // never deletes the PVC — see the "data safety policy" note above), a
    // deliberate full agent deprovision also removes the PVC so deleted
    // agents don't leak storage indefinitely.
    await this.deleteDeploymentBestEffort(resourceName);
    await this.deleteSecretBestEffort(secretName);
    await this.deletePvcBestEffort(pvcName);
  }

  async reconcile(
    agents: ReconcileTarget[],
    opts?: { policyOnly?: boolean; dryRun?: boolean },
  ): Promise<ReconcileResult> {
    const policyOnly = opts?.policyOnly === true;
    const dryRun = opts?.dryRun === true;
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
    const expectedNames = new Map<string, ReconcileTarget>(); // resourceName → agent
    for (const agent of agents) {
      expectedNames.set(this.resourceName(agent.id), agent);
    }

    const recreated: string[] = [];
    const updated: string[] = [];
    const migrated: string[] = [];
    const noOwner: string[] = [];
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
          // perAgent mode: provision() needs an owner, so an ownerless agent is
          // reported rather than counted as a failure. A missing agent row
          // (null identity) still fails in provision() with NotFound.
          if (this.config.perAgentIdentity) {
            const identity = await this.identityOf(agent);
            if (identity && !identity.ownerEmail) {
              noOwner.push(agent.id);
              continue;
            }
          }
          if (!dryRun) {
            await this.provision(agent.id, {
              slug: agent.slug,
              accountId: agent.accountId,
            });
          }
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
          const reconciled = await this.reconcileFederationFor(agent);
          if (reconciled.noOwner) noOwner.push(agent.id);
          // Move an owned agent off the shared ServiceAccount: create its
          // identity (rolling back what this call created if that fails), then
          // fall through to the normal drift correction, which now sees the
          // agent's own federation wiring and patches the ServiceAccount, token
          // volume and federation env to it. policyOnly passes (admin startup)
          // never create identities; a dry run only reports the move.
          let { federation: desiredFederation, manage: manageFederation } =
            reconciled;
          const perAgent = this.config.perAgentIdentity;
          if (reconciled.move && perAgent && !policyOnly) {
            if (dryRun) {
              migrated.push(agent.id);
              updated.push(agent.id);
              continue;
            }
            const created: CreatedIdentity = {};
            try {
              desiredFederation = perAgentFederation(
                perAgent,
                agent.id,
                await this.provisionIdentity(
                  perAgent,
                  agent.id,
                  resourceName,
                  reconciled.move,
                  created,
                ),
              );
              manageFederation = true;
            } catch (err) {
              await this.rollbackIdentity(perAgent, agent.id, created);
              throw err;
            }
            migrated.push(agent.id);
          }
          const desiredDeployment = this.deploymentManifestFor(
            agent.id,
            agent.slug,
            agent.accountId,
            desiredFederation,
          );
          const desired = desiredDeployment.spec.template.spec.containers[0];
          const desiredLabels = desiredDeployment.spec.template.metadata.labels;
          const labelsDrifted =
            !policyOnly &&
            desiredLabels[TENANT_LABEL] !== undefined &&
            deployment.spec.template.metadata?.labels?.[TENANT_LABEL] !==
              desiredLabels[TENANT_LABEL];
          const policy = policyPatch(deployment, desiredDeployment);
          // Unmanaged federation (see reconcileFederationFor): no patch, so
          // the live ServiceAccount, token volume and env are left alone.
          const federation = manageFederation
            ? federationPatch(deployment, desiredDeployment)
            : undefined;
          const containerDrift =
            !policyOnly &&
            current !== undefined &&
            desired !== undefined &&
            containerDrifted(current, desired);
          if (
            desired &&
            (labelsDrifted || containerDrift || policy || federation)
          ) {
            // Under policyOnly the container entry carries only the policy and
            // federation mount/env changes (if any); image, the rest of env,
            // and resources are left to other actors.
            const volumeMounts = [
              ...(policy?.volumeMounts ?? []),
              ...(federation?.volumeMounts ?? []),
            ];
            const desiredEnvNames = new Set(
              (desired.env ?? []).map((e) => e.name),
            );
            const env = policyOnly
              ? (federation?.env ?? [])
              : [
                  ...(desired.env ?? []),
                  // Full env already upserts desired federation entries; only
                  // the delete directives need appending.
                  ...(federation?.env ?? []).filter(
                    (e) => !desiredEnvNames.has((e as { name: string }).name),
                  ),
                ];
            const container = {
              name: desired.name,
              ...(policyOnly
                ? {}
                : {
                    image: desired.image,
                    resources: desired.resources,
                  }),
              ...(volumeMounts.length > 0 ? { volumeMounts } : {}),
              ...(env.length > 0 || !policyOnly ? { env } : {}),
            };
            const includeContainer =
              !policyOnly || volumeMounts.length > 0 || env.length > 0;
            const volumes = [
              ...(policy?.volumes ?? []),
              ...(federation?.volumes ?? []),
            ];
            const serviceAccount =
              federation?.serviceAccountName !== undefined
                ? {
                    serviceAccountName: federation.serviceAccountName,
                    ...(federation.serviceAccount === null
                      ? { serviceAccount: null }
                      : {}),
                  }
                : {};
            const podMetadata = {
              ...(labelsDrifted
                ? { labels: { [TENANT_LABEL]: desiredLabels[TENANT_LABEL] } }
                : {}),
              ...(policy?.annotations
                ? { annotations: policy.annotations }
                : {}),
            };
            if (!dryRun)
              await this.k8s.patchDeployment(
                this.config.namespace,
                resourceName,
                {
                  ...(labelsDrifted
                    ? {
                        metadata: {
                          labels: {
                            [TENANT_LABEL]: desiredLabels[TENANT_LABEL],
                          },
                        },
                      }
                    : {}),
                  spec: {
                    template: {
                      ...(Object.keys(podMetadata).length > 0
                        ? { metadata: podMetadata }
                        : {}),
                      spec: {
                        ...serviceAccount,
                        ...(includeContainer
                          ? { containers: [container] }
                          : {}),
                        ...(volumes.length > 0 ? { volumes } : {}),
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

    return { recreated, updated, migrated, noOwner, orphans, failed, dryRun };
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
    integrationSecrets: { secretKey: string; rawToken: string }[],
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
    // Tokens minted for this agent's service integrations go in the same
    // Secret (list order) so a single Secret holds all per-agent credentials.
    for (const {
      secretKey,
      rawToken: integrationToken,
    } of integrationSecrets) {
      stringData[secretKey] = integrationToken;
    }
    // When a chat-service token was minted for this agent, include it alongside
    // the other per-agent credentials in the same Secret.
    if (chatServiceToken !== undefined) {
      stringData["chat-service-token"] = chatServiceToken;
    }
    return { name: manifest.metadata.name, stringData };
  }

  private async revokeIntegrationTokensBestEffort(
    tokens: { integration: ServiceIntegration; id: string }[],
  ): Promise<void> {
    for (const { integration, id } of tokens) {
      if (!id) continue;
      try {
        await integration.revokeToken(id);
      } catch {
        // Best-effort — log but don't propagate so the original error surfaces.
        console.warn(
          `[provisioner] failed to revoke ${integration.name} token ${id} during rollback`,
        );
      }
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

  private async deletePvcBestEffort(name: string): Promise<void> {
    try {
      await this.k8s.deletePvc(this.config.namespace, name);
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
  readonly canProvision = false;

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

  async deprovision(
    _agentId: string,
    _opts?: { slug?: string },
  ): Promise<void> {
    // intentionally a no-op
  }

  async reconcile(
    _agents: ReconcileTarget[],
    opts?: { policyOnly?: boolean; dryRun?: boolean },
  ): Promise<ReconcileResult> {
    return {
      recreated: [],
      updated: [],
      migrated: [],
      noOwner: [],
      orphans: [],
      failed: [],
      dryRun: opts?.dryRun === true,
    };
  }
}

/**
 * admin/src/admin-boot-config.ts
 *
 * Env-driven configuration helpers for the admin platform boot (admin-boot.ts):
 * the migration preflight, provisioner selection, Anthropic federation parsing,
 * agent-deletion client selection, the readiness DB check and the sweeper
 * interval resolvers. Pure (or early-return) logic kept apart from
 * startAdmin()'s process wiring so it is unit-testable in isolation;
 * main.ts re-exports the public ones (main.unit.test.ts imports them there).
 */

import { join } from "node:path";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentAnthropicIdentityService } from "./agent-anthropic-identity.ts";
import type { AgentAnthropicFederation } from "./agent-manifest.ts";
import type {
  AgentProvisioner,
  PerAgentIdentityConfig,
} from "./agent-provisioner.ts";
import {
  KubernetesAgentProvisioner,
  NoopAgentProvisioner,
} from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import { FederatedTokenProvider } from "./anthropic-federated-token-provider.ts";
import { HttpAnthropicIdentityClient } from "./anthropic-identity-client.ts";
import { AnthropicIdentityNameAllocator } from "./anthropic-identity-name.ts";
import type { ChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import {
  HttpChatServiceProvisioningClient,
  NoopChatServiceProvisioningClient,
} from "./chat-service-provisioning-client.ts";
import { HttpKubernetesClient } from "./kubernetes-client.ts";
import type { TaskStoreProvisioningClient } from "./task-store-provisioning-client.ts";
import {
  HttpTaskStoreProvisioningClient,
  NoopTaskStoreProvisioningClient,
} from "./task-store-provisioning-client.ts";

// ─── Migration preflight ──────────────────────────────────────────────────────

/**
 * Runs `prisma migrate deploy` as a boot preflight.
 * Idempotent — safe to call on every startup. Throws on migration failure.
 *
 * Exported for the early-return branch (DATABASE_URL_SHIPWRIGHT_ADMIN unset) to
 * be unit-tested directly. The Bun.spawn path below it requires a real `bunx
 * prisma migrate deploy` process and a live Postgres — that's process-wiring /
 * real-I/O, exercised in deployed environments and the integration DB rather
 * than a unit test.
 */
export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_SHIPWRIGHT_ADMIN;
  if (!databaseUrl) {
    console.warn(
      "[admin] DATABASE_URL_SHIPWRIGHT_ADMIN not set — skipping prisma migrate deploy",
    );
    return;
  }

  console.log("[admin] running prisma migrate deploy...");

  const proc = Bun.spawn(
    ["bunx", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, DATABASE_URL_SHIPWRIGHT_ADMIN: databaseUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    console.error("[admin] prisma migrate deploy failed:");
    console.error(stderr);
    throw new Error(`prisma migrate deploy exited with code ${proc.exitCode}`);
  }

  if (stdout.trim()) {
    console.log("[admin]", stdout.trim());
  }

  console.log("[admin] migrations complete");
}

// ─── Provisioner selection ────────────────────────────────────────────────────

/**
 * Select the agent provisioner from the environment.
 *
 * When `SHIPWRIGHT_K8S_PROVISIONING=enabled`, construct a real
 * `KubernetesAgentProvisioner` that mints a per-agent token and creates the
 * backing Secret + Deployment in the cluster. Otherwise (unset / any other
 * value) return a `NoopAgentProvisioner` so create/delete behave exactly as
 * before — no cluster required. This keeps the new wiring safe to deploy
 * standalone behind the flag's default.
 *
 * Exported so its many env-driven branches (K8s provisioning flag, voice env
 * passthrough, task-store/chat-service client construction, PVC name template)
 * can be unit-tested directly with an injected/stub AgentTokenService, without
 * needing a real Prisma connection or K8s cluster.
 */
export function buildProvisioner(
  env: NodeJS.ProcessEnv,
  agentTokenService: AgentTokenService,
  prisma?: PrismaClient,
): AgentProvisioner {
  if (env.SHIPWRIGHT_K8S_PROVISIONING !== "enabled") {
    return new NoopAgentProvisioner();
  }

  const namespace = env.SHIPWRIGHT_K8S_NAMESPACE ?? "default";
  const image = env.SHIPWRIGHT_AGENT_IMAGE ?? "";
  const imageTag = env.SHIPWRIGHT_AGENT_IMAGE_TAG ?? "latest";
  const apiUrl = env.SHIPWRIGHT_API_URL ?? "";
  const replicasRaw = env.SHIPWRIGHT_AGENT_REPLICAS;
  const replicas = replicasRaw ? Number(replicasRaw) : undefined;
  const pvcStorageGiRaw = env.SHIPWRIGHT_AGENT_PVC_STORAGE_GI;
  const pvcStorageGi = pvcStorageGiRaw ? Number(pvcStorageGiRaw) : undefined;
  const pvcNameTemplate = env.SHIPWRIGHT_AGENT_PVC_NAME_TEMPLATE;

  // Optional per-field container resource overrides. Resource quantities are
  // strings (e.g. "500m", "2Gi") — no numeric parsing needed, unlike replicas/
  // pvcStorageGi above. Each is passed through only when set (undefined, not
  // an empty string, when unset) so resolveAgentContainerResources's default
  // fallback applies field-by-field.
  const cpuRequest = env.SHIPWRIGHT_K8S_AGENT_CPU_REQUEST;
  const cpuLimit = env.SHIPWRIGHT_K8S_AGENT_CPU_LIMIT;
  const memoryRequest = env.SHIPWRIGHT_K8S_AGENT_MEMORY_REQUEST;
  const memoryLimit = env.SHIPWRIGHT_K8S_AGENT_MEMORY_LIMIT;
  const ephemeralStorage = env.SHIPWRIGHT_K8S_AGENT_EPHEMERAL_STORAGE;
  const resources = {
    ...(cpuRequest ? { cpuRequest } : {}),
    ...(cpuLimit ? { cpuLimit } : {}),
    ...(memoryRequest ? { memoryRequest } : {}),
    ...(memoryLimit ? { memoryLimit } : {}),
    ...(ephemeralStorage ? { ephemeralStorage } : {}),
  };

  // Agent-voice (STT/TTS) env flowed into provisioned agent pods. The chart's
  // voice Secret + Whisper Service URL land in the admin's env when
  // agent.voice.enabled; absent → voice disabled and no voice env is injected.
  const voice = {
    ...(env.WHISPER_SERVICE_URL
      ? { whisperServiceUrl: env.WHISPER_SERVICE_URL }
      : {}),
    ...(env.GROQ_API_KEY ? { groqApiKey: env.GROQ_API_KEY } : {}),
    ...(env.ELEVENLABS_API_KEY
      ? { elevenLabsApiKey: env.ELEVENLABS_API_KEY }
      : {}),
    ...(env.ELEVENLABS_VOICE_ID ? { voiceId: env.ELEVENLABS_VOICE_ID } : {}),
  };

  // Claude Code managed-policy ConfigMap. Empty/unset name disables the
  // feature; the hash is optional and only stamped on pods when non-empty.
  const claudePolicyConfigMap =
    env.SHIPWRIGHT_K8S_AGENT_CLAUDE_POLICY_CONFIGMAP;
  const claudePolicyHash = env.SHIPWRIGHT_K8S_AGENT_CLAUDE_POLICY_HASH;
  const claudePolicy = claudePolicyConfigMap
    ? {
        configMapName: claudePolicyConfigMap,
        ...(claudePolicyHash ? { hash: claudePolicyHash } : {}),
      }
    : undefined;

  // Anthropic workload identity federation. In shared mode an unset rule ID
  // disables it; a partial config throws here so admin startup fails with a
  // clear message. Shared mode passes the one shared identity; perAgent mode
  // passes what the provisioner needs to create each agent's own identity.
  const parsedFederation = parseAnthropicFederation(env);
  let anthropicFederation: AgentAnthropicFederation | undefined;
  let perAgentIdentity: PerAgentIdentityConfig | undefined;
  if (parsedFederation?.mode === "shared") {
    const { mode: _mode, ...shared } = parsedFederation;
    anthropicFederation = shared;
  } else if (parsedFederation?.mode === "perAgent") {
    perAgentIdentity = buildPerAgentIdentity(env, parsedFederation, prisma);
  }

  const taskStoreUrl = env.SHIPWRIGHT_TASK_STORE_URL;
  const taskStoreAdminToken = env.SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN;
  const taskStore =
    taskStoreUrl && taskStoreAdminToken
      ? new HttpTaskStoreProvisioningClient(taskStoreUrl, taskStoreAdminToken)
      : undefined;

  const chatServiceUrl = env.SHIPWRIGHT_CHAT_SERVICE_URL;
  const chatServiceAdminToken = env.SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN;
  const chatService =
    chatServiceUrl && chatServiceAdminToken
      ? new HttpChatServiceProvisioningClient(
          chatServiceUrl,
          chatServiceAdminToken,
        )
      : undefined;

  const k8s = new HttpKubernetesClient();

  return new KubernetesAgentProvisioner(k8s, agentTokenService, {
    namespace,
    image,
    imageTag,
    apiUrl,
    ...(replicas !== undefined && Number.isFinite(replicas)
      ? { replicas }
      : {}),
    ...(pvcStorageGi !== undefined && Number.isFinite(pvcStorageGi)
      ? { pvcStorageGi }
      : {}),
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
    ...(Object.keys(voice).length > 0 ? { voice } : {}),
    ...(claudePolicy ? { claudePolicy } : {}),
    ...(anthropicFederation ? { anthropicFederation } : {}),
    ...(perAgentIdentity ? { perAgentIdentity } : {}),
    // When SHIPWRIGHT_AGENT_PVC_NAME_TEMPLATE is set (e.g. "acme-agent-{name}-home"),
    // substitute {name} with the pre-sanitized name resolved by pvcNameFor()
    // (slug sanitized via sanitizeAgentName, or falls back to resourceName).
    // When unset, the provisioner uses the default `${resourceName}-home` naming.
    ...(pvcNameTemplate
      ? {
          pvcName: (name: string) => pvcNameTemplate.replace("{name}", name),
        }
      : {}),
    // Task-store token minting: when both SHIPWRIGHT_TASK_STORE_URL and
    // SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN are set, mint a per-agent token on
    // provision and inject it into the agent Secret + Deployment.
    ...(taskStore ? { taskStore, taskStoreUrl } : {}),
    // Chat-service token minting: when both SHIPWRIGHT_CHAT_SERVICE_URL and
    // SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN are set, mint a per-agent token on
    // provision and inject it into the agent Secret + Deployment.
    ...(chatService ? { chatService, chatServiceUrl } : {}),
  });
}

/**
 * The perAgent provisioner deps. The admin pod signs in to the Anthropic Admin
 * API by federation with its own projected token and bootstrap rule (the
 * chart renders ANTHROPIC_IDENTITY_TOKEN_FILE / _FEDERATION_RULE_ID /
 * _ORGANIZATION_ID, plus _SERVICE_ACCOUNT_ID / _WORKSPACE_ID, in perAgent
 * mode); identity IDs and names are kept on the Agent row.
 * @throws when the admin sign-in env or the database client is missing
 */
function buildPerAgentIdentity(
  env: NodeJS.ProcessEnv,
  federation: PerAgentAnthropicFederation,
  prisma: PrismaClient | undefined,
): PerAgentIdentityConfig {
  const required = [
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
  ] as const;
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `${FEDERATION_ENV_PREFIX}IDENTITY_MODE is perAgent but the admin's own Anthropic sign-in is not configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing.`,
    );
  }
  if (!prisma) {
    throw new Error(
      "perAgent identity mode needs a database client to save agent identities.",
    );
  }
  const tokenProvider = new FederatedTokenProvider({
    fetchFn: fetch,
    tokenFilePath: env.ANTHROPIC_IDENTITY_TOKEN_FILE as string,
    federationRuleId: env.ANTHROPIC_FEDERATION_RULE_ID as string,
    organizationId: env.ANTHROPIC_ORGANIZATION_ID as string,
    ...(env.ANTHROPIC_SERVICE_ACCOUNT_ID
      ? { serviceAccountId: env.ANTHROPIC_SERVICE_ACCOUNT_ID }
      : {}),
    ...(env.ANTHROPIC_WORKSPACE_ID
      ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID }
      : {}),
  });
  return {
    client: new HttpAnthropicIdentityClient({ fetchFn: fetch, tokenProvider }),
    identities: new AgentAnthropicIdentityService(prisma),
    names: new AnthropicIdentityNameAllocator(prisma, {
      suffix: federation.nameSuffix,
    }),
    organizationId: federation.organizationId,
    ...(federation.workspaceId ? { workspaceId: federation.workspaceId } : {}),
    issuerId: federation.issuerId,
    audience: federation.audience,
    expirationSeconds: federation.expirationSeconds,
  };
}

const FEDERATION_ENV_PREFIX = "SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_";

/** Resolve the identity mode (default "shared"); unknown values throw. */
function resolveFederationIdentityMode(
  env: NodeJS.ProcessEnv,
): "shared" | "perAgent" {
  const modeName = `${FEDERATION_ENV_PREFIX}IDENTITY_MODE`;
  const mode = env[modeName] || "shared";
  if (mode !== "shared" && mode !== "perAgent") {
    throw new Error(
      `${modeName} must be "shared" or "perAgent", got "${mode}".`,
    );
  }
  return mode;
}

/**
 * Whether Anthropic workload identity federation is active for provisioned
 * agent pods (WIF-2.1, PAI-2.1). Derived from the identity mode, mirroring
 * parseAnthropicFederation's gating without its completeness checks (those
 * throw at buildProvisioner time): a deployment that provisions pods AND is in
 * perAgent mode, or in shared mode with the rule ID set, federates agents.
 * Gates the Anthropic credential write/read guards.
 */
export function isAnthropicFederationEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.SHIPWRIGHT_K8S_PROVISIONING !== "enabled") return false;
  return (
    resolveFederationIdentityMode(env) === "perAgent" ||
    Boolean(env[`${FEDERATION_ENV_PREFIX}RULE_ID`])
  );
}

/** Kubernetes rejects projected service-account tokens shorter than this. */
const MIN_FEDERATION_TOKEN_EXPIRATION_SECONDS = 600;

/** Charset for the per-agent name suffix (Kubernetes / Anthropic-safe). */
const FEDERATION_NAME_SUFFIX_PATTERN = /^[a-z0-9-]*$/;

/** perAgent identity mode: every agent gets its own SA and federation rule. */
export interface PerAgentAnthropicFederation {
  mode: "perAgent";
  organizationId: string;
  workspaceId?: string;
  /** Anthropic issuer ID of this cluster (the per-agent rules' issuer). */
  issuerId: string;
  /** Appended to per-agent resource names so clusters sharing an org don't collide. */
  nameSuffix?: string;
  audience: string;
  expirationSeconds: number;
}

/** Discriminated by `mode`; `undefined` (from the parser) means disabled. */
export type ParsedAnthropicFederation =
  | ({ mode: "shared" } & AgentAnthropicFederation)
  | PerAgentAnthropicFederation;

/**
 * Parse the Anthropic Workload Identity Federation config for provisioned agent
 * pods. SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_IDENTITY_MODE selects the
 * mode (default "shared"; unknown values throw).
 *
 * shared: an unset/empty RULE_ID disables the feature (returns undefined, other
 * federation vars ignored). With the rule ID set, the agent ServiceAccount,
 * organization ID and service account ID are required.
 *
 * perAgent: requires ORGANIZATION_ID and ISSUER_ID; the shared rule/service
 * account are not used (per-agent identities are created at provision time).
 *
 * A partial config throws so startup fails loudly instead of provisioning pods
 * that cannot authenticate.
 */
export function parseAnthropicFederation(
  env: NodeJS.ProcessEnv,
): ParsedAnthropicFederation | undefined {
  const prefix = FEDERATION_ENV_PREFIX;
  const mode = resolveFederationIdentityMode(env);

  const ruleId = env[`${prefix}RULE_ID`];
  if (mode === "shared" && !ruleId) return undefined;

  const required =
    mode === "shared"
      ? ({
          serviceAccountName: "SHIPWRIGHT_K8S_AGENT_SERVICE_ACCOUNT",
          organizationId: `${prefix}ORGANIZATION_ID`,
          serviceAccountId: `${prefix}SERVICE_ACCOUNT_ID`,
        } as const)
      : ({
          organizationId: `${prefix}ORGANIZATION_ID`,
          issuerId: `${prefix}ISSUER_ID`,
        } as const);
  const missing = Object.values(required).filter((name) => !env[name]);
  if (missing.length > 0) {
    const verb = missing.length === 1 ? "is" : "are";
    throw new Error(
      mode === "shared"
        ? `Anthropic workload identity federation is partially configured: ${prefix}RULE_ID is set but ${missing.join(", ")} ${verb} missing. Set all of them, or unset ${prefix}RULE_ID to disable federation.`
        : `Anthropic workload identity federation is partially configured: ${prefix}IDENTITY_MODE is perAgent but ${missing.join(", ")} ${verb} missing.`,
    );
  }

  const expirationName = `${prefix}TOKEN_EXPIRATION_SECONDS`;
  const expirationRaw = env[expirationName];
  const expirationSeconds = expirationRaw
    ? Number(expirationRaw)
    : MIN_FEDERATION_TOKEN_EXPIRATION_SECONDS;
  if (
    !Number.isInteger(expirationSeconds) ||
    expirationSeconds < MIN_FEDERATION_TOKEN_EXPIRATION_SECONDS
  ) {
    throw new Error(
      `${expirationName} must be an integer >= ${MIN_FEDERATION_TOKEN_EXPIRATION_SECONDS} (Kubernetes minimum for projected tokens), got "${expirationRaw}".`,
    );
  }

  const workspaceId = env[`${prefix}WORKSPACE_ID`];
  const audience = env[`${prefix}AUDIENCE`] || "https://api.anthropic.com";

  if (mode === "perAgent") {
    const nameSuffix = env[`${prefix}NAME_SUFFIX`];
    if (nameSuffix && !FEDERATION_NAME_SUFFIX_PATTERN.test(nameSuffix)) {
      throw new Error(
        `${prefix}NAME_SUFFIX must match ${FEDERATION_NAME_SUFFIX_PATTERN}, got "${nameSuffix}".`,
      );
    }
    return {
      mode,
      organizationId: env[`${prefix}ORGANIZATION_ID`] as string,
      ...(workspaceId ? { workspaceId } : {}),
      issuerId: env[`${prefix}ISSUER_ID`] as string,
      ...(nameSuffix ? { nameSuffix } : {}),
      audience,
      expirationSeconds,
    };
  }

  return {
    mode,
    serviceAccountName: env.SHIPWRIGHT_K8S_AGENT_SERVICE_ACCOUNT as string,
    ruleId: ruleId as string,
    organizationId: env[`${prefix}ORGANIZATION_ID`] as string,
    serviceAccountId: env[`${prefix}SERVICE_ACCOUNT_ID`] as string,
    ...(workspaceId ? { workspaceId } : {}),
    audience,
    expirationSeconds,
  };
}

// ─── Agent-deletion client selection ──────────────────────────────────────────

/**
 * Select the task-store and chat-service clients used by DELETE /agents/:id's
 * `deleteAgentFully()` orchestration (agent-deletion.ts).
 *
 * Independent of `buildProvisioner`/`SHIPWRIGHT_K8S_PROVISIONING`: unlike the
 * token-minting clients constructed inside that function's closure (only
 * built when K8s provisioning is enabled), agent deletion must be able to
 * revoke task-store/chat-service tokens regardless of whether K8s
 * provisioning is on — e.g. a local dev setup with provisioning disabled but
 * a real task-store/chat-service still running.
 *
 * Gated on the same env-var pairs as `buildProvisioner` (URL + admin token
 * both set) so the "unconfigured" case is unambiguous. When unconfigured,
 * returns the No-op client rather than `undefined` — constructing either
 * client is cheap (no I/O happens until a call is made), so this avoids
 * making `taskStore`/`chatService` optional in `AdminDeps`/`DeleteAgentFullyDeps`
 * for the common case (K8s provisioning disabled, e.g. local dev): a
 * deleteAgentFully() call with nothing to revoke (listTokensForAgent → [])
 * completes cleanly instead of surfacing a new error path.
 */
export function buildDeletionClients(env: NodeJS.ProcessEnv): {
  taskStore: TaskStoreProvisioningClient;
  chatService: ChatServiceProvisioningClient;
} {
  const taskStoreUrl = env.SHIPWRIGHT_TASK_STORE_URL;
  const taskStoreAdminToken = env.SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN;
  const taskStore =
    taskStoreUrl && taskStoreAdminToken
      ? new HttpTaskStoreProvisioningClient(taskStoreUrl, taskStoreAdminToken)
      : new NoopTaskStoreProvisioningClient();

  const chatServiceUrl = env.SHIPWRIGHT_CHAT_SERVICE_URL;
  const chatServiceAdminToken = env.SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN;
  const chatService =
    chatServiceUrl && chatServiceAdminToken
      ? new HttpChatServiceProvisioningClient(
          chatServiceUrl,
          chatServiceAdminToken,
        )
      : new NoopChatServiceProvisioningClient();

  return { taskStore, chatService };
}

// ─── Readiness check ──────────────────────────────────────────────────────────

/**
 * DB-aware readiness check backing GET /health/ready. Runs a lightweight
 * `SELECT 1` and reports whether Postgres is actually reachable — unlike
 * GET /health (liveness), which stays DB-independent so a transient DB blip
 * never triggers a liveness-driven pod restart. Takes only the `$queryRaw`
 * slice of PrismaClient so it's unit-testable with a mocked/injected client,
 * no real I/O.
 */
export async function checkDbReady(prisma: {
  $queryRaw: (
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>;
}): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// ─── Server config ────────────────────────────────────────────────────────────

export const DEFAULT_PORT = 3000;

/**
 * Resolve the public read-only task board repo from the environment.
 * Reads SHIPWRIGHT_ADMIN_PUBLIC_REPO; trims whitespace so a blank/whitespace
 * value behaves like unset (returns undefined → board stays in degraded mode)
 * rather than producing an empty repo filter.
 */
export function resolvePublicRepo(
  env: Record<string, string | undefined>,
): string | undefined {
  return env.SHIPWRIGHT_ADMIN_PUBLIC_REPO?.trim() || undefined;
}

/** Default cadence of the session-alert sweeper — matches chat's stall reaper. */
export const DEFAULT_SESSION_ALERT_INTERVAL_MS = 60_000;

/**
 * Hard timeout on the sweeper's task-store `GET /sessions` calls. Longer than
 * the repo's usual 5s auth-lookup timeout because this fetches up to 500
 * sessions, but still well inside the default 60s tick so a stalled
 * task-store can't wedge the sweep loop behind its in-flight guard.
 */
export const SESSION_ALERT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Resolve the session-alert sweeper's tick interval from the environment.
 * Reads SHIPWRIGHT_ADMIN_SESSION_ALERT_INTERVAL_MS; anything unset, blank,
 * non-numeric, or non-positive falls back to the default rather than
 * producing a setInterval that spins (0/NaN) or never fires.
 */
export function resolveSessionAlertIntervalMs(
  env: Record<string, string | undefined>,
): number {
  const raw = env.SHIPWRIGHT_ADMIN_SESSION_ALERT_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_SESSION_ALERT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_ALERT_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Cadence of the trial-expiry *warning* sweeper (ATE-2.1). Coarser than the
 * session-alert sweeper's 60s default: a trial-expiry warning window is
 * measured in days, not seconds, so hourly polling still leaves enormous
 * margin against ever missing the window.
 *
 * Distinct from trial-expiry-sweeper.ts's own
 * DEFAULT_TRIAL_EXPIRY_SWEEP_INTERVAL_MS (60s), which paces the ATE-3.1
 * lockdown sweeper — that one should react promptly once a trial lapses,
 * whereas this one only has to land somewhere inside a multi-day window.
 */
export const DEFAULT_TRIAL_EXPIRY_WARNING_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Resolve the trial-expiry sweeper's warning window (in days) from the
 * environment. Reads SHIPWRIGHT_ADMIN_TRIAL_EXPIRY_WARNING_DAYS; anything
 * unset, blank, non-numeric, or non-positive falls back to the sweeper's own
 * default (DEFAULT_TRIAL_EXPIRY_WARNING_DAYS) rather than disabling the
 * check or warning agents on every single tick.
 */
export function resolveTrialExpiryWarningDays(
  env: Record<string, string | undefined>,
): number | undefined {
  const raw = env.SHIPWRIGHT_ADMIN_TRIAL_EXPIRY_WARNING_DAYS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

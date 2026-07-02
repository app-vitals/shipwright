/**
 * admin/src/agent-manifest.ts
 *
 * Pure builders for the Kubernetes manifests that provision a single Shipwright
 * agent: a per-agent Deployment, its Opaque token Secret, and the RFC1123 name
 * derivation that ties them together.
 *
 * These functions are PURE — no fs, no network, no clock. They only shape wire
 * objects. The actual k8s API calls live in ./kubernetes-client.ts; this module
 * returns the same `KubernetesDeployment` / `KubernetesSecret` wire types so the
 * two stay structurally consistent.
 */

import { createHash } from "node:crypto";
import type {
  KubernetesDeployment,
  KubernetesEnvVar,
  KubernetesPvc,
  KubernetesSecret,
} from "./kubernetes-client.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Agent health/liveness port (matches the agent's `SHIPWRIGHT_HEALTH_PORT`). */
export const AGENT_HEALTH_PORT = 3459;

/** Where the agent's persistent home volume is mounted in the container. */
export const AGENT_HOME_MOUNT_PATH = "/data/agent-home";

/** Non-root uid/gid the agent runs as (matches the agent image). */
const AGENT_RUN_AS = 1000;

/** RFC1123 label length cap. */
const MAX_NAME_LEN = 63;

/** Length of the appended disambiguation hash suffix. */
const HASH_SUFFIX_LEN = 8;

const NAME_LABEL = "app.kubernetes.io/name";
const INSTANCE_LABEL = "app.kubernetes.io/instance";
const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const AGENT_ID_LABEL = "shipwright.dev/agent-id";
const AGENT_APP_NAME = "shipwright-agent";

// ─── Name sanitization ──────────────────────────────────────────────────────

/**
 * Derive an RFC1123-compliant, collision-resistant Kubernetes object name from
 * an arbitrary agent id.
 *
 * RFC1123 labels must be lowercase alphanumerics or `-`, start/end alphanumeric,
 * and be ≤63 chars.
 *
 * Collision strategy: sanitization is inherently lossy — `agent_1`, `agent.1`,
 * and `Agent-1` all reduce to the same `agent-1` base, and long ids must be
 * truncated. Whenever the cleaned base is NOT a byte-for-byte match of the
 * original id (i.e. any lowercasing, char replacement, collapsing, trimming, or
 * truncation happened), we append `-<8-hex>` where the hex is the leading bytes
 * of `sha256(originalId)`. The hash is over the FULL original id, so two ids
 * that share a cleaned prefix still get distinct suffixes. A lossless id (already
 * valid RFC1123) is returned unchanged. The base is truncated as needed so that
 * `base + "-" + suffix` still fits within 63 chars.
 */
export function sanitizeAgentName(id: string): string {
  const base = cleanBase(id);

  // Lossless: the id was already a valid RFC1123 label — return as-is.
  if (base === id && base.length > 0 && base.length <= MAX_NAME_LEN) {
    return base;
  }

  const suffix = createHash("sha256")
    .update(id)
    .digest("hex")
    .slice(0, HASH_SUFFIX_LEN);

  // Reserve room for "-" + suffix, then re-trim any dash exposed at the new end.
  const room = MAX_NAME_LEN - (suffix.length + 1);
  const truncated = trimDashes(base.slice(0, Math.max(0, room)));
  const prefix = truncated.length > 0 ? `${truncated}-` : "";
  return `${prefix}${suffix}`;
}

/** Lowercase, replace invalid runs with a single dash, trim dash padding. */
function cleanBase(id: string): string {
  const lowered = id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return trimDashes(lowered);
}

function trimDashes(s: string): string {
  return s.replace(/^-+/, "").replace(/-+$/, "");
}

// ─── PVC builder ────────────────────────────────────────────────────────────

export interface AgentPvcOpts {
  name: string;
  namespace: string;
  sizeGi: number;
  storageClassName?: string;
}

export function buildAgentPvcManifest(opts: AgentPvcOpts): KubernetesPvc {
  const manifest: KubernetesPvc = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: `${opts.sizeGi}Gi` } },
    },
  };
  if (opts.storageClassName !== undefined) {
    manifest.spec.storageClassName = opts.storageClassName;
  }
  return manifest;
}

// ─── Deployment builder ─────────────────────────────────────────────────────

export interface AgentDeploymentOpts {
  /** Original agent id (used verbatim in env + label, sanitized for the name). */
  agentId: string;
  namespace: string;
  /** Agent container image (without tag). */
  image: string;
  /** Image tag, joined as `image:tag`. */
  imageTag: string;
  /** In-cluster admin/API base URL the agent calls home to. */
  apiUrl: string;
  /** Name of the pre-provisioned PersistentVolumeClaim for the agent home. */
  pvcName: string;
  /** Name of the Secret holding the per-agent token. */
  secretName: string;
  /** Key within the Secret's data that holds the token. Defaults to "token". */
  tokenSecretKey?: string;
  /** Replica count. Defaults to 1. */
  replicas?: number;
  /**
   * Optional agent-voice (STT/TTS) configuration. When omitted, the provisioned
   * agent pod gets only the 3 base env vars (voice disabled). When present, the
   * relevant vars are appended after the base vars:
   *   - whisperServiceUrl → WHISPER_SERVICE_URL (provider=whisper)
   *   - groqApiKey        → GROQ_API_KEY        (provider=groq)
   *   - elevenLabsApiKey  → ELEVENLABS_API_KEY  (TTS, either provider)
   *   - voiceId           → ELEVENLABS_VOICE_ID (optional TTS voice override)
   * Only the keys that are set are injected — this mirrors the agent's own
   * env contract (agent/src/config.ts).
   */
  voice?: AgentVoiceEnv;
  /**
   * When set, inject SHIPWRIGHT_TASK_STORE_TOKEN (via secretKeyRef from the
   * agent Secret) and SHIPWRIGHT_TASK_STORE_URL (as a plain value) into the
   * agent Deployment. Placed after AGENT_HOME and before voice env vars.
   */
  taskStoreUrl?: string;
  /**
   * Key within the agent Secret under which the task-store token is stored.
   * Defaults to "task-store-token".
   */
  taskStoreTokenSecretKey?: string;
  /**
   * When set, inject SHIPWRIGHT_CHAT_SERVICE_TOKEN (via secretKeyRef from the
   * agent Secret) and SHIPWRIGHT_CHAT_SERVICE_URL (as a plain value) into the
   * agent Deployment. Placed after task-store env vars and before voice env vars.
   */
  chatServiceUrl?: string;
  /**
   * Key within the agent Secret under which the chat-service token is stored.
   * Defaults to "chat-service-token".
   */
  chatServiceTokenSecretKey?: string;
}

/**
 * The subset of voice env an admin provisioner flows into a provisioned agent
 * pod. The admin reads these from its OWN env (sourced from the chart's voice
 * Secret + whisper Service URL); this builder only shapes the pod env from them.
 */
export interface AgentVoiceEnv {
  /** http(s) URL of the self-hosted Whisper pod (provider=whisper). */
  whisperServiceUrl?: string;
  /** Groq API key (provider=groq). */
  groqApiKey?: string;
  /** ElevenLabs API key (TTS). */
  elevenLabsApiKey?: string;
  /** Optional ElevenLabs voice id override. */
  voiceId?: string;
}

/**
 * Build the ordered voice env entries from a partial voice config. Only set
 * keys are emitted; an empty/undefined config yields no entries (voice
 * disabled). Order is stable for deterministic manifests/tests.
 */
function voiceEnvEntries(
  voice: AgentVoiceEnv | undefined,
): { name: string; value: string }[] {
  if (!voice) return [];
  const entries: { name: string; value: string }[] = [];
  if (voice.whisperServiceUrl) {
    entries.push({
      name: "WHISPER_SERVICE_URL",
      value: voice.whisperServiceUrl,
    });
  }
  if (voice.groqApiKey) {
    entries.push({ name: "GROQ_API_KEY", value: voice.groqApiKey });
  }
  if (voice.elevenLabsApiKey) {
    entries.push({ name: "ELEVENLABS_API_KEY", value: voice.elevenLabsApiKey });
  }
  if (voice.voiceId) {
    entries.push({ name: "ELEVENLABS_VOICE_ID", value: voice.voiceId });
  }
  return entries;
}

/**
 * Build task-store env entries when taskStoreUrl is configured. Returns two
 * entries: SHIPWRIGHT_TASK_STORE_TOKEN (secretKeyRef from the agent Secret)
 * and SHIPWRIGHT_TASK_STORE_URL (plain value). Returns an empty array when
 * taskStoreUrl is absent (task-store wiring disabled).
 */
function taskStoreEnvEntries(opts: AgentDeploymentOpts): KubernetesEnvVar[] {
  if (!opts.taskStoreUrl) return [];
  const tsKey = opts.taskStoreTokenSecretKey ?? "task-store-token";
  return [
    {
      name: "SHIPWRIGHT_TASK_STORE_TOKEN",
      valueFrom: {
        secretKeyRef: { name: opts.secretName, key: tsKey },
      },
    },
    {
      name: "SHIPWRIGHT_TASK_STORE_URL",
      value: opts.taskStoreUrl,
    },
  ];
}

/**
 * Build chat-service env entries when chatServiceUrl is configured. Returns two
 * entries: SHIPWRIGHT_CHAT_SERVICE_TOKEN (secretKeyRef from the agent Secret)
 * and SHIPWRIGHT_CHAT_SERVICE_URL (plain value). Returns an empty array when
 * chatServiceUrl is absent (chat-service wiring disabled).
 */
function chatServiceEnvEntries(opts: AgentDeploymentOpts): KubernetesEnvVar[] {
  if (!opts.chatServiceUrl) return [];
  const csKey = opts.chatServiceTokenSecretKey ?? "chat-service-token";
  return [
    {
      name: "SHIPWRIGHT_CHAT_SERVICE_TOKEN",
      valueFrom: {
        secretKeyRef: { name: opts.secretName, key: csKey },
      },
    },
    {
      name: "SHIPWRIGHT_CHAT_SERVICE_URL",
      value: opts.chatServiceUrl,
    },
  ];
}

export function buildAgentDeploymentManifest(
  opts: AgentDeploymentOpts,
): KubernetesDeployment {
  const name = sanitizeAgentName(opts.agentId);
  const tokenKey = opts.tokenSecretKey ?? "token";
  const volumeName = "agent-home";

  const labels: Record<string, string> = {
    [NAME_LABEL]: AGENT_APP_NAME,
    [INSTANCE_LABEL]: name,
    [MANAGED_BY_LABEL]: "shipwright-admin",
    [AGENT_ID_LABEL]: opts.agentId,
  };

  // Selectors are immutable post-create and must not include volatile values;
  // the instance label is the stable per-agent identity.
  const selectorLabels: Record<string, string> = {
    [NAME_LABEL]: AGENT_APP_NAME,
    [INSTANCE_LABEL]: name,
  };

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace: opts.namespace,
      labels,
    },
    spec: {
      replicas: opts.replicas ?? 1,
      // Recreate: Slack Socket Mode allows only one active connection per token.
      // RollingUpdate would briefly create a second pod that fights for the socket.
      strategy: { type: "Recreate" },
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: { labels: selectorLabels },
        spec: {
          securityContext: {
            fsGroup: AGENT_RUN_AS,
            fsGroupChangePolicy: "OnRootMismatch",
            runAsNonRoot: true,
            runAsUser: AGENT_RUN_AS,
          },
          // 120s grace period mirrors the Helm-managed agent template and gives
          // the agent time to finish an in-flight Claude response before SIGKILL.
          terminationGracePeriodSeconds: 120,
          volumes: [
            {
              name: volumeName,
              persistentVolumeClaim: { claimName: opts.pvcName },
            },
          ],
          containers: [
            {
              name: AGENT_APP_NAME,
              image: `${opts.image}:${opts.imageTag}`,
              ports: [{ containerPort: AGENT_HEALTH_PORT, protocol: "TCP" }],
              env: [
                { name: "SHIPWRIGHT_AGENT_ID", value: opts.agentId },
                { name: "SHIPWRIGHT_API_URL", value: opts.apiUrl },
                {
                  name: "SHIPWRIGHT_AGENT_API_KEY",
                  valueFrom: {
                    secretKeyRef: { name: opts.secretName, key: tokenKey },
                  },
                },
                // Tell the agent where its persistent home directory is mounted.
                { name: "AGENT_HOME", value: AGENT_HOME_MOUNT_PATH },
                // Task-store env — injected after AGENT_HOME when task-store is
                // configured; omitted entirely when taskStoreUrl is absent.
                ...taskStoreEnvEntries(opts),
                // Chat-service env — injected after task-store vars when chat
                // service is configured; omitted entirely when chatServiceUrl is absent.
                ...chatServiceEnvEntries(opts),
                // Voice (STT/TTS) env — appended only for the keys that are set
                // (none when voice is disabled, preserving the 4 base vars).
                ...voiceEnvEntries(opts.voice),
              ],
              volumeMounts: [
                { name: volumeName, mountPath: AGENT_HOME_MOUNT_PATH },
              ],
              // Gate liveness/readiness until the agent's health server binds.
              // Startup runs `mise install` + plugin install, which can exceed a
              // minute on a cold/contended node; without this, liveness would
              // restart the container (~75s in) before startup ever finished.
              // 18 × 10s = 180s grace, aligned with the entrypoint startup
              // watchdog (DEFAULT_STARTUP_TIMEOUT_MS in agent/src/entrypoint.ts).
              startupProbe: {
                httpGet: { path: "/health", port: AGENT_HEALTH_PORT },
                periodSeconds: 10,
                failureThreshold: 18,
              },
              livenessProbe: {
                httpGet: { path: "/health", port: AGENT_HEALTH_PORT },
                initialDelaySeconds: 15,
                periodSeconds: 30,
                failureThreshold: 3,
              },
              readinessProbe: {
                httpGet: { path: "/health", port: AGENT_HEALTH_PORT },
                initialDelaySeconds: 10,
                periodSeconds: 10,
                failureThreshold: 3,
              },
              securityContext: {
                runAsNonRoot: true,
                runAsUser: AGENT_RUN_AS,
                allowPrivilegeEscalation: false,
              },
            },
          ],
        },
      },
    },
  };
}

// ─── Secret builder ─────────────────────────────────────────────────────────

export interface AgentSecretOpts {
  name: string;
  namespace: string;
  /** Plaintext per-agent token; base64-encoded into the Secret's `data`. */
  token: string;
  /** Key under which the token is stored. Defaults to "token". */
  tokenKey?: string;
}

export function buildAgentSecretManifest(
  opts: AgentSecretOpts,
): KubernetesSecret {
  const tokenKey = opts.tokenKey ?? "token";
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
    },
    data: {
      [tokenKey]: Buffer.from(opts.token).toString("base64"),
    },
  };
}

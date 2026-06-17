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
 *
 * Garbage collection: each agent resource carries an `ownerReference` to the
 * admin Deployment. When the admin Deployment is deleted on uninstall,
 * Kubernetes cascade-deletes every owned agent Deployment + Secret.
 */

import { createHash } from "node:crypto";
import type {
  KubernetesDeployment,
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

// ─── Owner reference (GC) ───────────────────────────────────────────────────

interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller: boolean;
  blockOwnerDeletion: boolean;
  [key: string]: unknown;
}

function adminOwnerReference(name: string, uid: string): OwnerReference {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    name,
    uid,
    controller: true,
    blockOwnerDeletion: true,
  };
}

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
  /** Admin Deployment name (ownerReference target for GC). */
  adminDeploymentName: string;
  /** Admin Deployment uid (ownerReference target for GC). */
  adminDeploymentUid: string;
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
      ownerReferences: [
        adminOwnerReference(opts.adminDeploymentName, opts.adminDeploymentUid),
      ],
    },
    spec: {
      replicas: opts.replicas ?? 1,
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: { labels: selectorLabels },
        spec: {
          securityContext: {
            fsGroup: AGENT_RUN_AS,
            runAsNonRoot: true,
            runAsUser: AGENT_RUN_AS,
          },
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
              env: [
                { name: "SHIPWRIGHT_AGENT_ID", value: opts.agentId },
                { name: "SHIPWRIGHT_API_URL", value: opts.apiUrl },
                {
                  name: "SHIPWRIGHT_AGENT_API_KEY",
                  valueFrom: {
                    secretKeyRef: { name: opts.secretName, key: tokenKey },
                  },
                },
                // Voice (STT/TTS) env — appended only for the keys that are set
                // (none when voice is disabled, preserving the 3 base vars).
                ...voiceEnvEntries(opts.voice),
              ],
              volumeMounts: [
                { name: volumeName, mountPath: AGENT_HOME_MOUNT_PATH },
              ],
              livenessProbe: {
                httpGet: { path: "/health", port: AGENT_HEALTH_PORT },
                initialDelaySeconds: 10,
                periodSeconds: 15,
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
  /** Admin Deployment name (ownerReference target for GC). */
  adminDeploymentName: string;
  /** Admin Deployment uid (ownerReference target for GC). */
  adminDeploymentUid: string;
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
      ownerReferences: [
        adminOwnerReference(opts.adminDeploymentName, opts.adminDeploymentUid),
      ],
    },
    data: {
      [tokenKey]: Buffer.from(opts.token).toString("base64"),
    },
  };
}

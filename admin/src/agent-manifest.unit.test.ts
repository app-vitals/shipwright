/**
 * admin/src/agent-manifest.unit.test.ts
 * Unit tests for the pure agent Kubernetes manifest builders. No I/O, no
 * network, no fs — these assert wire-shape only.
 */

import { describe, expect, it } from "bun:test";
import {
  AGENT_HEALTH_PORT,
  AGENT_HOME_MOUNT_PATH,
  type AgentDeploymentOpts,
  type AgentPvcOpts,
  type AgentSecretOpts,
  buildAgentDeploymentManifest,
  buildAgentPvcManifest,
  buildAgentSecretManifest,
  sanitizeAgentName,
} from "./agent-manifest.ts";

// ─── Shared fixtures ────────────────────────────────────────────────────────

const deployOpts: AgentDeploymentOpts = {
  agentId: "agent_42",
  namespace: "shipwright",
  image: "ghcr.io/app-vitals/shipwright-agent",
  imageTag: "v1.2.3",
  apiUrl: "http://shipwright-admin.shipwright.svc:3001",
  pvcName: "agent-42-home",
  secretName: "agent-42-token",
  tokenSecretKey: "token",
};

// ─── buildAgentDeploymentManifest ───────────────────────────────────────────

describe("buildAgentDeploymentManifest", () => {
  it("emits a valid apps/v1 Deployment", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    expect(d.apiVersion).toBe("apps/v1");
    expect(d.kind).toBe("Deployment");
    expect(d.metadata.namespace).toBe("shipwright");
    expect(d.spec.replicas).toBe(1);
  });

  it("derives a sanitized RFC1123 metadata name from the agent id", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    expect(d.metadata.name).toBe(sanitizeAgentName("agent_42"));
    expect(d.metadata.name).not.toContain("_");
  });

  it("joins image and tag", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    expect(d.spec.template.spec.containers[0].image).toBe(
      "ghcr.io/app-vitals/shipwright-agent:v1.2.3",
    );
  });

  it("sets labels and matching selector/template labels", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const name = sanitizeAgentName("agent_42");
    expect(d.metadata.labels).toMatchObject({
      "app.kubernetes.io/name": "shipwright-agent",
      "app.kubernetes.io/instance": name,
      "shipwright.dev/agent-id": "agent_42",
    });
    // selector must match the pod template labels (else 0 pods scheduled)
    expect(d.spec.selector.matchLabels).toEqual(
      d.spec.template.metadata.labels,
    );
    expect(d.spec.selector.matchLabels).toMatchObject({
      "app.kubernetes.io/instance": name,
    });
  });

  it("sets the required env vars including a secretKeyRef token", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const env = d.spec.template.spec.containers[0].env ?? [];
    const byName = new Map(env.map((e) => [e.name, e]));

    expect(byName.get("SHIPWRIGHT_AGENT_ID")?.value).toBe("agent_42");
    expect(byName.get("SHIPWRIGHT_API_URL")?.value).toBe(
      "http://shipwright-admin.shipwright.svc:3001",
    );

    const tokenEnv = byName.get("SHIPWRIGHT_AGENT_API_KEY");
    expect(tokenEnv).toBeDefined();
    expect(tokenEnv?.value).toBeUndefined();
    expect(tokenEnv?.valueFrom?.secretKeyRef).toEqual({
      name: "agent-42-token",
      key: "token",
    });
  });

  it("mounts a PVC volume at the agent home path", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const podSpec = d.spec.template.spec;

    const vol = podSpec.volumes?.find(
      (v) => v.persistentVolumeClaim?.claimName === "agent-42-home",
    );
    expect(vol).toBeDefined();

    const mount = podSpec.containers[0].volumeMounts?.find(
      (m) => m.mountPath === AGENT_HOME_MOUNT_PATH,
    );
    expect(mount).toBeDefined();
    expect(AGENT_HOME_MOUNT_PATH).toBe("/data/agent-home");
    // volume name and mount name must agree
    expect(mount?.name).toBe(vol?.name);
  });

  it("sets strategy Recreate", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    expect(d.spec.strategy).toEqual({ type: "Recreate" });
  });

  it("sets terminationGracePeriodSeconds to 120", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    expect(d.spec.template.spec.terminationGracePeriodSeconds).toBe(120);
  });

  it("declares a containerPort for the health port", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const ports = d.spec.template.spec.containers[0].ports ?? [];
    expect(ports).toContainEqual({
      containerPort: AGENT_HEALTH_PORT,
      protocol: "TCP",
    });
  });

  it("sets AGENT_HOME env var to the mount path", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const env = d.spec.template.spec.containers[0].env ?? [];
    const agentHome = env.find((e) => e.name === "AGENT_HOME");
    expect(agentHome?.value).toBe(AGENT_HOME_MOUNT_PATH);
  });

  it("routes repo clones and worktrees to the PVC, not ephemeral $HOME", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const env = d.spec.template.spec.containers[0].env ?? [];
    const byName = new Map(env.map((e) => [e.name, e]));
    expect(byName.get("SHIPWRIGHT_REPO_DIR")?.value).toBe(
      `${AGENT_HOME_MOUNT_PATH}/workspace/repos`,
    );
    expect(byName.get("SHIPWRIGHT_WORKTREE_DIR")?.value).toBe(
      `${AGENT_HOME_MOUNT_PATH}/workspace/worktrees`,
    );
  });

  it("defines liveness and readiness probes on the health port", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const c = d.spec.template.spec.containers[0];
    expect(AGENT_HEALTH_PORT).toBe(3459);
    expect(c.livenessProbe?.httpGet?.port).toBe(3459);
    expect(c.livenessProbe?.failureThreshold).toBe(3);
    expect(c.readinessProbe?.httpGet?.port).toBe(3459);
    expect(c.readinessProbe?.failureThreshold).toBe(3);
  });

  it("gates liveness/readiness with a startupProbe granting ~180s for a slow mise startup", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const c = d.spec.template.spec.containers[0];
    expect(c.startupProbe?.httpGet?.port).toBe(AGENT_HEALTH_PORT);
    expect(c.startupProbe?.httpGet?.path).toBe("/health");
    // periodSeconds × failureThreshold = total grace before liveness engages.
    const grace =
      (c.startupProbe?.periodSeconds as number) *
      (c.startupProbe?.failureThreshold as number);
    expect(grace).toBe(180);
  });

  it("applies a hardened security context (fsGroup, fsGroupChangePolicy, runAsNonRoot, runAsUser)", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const podSpec = d.spec.template.spec;
    expect(podSpec.securityContext).toMatchObject({
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      runAsNonRoot: true,
      runAsUser: 1000,
    });
    expect(podSpec.containers[0].securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
    });
  });

  it("does not set ownerReferences", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    expect(d.metadata.ownerReferences).toBeUndefined();
  });

  it("honours an explicit replicas override", () => {
    const d = buildAgentDeploymentManifest({ ...deployOpts, replicas: 0 });
    expect(d.spec.replicas).toBe(0);
  });
});

// ─── voice env injection ────────────────────────────────────────────────────

describe("buildAgentDeploymentManifest — voice env", () => {
  const envNames = (d: ReturnType<typeof buildAgentDeploymentManifest>) =>
    (d.spec.template.spec.containers[0].env ?? []).map((e) => e.name);

  it("injects only the 6 base vars when no voice config is supplied (disabled)", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    expect(envNames(d)).toEqual([
      "SHIPWRIGHT_AGENT_ID",
      "SHIPWRIGHT_API_URL",
      "SHIPWRIGHT_AGENT_API_KEY",
      "AGENT_HOME",
      "SHIPWRIGHT_REPO_DIR",
      "SHIPWRIGHT_WORKTREE_DIR",
    ]);
  });

  it("injects WHISPER_SERVICE_URL + ELEVENLABS_API_KEY for the whisper provider", () => {
    const d = buildAgentDeploymentManifest({
      ...deployOpts,
      voice: {
        whisperServiceUrl: "http://r-shipwright-whisper:9000",
        elevenLabsApiKey: "el-key",
      },
    });
    const env = d.spec.template.spec.containers[0].env ?? [];
    const byName = new Map(env.map((e) => [e.name, e]));

    expect(byName.get("WHISPER_SERVICE_URL")?.value).toBe(
      "http://r-shipwright-whisper:9000",
    );
    expect(byName.get("ELEVENLABS_API_KEY")?.value).toBe("el-key");
    // whisper mode does not flow a Groq key
    expect(byName.has("GROQ_API_KEY")).toBe(false);
  });

  it("injects GROQ_API_KEY + ELEVENLABS_API_KEY for the groq provider (no WHISPER_SERVICE_URL)", () => {
    const d = buildAgentDeploymentManifest({
      ...deployOpts,
      voice: {
        groqApiKey: "groq-key",
        elevenLabsApiKey: "el-key",
      },
    });
    const env = d.spec.template.spec.containers[0].env ?? [];
    const byName = new Map(env.map((e) => [e.name, e]));

    expect(byName.get("GROQ_API_KEY")?.value).toBe("groq-key");
    expect(byName.get("ELEVENLABS_API_KEY")?.value).toBe("el-key");
    expect(byName.has("WHISPER_SERVICE_URL")).toBe(false);
  });

  it("injects an optional ELEVENLABS_VOICE_ID when supplied", () => {
    const d = buildAgentDeploymentManifest({
      ...deployOpts,
      voice: {
        elevenLabsApiKey: "el-key",
        voiceId: "voice-xyz",
      },
    });
    const env = d.spec.template.spec.containers[0].env ?? [];
    const byName = new Map(env.map((e) => [e.name, e]));
    expect(byName.get("ELEVENLABS_VOICE_ID")?.value).toBe("voice-xyz");
  });

  it("keeps the base 6 vars first and appends voice vars after them", () => {
    const d = buildAgentDeploymentManifest({
      ...deployOpts,
      voice: { whisperServiceUrl: "http://w:9000", elevenLabsApiKey: "k" },
    });
    const names = envNames(d);
    expect(names.slice(0, 6)).toEqual([
      "SHIPWRIGHT_AGENT_ID",
      "SHIPWRIGHT_API_URL",
      "SHIPWRIGHT_AGENT_API_KEY",
      "AGENT_HOME",
      "SHIPWRIGHT_REPO_DIR",
      "SHIPWRIGHT_WORKTREE_DIR",
    ]);
    expect(names).toContain("WHISPER_SERVICE_URL");
  });
});

// ─── buildAgentSecretManifest ───────────────────────────────────────────────

describe("buildAgentSecretManifest", () => {
  const secretOpts: AgentSecretOpts = {
    name: "agent-42-token",
    namespace: "shipwright",
    token: "sw-agent-secret-token",
    tokenKey: "token",
  };

  it("emits an Opaque v1 Secret", () => {
    const s = buildAgentSecretManifest(secretOpts);
    expect(s.apiVersion).toBe("v1");
    expect(s.kind).toBe("Secret");
    expect(s.type).toBe("Opaque");
    expect(s.metadata.name).toBe("agent-42-token");
    expect(s.metadata.namespace).toBe("shipwright");
  });

  it("base64-encodes the token under the configured key in data", () => {
    const s = buildAgentSecretManifest(secretOpts);
    expect(s.data.token).toBe(
      Buffer.from("sw-agent-secret-token").toString("base64"),
    );
  });

  it("defaults the token key to 'token'", () => {
    const { tokenKey: _omit, ...rest } = secretOpts;
    const s = buildAgentSecretManifest(rest);
    expect(s.data.token).toBeDefined();
  });

  it("does not set ownerReferences", () => {
    const s = buildAgentSecretManifest(secretOpts);
    expect(s.metadata.ownerReferences).toBeUndefined();
  });
});

// ─── buildAgentPvcManifest ──────────────────────────────────────────────────

describe("buildAgentPvcManifest", () => {
  const pvcOpts: AgentPvcOpts = {
    name: "agent-42-home",
    namespace: "shipwright",
    sizeGi: 40,
  };

  it("emits a v1 PersistentVolumeClaim", () => {
    const p = buildAgentPvcManifest(pvcOpts);
    expect(p.apiVersion).toBe("v1");
    expect(p.kind).toBe("PersistentVolumeClaim");
    expect(p.metadata.name).toBe("agent-42-home");
    expect(p.metadata.namespace).toBe("shipwright");
  });

  it("sets accessModes to ReadWriteOnce", () => {
    const p = buildAgentPvcManifest(pvcOpts);
    expect(p.spec.accessModes).toEqual(["ReadWriteOnce"]);
  });

  it("sets storage to sizeGi Gi", () => {
    const p = buildAgentPvcManifest(pvcOpts);
    expect(p.spec.resources.requests.storage).toBe("40Gi");
  });

  it("honours a custom sizeGi", () => {
    const p = buildAgentPvcManifest({ ...pvcOpts, sizeGi: 100 });
    expect(p.spec.resources.requests.storage).toBe("100Gi");
  });

  it("includes storageClassName when provided", () => {
    const p = buildAgentPvcManifest({
      ...pvcOpts,
      storageClassName: "premium",
    });
    expect(p.spec.storageClassName).toBe("premium");
  });

  it("omits storageClassName when not provided", () => {
    const p = buildAgentPvcManifest(pvcOpts);
    expect(p.spec.storageClassName).toBeUndefined();
  });

  it("does not set ownerReferences", () => {
    const p = buildAgentPvcManifest(pvcOpts);
    expect(p.metadata.ownerReferences).toBeUndefined();
  });
});

// ─── sanitizeAgentName ──────────────────────────────────────────────────────

const RFC1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

describe("sanitizeAgentName", () => {
  it("lowercases uppercase characters (lossy → hash suffix)", () => {
    expect(sanitizeAgentName("AgentFoo")).toMatch(RFC1123);
    expect(sanitizeAgentName("AgentFoo")).toMatch(/^agentfoo-[a-z0-9]+$/);
  });

  it("replaces underscores and dots with dashes (lossy → hash suffix)", () => {
    // The cleaned base is "agent-42-beta", then a short hash of the original id
    // is appended so distinct originals never collide.
    expect(sanitizeAgentName("agent_42.beta")).toMatch(
      /^agent-42-beta-[a-z0-9]+$/,
    );
  });

  it("collapses runs of invalid characters into a single dash", () => {
    expect(sanitizeAgentName("a___b")).toMatch(/^a-b-[a-z0-9]+$/);
  });

  it("strips leading and trailing non-alphanumerics", () => {
    expect(sanitizeAgentName("__agent__")).toMatch(/^agent-[a-z0-9]+$/);
    expect(sanitizeAgentName("-.-foo-.-")).toMatch(/^foo-[a-z0-9]+$/);
  });

  it("leaves an already-RFC1123 id unchanged (lossless → no hash suffix)", () => {
    expect(sanitizeAgentName("agent-42")).toBe("agent-42");
    expect(sanitizeAgentName("a1")).toBe("a1");
  });

  it("always produces an RFC1123-compliant label", () => {
    for (const id of [
      "Agent_42",
      "___",
      "UPPER.Case_ID",
      "a".repeat(200),
      "weird@@chars!!here",
      "123start",
    ]) {
      const out = sanitizeAgentName(id);
      expect(out.length).toBeGreaterThan(0);
      expect(out.length).toBeLessThanOrEqual(63);
      expect(out).toMatch(RFC1123);
    }
  });

  it("never exceeds 63 characters even for very long ids", () => {
    const out = sanitizeAgentName("agent-".repeat(50));
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out).toMatch(RFC1123);
  });

  it("appends a hash suffix when the id is truncated (collision resistance)", () => {
    const longA = `${"x".repeat(100)}aaaa`;
    const longB = `${"x".repeat(100)}bbbb`;
    const a = sanitizeAgentName(longA);
    const b = sanitizeAgentName(longB);
    // Truncation alone would collide on the shared prefix; the hash suffix
    // derived from the full original id keeps them distinct.
    expect(a).not.toBe(b);
    expect(a).toMatch(RFC1123);
    expect(b).toMatch(RFC1123);
  });

  it("disambiguates ids that sanitize to the same label", () => {
    // "agent_1" and "agent.1" both naively map to "agent-1"; the hash suffix
    // from the distinct originals keeps the k8s names unique.
    const a = sanitizeAgentName("agent_1");
    const b = sanitizeAgentName("agent.1");
    expect(a).not.toBe(b);
  });

  it("produces a non-empty fallback when nothing alphanumeric remains", () => {
    const out = sanitizeAgentName("___");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(RFC1123);
  });

  it("is deterministic for a given id", () => {
    expect(sanitizeAgentName("agent_42")).toBe(sanitizeAgentName("agent_42"));
  });
});

// ─── task-store env injection ───────────────────────────────────────────────

describe("buildAgentDeploymentManifest — task-store env", () => {
  it("injects SHIPWRIGHT_TASK_STORE_TOKEN and SHIPWRIGHT_TASK_STORE_URL when taskStoreUrl is set", () => {
    const d = buildAgentDeploymentManifest({
      ...deployOpts,
      taskStoreUrl: "http://task-store.svc:4000",
    });
    const env = d.spec.template.spec.containers[0].env ?? [];
    const byName = new Map(env.map((e) => [e.name, e]));

    const tokenEnv = byName.get("SHIPWRIGHT_TASK_STORE_TOKEN");
    expect(tokenEnv).toBeDefined();
    expect(tokenEnv?.value).toBeUndefined();
    expect(tokenEnv?.valueFrom?.secretKeyRef).toEqual({
      name: deployOpts.secretName,
      key: "task-store-token",
    });

    const urlEnv = byName.get("SHIPWRIGHT_TASK_STORE_URL");
    expect(urlEnv).toBeDefined();
    expect(urlEnv?.value).toBe("http://task-store.svc:4000");
  });

  it("does not inject task-store env vars when taskStoreUrl is absent", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const env = d.spec.template.spec.containers[0].env ?? [];
    const names = env.map((e) => e.name);
    expect(names).not.toContain("SHIPWRIGHT_TASK_STORE_TOKEN");
    expect(names).not.toContain("SHIPWRIGHT_TASK_STORE_URL");
  });

  it("honours a custom taskStoreTokenSecretKey when provided", () => {
    const d = buildAgentDeploymentManifest({
      ...deployOpts,
      taskStoreUrl: "http://task-store.svc:4000",
      taskStoreTokenSecretKey: "my-ts-token",
    });
    const env = d.spec.template.spec.containers[0].env ?? [];
    const tokenEnv = env.find((e) => e.name === "SHIPWRIGHT_TASK_STORE_TOKEN");
    expect(tokenEnv?.valueFrom?.secretKeyRef?.key).toBe("my-ts-token");
  });

  it("places task-store env vars AFTER AGENT_HOME and BEFORE voice env vars", () => {
    const d = buildAgentDeploymentManifest({
      ...deployOpts,
      taskStoreUrl: "http://task-store.svc:4000",
      voice: { whisperServiceUrl: "http://w:9000" },
    });
    const names = (d.spec.template.spec.containers[0].env ?? []).map(
      (e) => e.name,
    );
    const agentHomeIdx = names.indexOf("AGENT_HOME");
    const tsTokenIdx = names.indexOf("SHIPWRIGHT_TASK_STORE_TOKEN");
    const tsUrlIdx = names.indexOf("SHIPWRIGHT_TASK_STORE_URL");
    const whisperIdx = names.indexOf("WHISPER_SERVICE_URL");

    expect(agentHomeIdx).toBeGreaterThanOrEqual(0);
    expect(tsTokenIdx).toBeGreaterThan(agentHomeIdx);
    expect(tsUrlIdx).toBeGreaterThan(agentHomeIdx);
    expect(whisperIdx).toBeGreaterThan(tsUrlIdx);
    expect(whisperIdx).toBeGreaterThan(tsTokenIdx);
  });
});

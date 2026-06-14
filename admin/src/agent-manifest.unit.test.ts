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
  type AgentSecretOpts,
  buildAgentDeploymentManifest,
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
  adminDeploymentName: "shipwright-admin",
  adminDeploymentUid: "11112222-3333-4444-5555-666677778888",
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

  it("defines a liveness probe on the health port 3459", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const probe = d.spec.template.spec.containers[0].livenessProbe;
    expect(AGENT_HEALTH_PORT).toBe(3459);
    expect(probe?.httpGet?.port).toBe(3459);
  });

  it("applies a hardened security context (fsGroup, runAsNonRoot, runAsUser)", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const podSpec = d.spec.template.spec;
    expect(podSpec.securityContext).toMatchObject({
      fsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
    });
    expect(podSpec.containers[0].securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
    });
  });

  it("sets an ownerReference to the admin Deployment for GC on uninstall", () => {
    const d = buildAgentDeploymentManifest(deployOpts);
    const refs = d.metadata.ownerReferences ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: "shipwright-admin",
      uid: "11112222-3333-4444-5555-666677778888",
      controller: true,
      blockOwnerDeletion: true,
    });
  });

  it("honours an explicit replicas override", () => {
    const d = buildAgentDeploymentManifest({ ...deployOpts, replicas: 0 });
    expect(d.spec.replicas).toBe(0);
  });
});

// ─── buildAgentSecretManifest ───────────────────────────────────────────────

describe("buildAgentSecretManifest", () => {
  const secretOpts: AgentSecretOpts = {
    name: "agent-42-token",
    namespace: "shipwright",
    token: "sw-agent-secret-token",
    tokenKey: "token",
    adminDeploymentName: "shipwright-admin",
    adminDeploymentUid: "11112222-3333-4444-5555-666677778888",
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

  it("carries an ownerReference to the admin Deployment", () => {
    const s = buildAgentSecretManifest(secretOpts);
    const refs = s.metadata.ownerReferences ?? [];
    expect(refs[0]).toMatchObject({
      kind: "Deployment",
      name: "shipwright-admin",
      uid: "11112222-3333-4444-5555-666677778888",
      controller: true,
    });
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

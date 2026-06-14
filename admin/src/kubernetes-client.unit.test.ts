/**
 * admin/src/kubernetes-client.unit.test.ts
 * Unit tests for the Kubernetes API client — pure URL/path building and
 * request-body shaping. No I/O, no DB, no network.
 */

import { describe, expect, it } from "bun:test";
import {
  deploymentBody,
  deploymentUrl,
  secretBody,
  secretUrl,
} from "./kubernetes-client.ts";

// ─── URL building: Deployments ──────────────────────────────────────────────

describe("deploymentUrl", () => {
  const api = "https://kubernetes.default.svc";

  it("builds a collection URL (create/list) with no name", () => {
    expect(deploymentUrl(api, "shipwright")).toBe(
      "https://kubernetes.default.svc/apis/apps/v1/namespaces/shipwright/deployments",
    );
  });

  it("builds a resource URL (get/delete) with a name", () => {
    expect(deploymentUrl(api, "shipwright", "agent-abc")).toBe(
      "https://kubernetes.default.svc/apis/apps/v1/namespaces/shipwright/deployments/agent-abc",
    );
  });

  it("strips a trailing slash from the api server", () => {
    expect(deploymentUrl("https://k8s.local/", "ns", "name")).toBe(
      "https://k8s.local/apis/apps/v1/namespaces/ns/deployments/name",
    );
  });
});

// ─── URL building: Secrets ──────────────────────────────────────────────────

describe("secretUrl", () => {
  const api = "https://kubernetes.default.svc";

  it("builds a collection URL (create/list) with no name", () => {
    expect(secretUrl(api, "shipwright")).toBe(
      "https://kubernetes.default.svc/api/v1/namespaces/shipwright/secrets",
    );
  });

  it("builds a resource URL (get/delete) with a name", () => {
    expect(secretUrl(api, "shipwright", "agent-secret")).toBe(
      "https://kubernetes.default.svc/api/v1/namespaces/shipwright/secrets/agent-secret",
    );
  });

  it("strips a trailing slash from the api server", () => {
    expect(secretUrl("https://k8s.local/", "ns", "name")).toBe(
      "https://k8s.local/api/v1/namespaces/ns/secrets/name",
    );
  });
});

// ─── Request body shaping: Deployments ──────────────────────────────────────

describe("deploymentBody", () => {
  it("shapes a Deployment manifest with apiVersion/kind and namespaced metadata", () => {
    const body = deploymentBody("shipwright", {
      name: "agent-abc",
      replicas: 1,
      image: "ghcr.io/example/agent:latest",
      labels: { app: "agent-abc" },
    });

    expect(body.apiVersion).toBe("apps/v1");
    expect(body.kind).toBe("Deployment");
    expect(body.metadata.name).toBe("agent-abc");
    expect(body.metadata.namespace).toBe("shipwright");
    expect(body.metadata.labels).toEqual({ app: "agent-abc" });
    expect(body.spec.replicas).toBe(1);
    expect(body.spec.selector.matchLabels).toEqual({ app: "agent-abc" });
    expect(body.spec.template.spec.containers[0]?.image).toBe(
      "ghcr.io/example/agent:latest",
    );
    expect(body.spec.template.spec.containers[0]?.name).toBe("agent-abc");
  });

  it("defaults replicas to 1 when omitted", () => {
    const body = deploymentBody("ns", {
      name: "x",
      image: "img:1",
    });
    expect(body.spec.replicas).toBe(1);
  });

  it("derives a default app label from the name when labels omitted", () => {
    const body = deploymentBody("ns", { name: "myagent", image: "img:1" });
    expect(body.metadata.labels).toEqual({ app: "myagent" });
    expect(body.spec.selector.matchLabels).toEqual({ app: "myagent" });
  });

  it("maps env entries into container env array", () => {
    const body = deploymentBody("ns", {
      name: "x",
      image: "img:1",
      env: { FOO: "bar", BAZ: "qux" },
    });
    expect(body.spec.template.spec.containers[0]?.env).toEqual([
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "qux" },
    ]);
  });
});

// ─── Request body shaping: Secrets ──────────────────────────────────────────

describe("secretBody", () => {
  it("shapes an Opaque Secret with base64-encoded data", () => {
    const body = secretBody("shipwright", {
      name: "agent-secret",
      stringData: { TOKEN: "s3cr3t", URL: "https://x" },
    });

    expect(body.apiVersion).toBe("v1");
    expect(body.kind).toBe("Secret");
    expect(body.type).toBe("Opaque");
    expect(body.metadata.name).toBe("agent-secret");
    expect(body.metadata.namespace).toBe("shipwright");
    // values are base64-encoded
    expect(body.data.TOKEN).toBe(Buffer.from("s3cr3t").toString("base64"));
    expect(body.data.URL).toBe(Buffer.from("https://x").toString("base64"));
  });

  it("produces empty data for an empty stringData map", () => {
    const body = secretBody("ns", { name: "empty", stringData: {} });
    expect(body.data).toEqual({});
  });
});

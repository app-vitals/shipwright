/**
 * admin/src/kubernetes-client.unit.test.ts
 * Unit tests for the Kubernetes API client — pure URL/path building and
 * request-body shaping. No I/O, no DB, no network.
 */

import { describe, expect, it } from "bun:test";
import {
  ConflictError,
  NotFoundError,
} from "./errors.ts";
import {
  HttpKubernetesClient,
  RecordedKubernetesClient,
  deploymentBody,
  deploymentUrl,
  pvcBody,
  pvcUrl,
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

// ─── URL building: PVCs ─────────────────────────────────────────────────────

describe("pvcUrl", () => {
  const api = "https://kubernetes.default.svc";

  it("builds a collection URL (create/list) with no name", () => {
    expect(pvcUrl(api, "shipwright")).toBe(
      "https://kubernetes.default.svc/api/v1/namespaces/shipwright/persistentvolumeclaims",
    );
  });

  it("builds a resource URL (get/delete) with a name", () => {
    expect(pvcUrl(api, "shipwright", "agent-abc-home")).toBe(
      "https://kubernetes.default.svc/api/v1/namespaces/shipwright/persistentvolumeclaims/agent-abc-home",
    );
  });

  it("strips a trailing slash from the api server", () => {
    expect(pvcUrl("https://k8s.local/", "ns", "name")).toBe(
      "https://k8s.local/api/v1/namespaces/ns/persistentvolumeclaims/name",
    );
  });
});

// ─── Request body shaping: PVCs ──────────────────────────────────────────────

describe("pvcBody", () => {
  it("shapes a PVC manifest with v1/PersistentVolumeClaim and ReadWriteOnce", () => {
    const body = pvcBody("shipwright", {
      name: "agent-abc-home",
      namespace: "shipwright",
      storageGi: 40,
    });

    expect(body.apiVersion).toBe("v1");
    expect(body.kind).toBe("PersistentVolumeClaim");
    expect(body.metadata.name).toBe("agent-abc-home");
    expect(body.metadata.namespace).toBe("shipwright");
    expect(body.spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(body.spec.resources.requests.storage).toBe("40Gi");
  });

  it("includes storageClassName when provided", () => {
    const body = pvcBody("shipwright", {
      name: "agent-abc-home",
      namespace: "shipwright",
      storageGi: 20,
      storageClassName: "standard",
    });

    expect(body.spec.storageClassName).toBe("standard");
  });

  it("omits storageClassName when not provided", () => {
    const body = pvcBody("shipwright", {
      name: "agent-abc-home",
      namespace: "shipwright",
      storageGi: 40,
    });

    expect(body.spec.storageClassName).toBeUndefined();
  });
});

// ─── RecordedKubernetesClient: PVC CRUD ──────────────────────────────────────

describe("RecordedKubernetesClient — PVCs", () => {
  it("createPvc records and returns the PVC", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {}, pvcs: {} });
    const created = await rec.createPvc("ns", {
      name: "agent-abc-home",
      namespace: "ns",
      storageGi: 40,
    });
    expect(created.metadata.name).toBe("agent-abc-home");
    expect(created.spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(created.spec.resources.requests.storage).toBe("40Gi");

    const fetched = await rec.getPvc("ns", "agent-abc-home");
    expect(fetched.metadata.name).toBe("agent-abc-home");
  });

  it("createPvc throws ConflictError on duplicate", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {}, pvcs: {} });
    await rec.createPvc("ns", { name: "dup", namespace: "ns", storageGi: 40 });
    await expect(
      rec.createPvc("ns", { name: "dup", namespace: "ns", storageGi: 40 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("getPvc throws NotFoundError for missing PVC", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {}, pvcs: {} });
    await expect(rec.getPvc("ns", "missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deletePvc removes the PVC", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {}, pvcs: {} });
    await rec.createPvc("ns", { name: "p", namespace: "ns", storageGi: 40 });
    await rec.deletePvc("ns", "p");
    await expect(rec.getPvc("ns", "p")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deletePvc throws NotFoundError for missing PVC", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {}, pvcs: {} });
    await expect(rec.deletePvc("ns", "missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("getPvc returns a pre-seeded PVC from the cassette", async () => {
    const seeded = {
      apiVersion: "v1" as const,
      kind: "PersistentVolumeClaim" as const,
      metadata: { name: "agent-abc-home", namespace: "shipwright" },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "40Gi" } },
      },
    };
    const rec = new RecordedKubernetesClient({
      deployments: {},
      secrets: {},
      pvcs: { "shipwright/agent-abc-home": seeded },
    });
    const fetched = await rec.getPvc("shipwright", "agent-abc-home");
    expect(fetched.metadata.name).toBe("agent-abc-home");
  });
});

// ─── HttpKubernetesClient: patchDeployment ───────────────────────────────────

describe("HttpKubernetesClient.patchDeployment()", () => {
  const apiServer = "https://kubernetes.default.svc";
  const namespace = "shipwright";
  const name = "agent-abc";
  const patch = {
    spec: {
      template: {
        spec: {
          containers: [{ name: "agent-abc", image: "ghcr.io/example/agent:v2" }],
        },
      },
    },
  };

  it("sends PATCH to deploymentUrl(apiServer, namespace, name)", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;

    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedMethod = init?.method;
      return new Response(null, { status: 200 });
    };

    const client = new HttpKubernetesClient({
      apiServer,
      token: "test-token",
      fetchFn: fetchFn as typeof fetch,
    });

    await client.patchDeployment(namespace, name, patch);

    expect(capturedUrl).toBe(deploymentUrl(apiServer, namespace, name));
    expect(capturedMethod).toBe("PATCH");
  });

  it("sends Content-Type: application/strategic-merge-patch+json", async () => {
    let capturedHeaders: HeadersInit | undefined;

    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(null, { status: 200 });
    };

    const client = new HttpKubernetesClient({
      apiServer,
      token: "test-token",
      fetchFn: fetchFn as typeof fetch,
    });

    await client.patchDeployment(namespace, name, patch);

    const headers = capturedHeaders as Record<string, string>;
    expect(headers["Content-Type"]).toBe(
      "application/strategic-merge-patch+json",
    );
  });

  it("sends the patch object as JSON body", async () => {
    let capturedBody: string | undefined;

    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(null, { status: 200 });
    };

    const client = new HttpKubernetesClient({
      apiServer,
      token: "test-token",
      fetchFn: fetchFn as typeof fetch,
    });

    await client.patchDeployment(namespace, name, patch);

    expect(capturedBody).toBe(JSON.stringify(patch));
  });

  it("throws NotFoundError on 404", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 });

    const client = new HttpKubernetesClient({
      apiServer,
      token: "test-token",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(
      client.patchDeployment(namespace, name, patch),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ─── RecordedKubernetesClient: patchDeployment ───────────────────────────────

describe("RecordedKubernetesClient.patchDeployment()", () => {
  const makeDeployment = (image: string) => ({
    apiVersion: "apps/v1" as const,
    kind: "Deployment" as const,
    metadata: { name: "agent-abc", namespace: "shipwright" },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "agent-abc" } },
      template: {
        metadata: { labels: { app: "agent-abc" } },
        spec: {
          containers: [{ name: "agent-abc", image }],
        },
      },
    },
  });

  it("updates containers[0].image from the patch payload", async () => {
    const rec = new RecordedKubernetesClient({
      deployments: { "shipwright/agent-abc": makeDeployment("ghcr.io/example/agent:v1") },
      secrets: {},
    });

    await rec.patchDeployment("shipwright", "agent-abc", {
      spec: {
        template: {
          spec: {
            containers: [{ name: "agent-abc", image: "ghcr.io/example/agent:v2" }],
          },
        },
      },
    });

    const dep = await rec.getDeployment("shipwright", "agent-abc");
    expect(dep.spec.template.spec.containers[0]?.image).toBe(
      "ghcr.io/example/agent:v2",
    );
  });

  it("throws NotFoundError when the deployment does not exist", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {} });

    await expect(
      rec.patchDeployment("shipwright", "agent-abc", {
        spec: {
          template: {
            spec: {
              containers: [{ name: "agent-abc", image: "ghcr.io/example/agent:v2" }],
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
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

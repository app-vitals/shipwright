/**
 * admin/src/kubernetes-client.integration.test.ts
 * Integration tests for HttpKubernetesClient against recorded k8s API fixtures.
 *
 * Drives the client through an INJECTED fetchFn that replays canned Responses
 * from a cassette keyed by scenario — no live API server, no global.fetch
 * override, no mock.module(). Also exercises RecordedKubernetesClient (the
 * exported in-memory double).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./errors.ts";
import {
  HttpKubernetesClient,
  type KubernetesClient,
  type KubernetesDeployment,
  type KubernetesPvc,
  RecordedKubernetesClient,
} from "./kubernetes-client.ts";

// ─── Cassette ───────────────────────────────────────────────────────────────

interface CassetteEntry {
  status: number;
  body: unknown;
}

const CASSETTE_PATH = new URL("./fixtures/k8s-cassette.json", import.meta.url)
  .pathname;

const cassette: Record<string, CassetteEntry> = JSON.parse(
  readFileSync(CASSETTE_PATH, "utf-8"),
);

interface RecordedRequest {
  url: string;
  method: string;
  auth?: string;
  tls?: { ca?: string };
}

/**
 * Build an injected fetchFn that returns the cassette entry for `key`.
 * Records the last request so tests can assert URL/method/headers/tls.
 */
function cassetteFetch(key: string): {
  fetchFn: typeof fetch;
  lastRequest: () => RecordedRequest;
} {
  let last: RecordedRequest | undefined;
  const entry = cassette[key];
  if (!entry) throw new Error(`cassette key not found: ${key}`);

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    last = {
      url,
      method: init?.method ?? "GET",
      auth: headers.get("authorization") ?? undefined,
      tls: (init as (RequestInit & { tls?: { ca?: string } }) | undefined)?.tls,
    };
    // A string body is replayed verbatim (e.g. an HTML proxy error page) so the
    // client sees genuinely non-JSON bytes; objects are JSON-encoded.
    const isRaw = typeof entry.body === "string";
    return new Response(
      isRaw ? (entry.body as string) : JSON.stringify(entry.body),
      {
        status: entry.status,
        headers: {
          "Content-Type": isRaw ? "text/html" : "application/json",
        },
      },
    );
  }) as typeof fetch;

  return {
    fetchFn,
    lastRequest: () => {
      if (!last) throw new Error("fetchFn was not called");
      return last;
    },
  };
}

function makeClient(key: string): {
  client: HttpKubernetesClient;
  lastRequest: () => RecordedRequest;
} {
  const { fetchFn, lastRequest } = cassetteFetch(key);
  const client = new HttpKubernetesClient({
    apiServer: "https://kubernetes.default.svc",
    token: "test-sa-token",
    fetchFn,
  });
  return { client, lastRequest };
}

// ─── Deployments: success paths ─────────────────────────────────────────────

describe("HttpKubernetesClient — Deployments", () => {
  it("createDeployment POSTs to the deployments collection with Bearer auth", async () => {
    const { client, lastRequest } = makeClient("createDeployment_success");
    const result = await client.createDeployment("shipwright", {
      name: "agent-abc",
      image: "ghcr.io/example/agent:latest",
    });

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(
      "https://kubernetes.default.svc/apis/apps/v1/namespaces/shipwright/deployments",
    );
    expect(req.auth).toBe("Bearer test-sa-token");
    expect(result.metadata.name).toBe("agent-abc");
    expect(result.metadata.namespace).toBe("shipwright");
  });

  it("getDeployment GETs the named resource and returns it", async () => {
    const { client, lastRequest } = makeClient("getDeployment_success");
    const result = await client.getDeployment("shipwright", "agent-abc");

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      "https://kubernetes.default.svc/apis/apps/v1/namespaces/shipwright/deployments/agent-abc",
    );
    expect(result.metadata.name).toBe("agent-abc");
  });

  it("deleteDeployment DELETEs the named resource", async () => {
    const { client, lastRequest } = makeClient("deleteDeployment_success");
    await client.deleteDeployment("shipwright", "agent-abc");

    const req = lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(
      "https://kubernetes.default.svc/apis/apps/v1/namespaces/shipwright/deployments/agent-abc",
    );
  });
});

// ─── Deployments: error paths ───────────────────────────────────────────────

describe("HttpKubernetesClient — Deployment errors", () => {
  it("maps 404 to NotFoundError", async () => {
    const { client } = makeClient("getDeployment_404");
    await expect(
      client.getDeployment("shipwright", "missing"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps 409 to ConflictError", async () => {
    const { client } = makeClient("createDeployment_409");
    await expect(
      client.createDeployment("shipwright", {
        name: "agent-abc",
        image: "img:1",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("maps 403 to ForbiddenError", async () => {
    const { client } = makeClient("createDeployment_403");
    await expect(
      client.createDeployment("shipwright", {
        name: "agent-abc",
        image: "img:1",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("maps 401 to UnauthorizedError", async () => {
    const { client } = makeClient("getDeployment_401");
    await expect(
      client.getDeployment("shipwright", "agent-abc"),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("maps a non-2xx non-JSON body (HTML 502) to a typed ApiError, not a SyntaxError", async () => {
    const { client } = makeClient("getDeployment_502_html");
    const err = await client
      .getDeployment("shipwright", "agent-abc")
      .then(() => undefined)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as ApiError).statusCode).toBe(502);
  });

  it("surfaces the k8s Status message in the error", async () => {
    const { client } = makeClient("getDeployment_404");
    await expect(client.getDeployment("shipwright", "missing")).rejects.toThrow(
      /not found/,
    );
  });
});

// ─── Secrets: success + error paths ─────────────────────────────────────────

describe("HttpKubernetesClient — Secrets", () => {
  it("createSecret POSTs to the secrets collection", async () => {
    const { client, lastRequest } = makeClient("createSecret_success");
    const result = await client.createSecret("shipwright", {
      name: "agent-secret",
      stringData: { TOKEN: "s3cr3t" },
    });

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(
      "https://kubernetes.default.svc/api/v1/namespaces/shipwright/secrets",
    );
    expect(result.metadata.name).toBe("agent-secret");
  });

  it("getSecret GETs the named resource", async () => {
    const { client, lastRequest } = makeClient("getSecret_success");
    const result = await client.getSecret("shipwright", "agent-secret");

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      "https://kubernetes.default.svc/api/v1/namespaces/shipwright/secrets/agent-secret",
    );
    expect(result.metadata.name).toBe("agent-secret");
  });

  it("getSecret maps 404 to NotFoundError", async () => {
    const { client } = makeClient("getSecret_404");
    await expect(
      client.getSecret("shipwright", "missing"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("createSecret maps 409 to ConflictError", async () => {
    const { client } = makeClient("createSecret_409");
    await expect(
      client.createSecret("shipwright", {
        name: "agent-secret",
        stringData: { TOKEN: "s3cr3t" },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("createSecret maps 403 to ForbiddenError", async () => {
    const { client } = makeClient("createSecret_403");
    await expect(
      client.createSecret("shipwright", {
        name: "agent-secret",
        stringData: { TOKEN: "s3cr3t" },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("deleteSecret DELETEs the named resource", async () => {
    const { client, lastRequest } = makeClient("deleteSecret_success");
    await client.deleteSecret("shipwright", "agent-secret");

    const req = lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(
      "https://kubernetes.default.svc/api/v1/namespaces/shipwright/secrets/agent-secret",
    );
  });
});

// ─── In-cluster CA → outbound TLS ───────────────────────────────────────────

describe("HttpKubernetesClient — in-cluster CA", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies an injected caCert to the outbound request via tls.ca", async () => {
    const ca =
      "-----BEGIN CERTIFICATE-----\nINJECTED-CA\n-----END CERTIFICATE-----";
    const { fetchFn, lastRequest } = cassetteFetch("getDeployment_success");
    const client = new HttpKubernetesClient({
      apiServer: "https://kubernetes.default.svc",
      token: "test-sa-token",
      caCert: ca,
      fetchFn,
    });

    await client.getDeployment("shipwright", "agent-abc");
    expect(lastRequest().tls?.ca).toBe(ca);
  });

  it("reads the CA from caPath and applies it to outbound TLS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "k8s-ca-"));
    tempDirs.push(dir);
    const caPath = join(dir, "ca.crt");
    const ca =
      "-----BEGIN CERTIFICATE-----\nFILE-CA\n-----END CERTIFICATE-----";
    writeFileSync(caPath, ca);

    const { fetchFn, lastRequest } = cassetteFetch("getDeployment_success");
    const client = new HttpKubernetesClient({
      apiServer: "https://kubernetes.default.svc",
      token: "test-sa-token",
      caPath,
      fetchFn,
    });

    await client.getDeployment("shipwright", "agent-abc");
    expect(lastRequest().tls?.ca).toBe(ca);
  });

  it("omits the tls key (system-CA fallback) without throwing when the DEFAULT CA path is missing", async () => {
    // No caPath/caCert → the default in-cluster SA path is derived from an
    // injected `saDir` pointing at a freshly-created, guaranteed-empty temp
    // dir (never populated with a ca.crt) — deterministic regardless of what
    // the sandbox's real filesystem happens to have mounted at the actual
    // in-cluster SA path. Best-effort: degrade to system CAs (warns to
    // stderr) rather than throwing, so construction succeeds.
    const emptyDir = mkdtempSync(join(tmpdir(), "k8s-no-default-ca-"));
    tempDirs.push(emptyDir);

    const { fetchFn, lastRequest } = cassetteFetch("getDeployment_success");
    const client = new HttpKubernetesClient({
      apiServer: "https://kubernetes.default.svc",
      token: "test-sa-token",
      saDir: emptyDir,
      fetchFn,
    });

    await client.getDeployment("shipwright", "agent-abc");
    expect(lastRequest().tls).toBeUndefined();
  });

  it("throws when an EXPLICIT caPath is provided but the file is missing", () => {
    const missingCaPath = join(
      mkdtempSync(join(tmpdir(), "k8s-noca-")),
      "absent-ca.crt",
    );
    tempDirs.push(missingCaPath.slice(0, missingCaPath.lastIndexOf("/")));

    expect(
      () =>
        new HttpKubernetesClient({
          apiServer: "https://kubernetes.default.svc",
          token: "test-sa-token",
          caPath: missingCaPath,
        }),
    ).toThrow(/CA file read failed at explicit caPath/);
  });
});

// ─── Per-request token read (rotation) ──────────────────────────────────────

describe("HttpKubernetesClient — token rotation", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-reads the token from tokenPath on each request (picks up rotation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "k8s-token-"));
    tempDirs.push(dir);
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "token-v1\n");

    const { fetchFn, lastRequest } = cassetteFetch("getDeployment_success");
    const client = new HttpKubernetesClient({
      apiServer: "https://kubernetes.default.svc",
      tokenPath,
      fetchFn,
    });

    await client.getDeployment("shipwright", "agent-abc");
    expect(lastRequest().auth).toBe("Bearer token-v1");

    // Simulate projected-token rotation on disk.
    writeFileSync(tokenPath, "token-v2\n");
    await client.getDeployment("shipwright", "agent-abc");
    expect(lastRequest().auth).toBe("Bearer token-v2");
  });

  it("uses a fixed injected token without reading from disk", async () => {
    const { fetchFn, lastRequest } = cassetteFetch("getDeployment_success");
    const client = new HttpKubernetesClient({
      apiServer: "https://kubernetes.default.svc",
      token: "fixed-token",
      fetchFn,
    });

    await client.getDeployment("shipwright", "agent-abc");
    expect(lastRequest().auth).toBe("Bearer fixed-token");
  });
});

// ─── PVCs: success + error paths ────────────────────────────────────────────

describe("HttpKubernetesClient — PVCs", () => {
  it("createPvc POSTs to the persistentvolumeclaims collection", async () => {
    const { client, lastRequest } = makeClient("createPvc_success");
    const result = await client.createPvc("shipwright", {
      name: "agent-abc-home",
      namespace: "shipwright",
      storageGi: 40,
    });

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(
      "https://kubernetes.default.svc/api/v1/namespaces/shipwright/persistentvolumeclaims",
    );
    expect(req.auth).toBe("Bearer test-sa-token");
    expect(result.metadata.name).toBe("agent-abc-home");
  });

  it("getPvc GETs the named resource", async () => {
    const { client, lastRequest } = makeClient("getPvc_success");
    const result = await client.getPvc("shipwright", "agent-abc-home");

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      "https://kubernetes.default.svc/api/v1/namespaces/shipwright/persistentvolumeclaims/agent-abc-home",
    );
    expect(result.metadata.name).toBe("agent-abc-home");
  });

  it("deletePvc DELETEs the named resource", async () => {
    const { client, lastRequest } = makeClient("deletePvc_success");
    await client.deletePvc("shipwright", "agent-abc-home");

    const req = lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(
      "https://kubernetes.default.svc/api/v1/namespaces/shipwright/persistentvolumeclaims/agent-abc-home",
    );
  });

  it("createPvc maps 409 to ConflictError", async () => {
    const { client } = makeClient("createPvc_409");
    await expect(
      client.createPvc("shipwright", {
        name: "agent-abc-home",
        namespace: "shipwright",
        storageGi: 40,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("getPvc maps 404 to NotFoundError", async () => {
    const { client } = makeClient("getPvc_404");
    await expect(client.getPvc("shipwright", "missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

// ─── Deployments: listDeployments + deploymentExists ──────────────────────────

describe("HttpKubernetesClient — listDeployments", () => {
  it("listDeployments() returns array of names from items", async () => {
    const { client, lastRequest } = makeClient("listDeployments_success");
    const names = await client.listDeployments("shipwright");

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      "https://kubernetes.default.svc/apis/apps/v1/namespaces/shipwright/deployments",
    );
    expect(names).toEqual(["agent-abc123", "agent-def456"]);
  });

  it("listDeployments() with labelSelector passes ?labelSelector=... in URL", async () => {
    const { client, lastRequest } = makeClient("listDeployments_success");
    const labelSelector =
      "app.kubernetes.io/name=shipwright-agent,app.kubernetes.io/managed-by=shipwright-admin";
    await client.listDeployments("shipwright", labelSelector);

    const req = lastRequest();
    expect(req.url).toContain(
      `?labelSelector=${encodeURIComponent(labelSelector)}`,
    );
  });

  it("listDeployments() returns [] for an empty list", async () => {
    const { client } = makeClient("listDeployments_empty");
    const names = await client.listDeployments("shipwright");
    expect(names).toEqual([]);
  });
});

describe("HttpKubernetesClient — deploymentExists", () => {
  it("deploymentExists() returns true when the deployment is found", async () => {
    const { client } = makeClient("deploymentExists_true");
    const exists = await client.deploymentExists("shipwright", "agent-abc123");
    expect(exists).toBe(true);
  });

  it("deploymentExists() returns false when the deployment is not found (404)", async () => {
    const { client } = makeClient("deploymentExists_false");
    const exists = await client.deploymentExists("shipwright", "agent-abc123");
    expect(exists).toBe(false);
  });
});

// ─── RecordedKubernetesClient (in-memory double) ────────────────────────────

describe("RecordedKubernetesClient", () => {
  const client: KubernetesClient = new RecordedKubernetesClient({
    deployments: {
      "shipwright/agent-abc": cassette.getDeployment_success?.body as never,
    },
    secrets: {
      "shipwright/agent-secret": cassette.getSecret_success?.body as never,
    },
    pvcs: {
      "shipwright/agent-abc-home": cassette.getPvc_success?.body as never,
    },
  });

  it("getDeployment returns the canned resource", async () => {
    const dep = await client.getDeployment("shipwright", "agent-abc");
    expect(dep.metadata.name).toBe("agent-abc");
  });

  it("getDeployment throws NotFoundError for an unknown resource", async () => {
    await expect(
      client.getDeployment("shipwright", "nope"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("createDeployment records and returns the resource", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {} });
    const created = await rec.createDeployment("ns", {
      name: "new-dep",
      image: "img:1",
    });
    expect(created.metadata.name).toBe("new-dep");
    const fetched = await rec.getDeployment("ns", "new-dep");
    expect(fetched.metadata.name).toBe("new-dep");
  });

  it("createDeployment throws ConflictError on duplicate", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {} });
    await rec.createDeployment("ns", { name: "dup", image: "img:1" });
    await expect(
      rec.createDeployment("ns", { name: "dup", image: "img:1" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("deleteDeployment removes the resource", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {} });
    await rec.createDeployment("ns", { name: "d", image: "img:1" });
    await rec.deleteDeployment("ns", "d");
    await expect(rec.getDeployment("ns", "d")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("getSecret returns the canned secret", async () => {
    const sec = await client.getSecret("shipwright", "agent-secret");
    expect(sec.metadata.name).toBe("agent-secret");
  });

  it("createSecret / deleteSecret round-trip", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {} });
    await rec.createSecret("ns", { name: "s", stringData: { K: "v" } });
    const got = await rec.getSecret("ns", "s");
    expect(got.metadata.name).toBe("s");
    await rec.deleteSecret("ns", "s");
    await expect(rec.getSecret("ns", "s")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("deploymentExists() returns true for a seeded deployment", async () => {
    const rec = new RecordedKubernetesClient({
      deployments: {
        "shipwright/agent-abc": cassette.getDeployment_success?.body as never,
      },
      secrets: {},
    });
    expect(await rec.deploymentExists("shipwright", "agent-abc")).toBe(true);
  });

  it("deploymentExists() returns false for an absent deployment", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {} });
    expect(await rec.deploymentExists("shipwright", "agent-missing")).toBe(
      false,
    );
  });

  it("listDeployments() returns names from seeded deployments in the namespace", async () => {
    const baseDeployment = cassette.getDeployment_success
      ?.body as KubernetesDeployment;
    const rec = new RecordedKubernetesClient({
      deployments: {
        "shipwright/agent-abc": baseDeployment,
        "shipwright/agent-def": {
          ...baseDeployment,
          metadata: {
            ...baseDeployment.metadata,
            name: "agent-def",
            namespace: "shipwright",
          },
        },
        "other-ns/agent-xyz": {
          ...baseDeployment,
          metadata: {
            ...baseDeployment.metadata,
            name: "agent-xyz",
            namespace: "other-ns",
          },
        },
      },
      secrets: {},
    });
    const names = await rec.listDeployments("shipwright");
    expect(names.sort()).toEqual(["agent-abc", "agent-def"]);
  });

  it("listDeployments() returns [] when namespace has no deployments", async () => {
    const rec = new RecordedKubernetesClient({ deployments: {}, secrets: {} });
    expect(await rec.listDeployments("shipwright")).toEqual([]);
  });
});

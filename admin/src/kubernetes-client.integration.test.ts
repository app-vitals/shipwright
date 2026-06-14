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
import { ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
import {
  HttpKubernetesClient,
  type KubernetesClient,
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
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "Content-Type": "application/json" },
    });
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

  it("omits the tls key entirely when no CA is provided or found", async () => {
    const missingCaPath = join(
      mkdtempSync(join(tmpdir(), "k8s-noca-")),
      "absent-ca.crt",
    );
    tempDirs.push(missingCaPath.slice(0, missingCaPath.lastIndexOf("/")));

    const { fetchFn, lastRequest } = cassetteFetch("getDeployment_success");
    const client = new HttpKubernetesClient({
      apiServer: "https://kubernetes.default.svc",
      token: "test-sa-token",
      caPath: missingCaPath,
      fetchFn,
    });

    await client.getDeployment("shipwright", "agent-abc");
    expect(lastRequest().tls).toBeUndefined();
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
});

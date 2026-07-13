/**
 * admin/src/kubernetes-client.ts
 *
 * A thin first-party Kubernetes API client. Authenticates to the in-cluster API
 * server using the mounted ServiceAccount Bearer token, and supports
 * namespace-scoped create/get/delete of Deployments and Secrets.
 *
 * No `@kubernetes/client-node` dependency — native fetch only. The HTTP client
 * takes an injected `fetchFn` (defaulting to the global `fetch`) so tests can
 * feed recorded Responses WITHOUT overriding any global.
 *
 * Exports:
 *  - KubernetesClient        — interface for DI (used by callers and tests)
 *  - HttpKubernetesClient    — production impl, talks to the API server
 *  - RecordedKubernetesClient — in-memory cassette double for tests
 *  - deploymentUrl / secretUrl / deploymentBody / secretBody — pure helpers
 *
 * Non-2xx API responses map to the shared typed errors in ./errors.ts:
 *   401 → UnauthorizedError, 403 → ForbiddenError, 404 → NotFoundError,
 *   409 → ConflictError, other → ApiError (with the status code).
 */

import { readFileSync } from "node:fs";
import {
  ApiError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./errors.ts";

// ─── Resource specs (caller-facing inputs) ──────────────────────────────────

export interface DeploymentSpec {
  name: string;
  image: string;
  /** Defaults to 1. */
  replicas?: number;
  /** Defaults to `{ app: <name> }`. */
  labels?: Record<string, string>;
  /** Container environment variables (plain values). */
  env?: Record<string, string>;
  /**
   * Additional env vars expressed as full `KubernetesEnvVar` objects. Supports
   * `valueFrom` entries (e.g. `secretKeyRef`) that cannot be expressed in the
   * plain `env` map. Merged after the `env` entries in the container spec.
   */
  envVars?: KubernetesEnvVar[];
}

export interface SecretSpec {
  name: string;
  /** Plain string values; encoded to base64 `data` on the wire. */
  stringData: Record<string, string>;
}

// ─── Resource bodies (k8s wire shapes) ──────────────────────────────────────

/** A single container env var: either a literal value or a `valueFrom` source. */
export interface KubernetesEnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string };
    configMapKeyRef?: { name: string; key: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface KubernetesContainer {
  name: string;
  image: string;
  env?: KubernetesEnvVar[];
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  volumeMounts?: Array<{
    name: string;
    mountPath: string;
    [key: string]: unknown;
  }>;
  startupProbe?: {
    httpGet?: { path?: string; port: number | string; [key: string]: unknown };
    [key: string]: unknown;
  };
  livenessProbe?: {
    httpGet?: { path?: string; port: number | string; [key: string]: unknown };
    [key: string]: unknown;
  };
  readinessProbe?: {
    httpGet?: { path?: string; port: number | string; [key: string]: unknown };
    [key: string]: unknown;
  };
  securityContext?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface KubernetesDeployment {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    ownerReferences?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  spec: {
    replicas: number;
    strategy?: { type: string; [key: string]: unknown };
    selector: { matchLabels: Record<string, string> };
    template: {
      metadata: { labels: Record<string, string> };
      spec: {
        containers: KubernetesContainer[];
        volumes?: Array<{
          name: string;
          persistentVolumeClaim?: { claimName: string };
          [key: string]: unknown;
        }>;
        securityContext?: Record<string, unknown>;
        [key: string]: unknown;
      };
    };
  };
  [key: string]: unknown;
}

export interface KubernetesSecret {
  apiVersion: string;
  kind: string;
  type: string;
  metadata: {
    name: string;
    namespace: string;
    ownerReferences?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  data: Record<string, string>;
  [key: string]: unknown;
}

export interface PvcSpec {
  name: string;
  namespace: string;
  storageGi: number;
  storageClassName?: string;
}

export interface KubernetesPvc {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    ownerReferences?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  spec: {
    accessModes: string[];
    resources: { requests: { storage: string } };
    storageClassName?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── Interface ──────────────────────────────────────────────────────────────

export interface KubernetesClient {
  createDeployment(
    namespace: string,
    spec: DeploymentSpec,
  ): Promise<KubernetesDeployment>;
  /**
   * Submit a full KubernetesDeployment manifest to the API server. Unlike
   * createDeployment(), this method POSTs the manifest as-is — volumes,
   * securityContext, ownerReferences, strategy, etc. are all preserved.
   * Use this when the manifest is already fully shaped (e.g. via
   * buildAgentDeploymentManifest()); use createDeployment() for simple
   * ad-hoc deployments expressed as a DeploymentSpec.
   */
  createDeploymentManifest(
    namespace: string,
    manifest: KubernetesDeployment,
  ): Promise<KubernetesDeployment>;
  getDeployment(namespace: string, name: string): Promise<KubernetesDeployment>;
  /** Returns true if the deployment exists, false if 404, throws on other errors. */
  deploymentExists(namespace: string, name: string): Promise<boolean>;
  /**
   * Lists deployments in a namespace, optionally filtered by a label selector.
   * Returns an array of deployment names (metadata.name).
   */
  listDeployments(namespace: string, labelSelector?: string): Promise<string[]>;
  deleteDeployment(namespace: string, name: string): Promise<void>;
  createSecret(namespace: string, spec: SecretSpec): Promise<KubernetesSecret>;
  getSecret(namespace: string, name: string): Promise<KubernetesSecret>;
  deleteSecret(namespace: string, name: string): Promise<void>;
  createPvc(namespace: string, spec: PvcSpec): Promise<KubernetesPvc>;
  getPvc(namespace: string, name: string): Promise<KubernetesPvc>;
  deletePvc(namespace: string, name: string): Promise<void>;
  /**
   * Apply a strategic merge patch to a named Deployment. The patch object is
   * JSON-serialized and sent with Content-Type application/strategic-merge-patch+json.
   * Typical use: update containers[0].image for a rolling restart.
   */
  patchDeployment(
    namespace: string,
    name: string,
    patch: object,
  ): Promise<void>;
}

// ─── Pure URL builders ────────────────────────────────────────────────────────

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/** `/apis/apps/v1/namespaces/{ns}/deployments[/{name}]` */
export function deploymentUrl(
  apiServer: string,
  namespace: string,
  name?: string,
): string {
  const base = `${trimTrailingSlash(apiServer)}/apis/apps/v1/namespaces/${namespace}/deployments`;
  return name ? `${base}/${name}` : base;
}

/** `/api/v1/namespaces/{ns}/secrets[/{name}]` */
export function secretUrl(
  apiServer: string,
  namespace: string,
  name?: string,
): string {
  const base = `${trimTrailingSlash(apiServer)}/api/v1/namespaces/${namespace}/secrets`;
  return name ? `${base}/${name}` : base;
}

/** `/api/v1/namespaces/{ns}/persistentvolumeclaims[/{name}]` */
export function pvcUrl(
  apiServer: string,
  namespace: string,
  name?: string,
): string {
  const base = `${trimTrailingSlash(apiServer)}/api/v1/namespaces/${namespace}/persistentvolumeclaims`;
  return name ? `${base}/${name}` : base;
}

// ─── Pure body shapers ────────────────────────────────────────────────────────

export function deploymentBody(
  namespace: string,
  spec: DeploymentSpec,
): KubernetesDeployment {
  const labels = spec.labels ?? { app: spec.name };
  const plainEnv: KubernetesEnvVar[] = spec.env
    ? Object.entries(spec.env).map(([name, value]) => ({ name, value }))
    : [];
  const env: KubernetesEnvVar[] | undefined =
    plainEnv.length > 0 || (spec.envVars && spec.envVars.length > 0)
      ? [...plainEnv, ...(spec.envVars ?? [])]
      : undefined;

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: spec.name,
      namespace,
      labels,
    },
    spec: {
      replicas: spec.replicas ?? 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: spec.name,
              image: spec.image,
              ...(env ? { env } : {}),
            },
          ],
        },
      },
    },
  };
}

export function secretBody(
  namespace: string,
  spec: SecretSpec,
): KubernetesSecret {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.stringData)) {
    data[key] = Buffer.from(value).toString("base64");
  }

  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: { name: spec.name, namespace },
    data,
  };
}

export function pvcBody(namespace: string, spec: PvcSpec): KubernetesPvc {
  const body: KubernetesPvc = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: spec.name, namespace },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: `${spec.storageGi}Gi` } },
    },
  };
  if (spec.storageClassName !== undefined) {
    body.spec.storageClassName = spec.storageClassName;
  }
  return body;
}

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * Read the in-cluster CA cert (PEM). When the caller passed an EXPLICIT
 * `caPath`, a read failure THROWS — a caller who named a path expects it to
 * exist, and silently falling back to system CAs would surface as an opaque
 * TLS verification error later. For the default SA path, reading is
 * best-effort: a missing file warns and yields `undefined` rather than
 * crashing client construction.
 */
function readCa(caPath?: string): string | undefined {
  const explicit = caPath !== undefined;
  const path = caPath ?? `${SA_DIR}/ca.crt`;
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if (explicit) {
      throw new Error(
        `[kubernetes-client] CA file read failed at explicit caPath "${path}": ${String(err)}`,
      );
    }
    console.warn(
      "[kubernetes-client] CA file read failed, falling back to system CAs:",
      err,
    );
    return undefined;
  }
}

function defaultApiServer(): string {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (host) {
    return `https://${host}:${port ?? "443"}`;
  }
  return "https://kubernetes.default.svc";
}

// ─── Error mapping ────────────────────────────────────────────────────────────

interface K8sStatus {
  message?: string;
  reason?: string;
  code?: number;
}

function mapError(status: number, body: unknown): ApiError {
  const message =
    (body as K8sStatus | undefined)?.message ??
    `Kubernetes API error ${status}`;
  switch (status) {
    case 401:
      return new UnauthorizedError(message);
    case 403:
      return new ForbiddenError(message);
    case 404:
      return new NotFoundError(message);
    case 409:
      return new ConflictError(message);
    default:
      return new ApiError(status, message);
  }
}

// ─── HTTP implementation ──────────────────────────────────────────────────────

export interface HttpKubernetesClientOpts {
  /** Defaults to KUBERNETES_SERVICE_HOST/PORT or https://kubernetes.default.svc. */
  apiServer?: string;
  /** ServiceAccount Bearer token. If omitted, read from `tokenPath`. */
  token?: string;
  /** Path to the mounted SA token (used only when `token` is omitted). */
  tokenPath?: string;
  /** In-cluster CA cert (PEM). If omitted, read best-effort from `caPath`. */
  caCert?: string;
  /**
   * Path to the mounted CA cert (used only when `caCert` is omitted). The CA is
   * read and applied to outbound TLS so HTTPS to the API server verifies against
   * the cluster's self-signed cert. When `caPath` is provided explicitly, a
   * read failure THROWS (a named path is expected to exist); the default SA path
   * is best-effort and warns + degrades to system CAs on failure.
   */
  caPath?: string;
  /** Injected fetch — defaults to the global `fetch`. Never overrides the global. */
  fetchFn?: typeof fetch;
}

/** RequestInit plus Bun's `tls` option (not in the standard DOM types). */
type RequestInitWithTls = RequestInit & { tls?: { ca?: string } };

export class HttpKubernetesClient implements KubernetesClient {
  private readonly apiServer: string;
  /** Fixed token (test injection). When undefined, read per-request from disk. */
  private readonly token?: string;
  private readonly tokenPath: string;
  private readonly caCert?: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts?: HttpKubernetesClientOpts) {
    this.apiServer = opts?.apiServer ?? defaultApiServer();
    this.token = opts?.token;
    this.tokenPath = opts?.tokenPath ?? `${SA_DIR}/token`;
    this.caCert = opts?.caCert ?? readCa(opts?.caPath);
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

  /**
   * Resolve the current Bearer token. An explicitly injected `token` is fixed;
   * otherwise the token is read from disk per request so that projected
   * ServiceAccount token rotation (~hourly) is picked up without a pod restart.
   */
  private readToken(): string {
    if (this.token !== undefined) return this.token;
    return readFileSync(this.tokenPath, "utf-8").trim();
  }

  private authHeaders(extra?: Record<string, string>): HeadersInit {
    return {
      Authorization: `Bearer ${this.readToken()}`,
      ...extra,
    };
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const finalInit: RequestInitWithTls = this.caCert
      ? { ...init, tls: { ca: this.caCert } }
      : init;
    const resp = await this.fetchFn(url, finalInit as RequestInit);
    const text = await resp.text();
    // Guard parse: proxy 502s / HTML error pages aren't JSON. A parse failure
    // yields `undefined` so non-2xx still maps to a typed error (mapError has a
    // status fallback) and 2xx non-JSON returns the existing empty-body path.
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!resp.ok) {
      throw mapError(resp.status, body);
    }
    return body as T;
  }

  async createDeployment(
    namespace: string,
    spec: DeploymentSpec,
  ): Promise<KubernetesDeployment> {
    return this.request<KubernetesDeployment>(
      deploymentUrl(this.apiServer, namespace),
      {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(deploymentBody(namespace, spec)),
      },
    );
  }

  async createDeploymentManifest(
    namespace: string,
    manifest: KubernetesDeployment,
  ): Promise<KubernetesDeployment> {
    return this.request<KubernetesDeployment>(
      deploymentUrl(this.apiServer, namespace),
      {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(manifest),
      },
    );
  }

  async getDeployment(
    namespace: string,
    name: string,
  ): Promise<KubernetesDeployment> {
    return this.request<KubernetesDeployment>(
      deploymentUrl(this.apiServer, namespace, name),
      { method: "GET", headers: this.authHeaders() },
    );
  }

  async deploymentExists(namespace: string, name: string): Promise<boolean> {
    try {
      await this.getDeployment(namespace, name);
      return true;
    } catch (err) {
      if (err instanceof NotFoundError) return false;
      throw err;
    }
  }

  async listDeployments(
    namespace: string,
    labelSelector?: string,
  ): Promise<string[]> {
    const base = deploymentUrl(this.apiServer, namespace);
    const url = labelSelector
      ? `${base}?labelSelector=${encodeURIComponent(labelSelector)}`
      : base;
    const response = await this.request<{
      items: Array<{ metadata: { name: string } }>;
    }>(url, { method: "GET", headers: this.authHeaders() });
    return response.items.map((item) => item.metadata.name);
  }

  async deleteDeployment(namespace: string, name: string): Promise<void> {
    await this.request<unknown>(
      deploymentUrl(this.apiServer, namespace, name),
      { method: "DELETE", headers: this.authHeaders() },
    );
  }

  async patchDeployment(
    namespace: string,
    name: string,
    patch: object,
  ): Promise<void> {
    await this.request<void>(deploymentUrl(this.apiServer, namespace, name), {
      method: "PATCH",
      headers: this.authHeaders({
        "Content-Type": "application/strategic-merge-patch+json",
      }),
      body: JSON.stringify(patch),
    });
  }

  async createSecret(
    namespace: string,
    spec: SecretSpec,
  ): Promise<KubernetesSecret> {
    return this.request<KubernetesSecret>(
      secretUrl(this.apiServer, namespace),
      {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(secretBody(namespace, spec)),
      },
    );
  }

  async getSecret(namespace: string, name: string): Promise<KubernetesSecret> {
    return this.request<KubernetesSecret>(
      secretUrl(this.apiServer, namespace, name),
      { method: "GET", headers: this.authHeaders() },
    );
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    await this.request<unknown>(secretUrl(this.apiServer, namespace, name), {
      method: "DELETE",
      headers: this.authHeaders(),
    });
  }

  async createPvc(namespace: string, spec: PvcSpec): Promise<KubernetesPvc> {
    return this.request<KubernetesPvc>(pvcUrl(this.apiServer, namespace), {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(pvcBody(namespace, spec)),
    });
  }

  async getPvc(namespace: string, name: string): Promise<KubernetesPvc> {
    return this.request<KubernetesPvc>(
      pvcUrl(this.apiServer, namespace, name),
      {
        method: "GET",
        headers: this.authHeaders(),
      },
    );
  }

  async deletePvc(namespace: string, name: string): Promise<void> {
    await this.request<unknown>(pvcUrl(this.apiServer, namespace, name), {
      method: "DELETE",
      headers: this.authHeaders(),
    });
  }
}

// ─── RecordedKubernetesClient (in-memory double) ──────────────────────────────

interface KubernetesCassette {
  /** Pre-seeded deployments keyed by `${namespace}/${name}`. */
  deployments: Record<string, KubernetesDeployment>;
  /** Pre-seeded secrets keyed by `${namespace}/${name}`. */
  secrets: Record<string, KubernetesSecret>;
  /** Pre-seeded PVCs keyed by `${namespace}/${name}`. */
  pvcs?: Record<string, KubernetesPvc>;
}

/**
 * Pure in-memory KubernetesClient for tests. Replays from a seeded cassette and
 * supports create/get/delete with the same typed errors as the HTTP client
 * (404 → NotFoundError, 409 → ConflictError on duplicate create).
 */
export class RecordedKubernetesClient implements KubernetesClient {
  private readonly deployments: Map<string, KubernetesDeployment>;
  private readonly secrets: Map<string, KubernetesSecret>;
  private readonly pvcs: Map<string, KubernetesPvc>;

  constructor(cassette: KubernetesCassette) {
    this.deployments = new Map(Object.entries(cassette.deployments));
    this.secrets = new Map(Object.entries(cassette.secrets));
    this.pvcs = new Map(Object.entries(cassette.pvcs ?? {}));
  }

  private static key(namespace: string, name: string): string {
    return `${namespace}/${name}`;
  }

  async createDeployment(
    namespace: string,
    spec: DeploymentSpec,
  ): Promise<KubernetesDeployment> {
    const key = RecordedKubernetesClient.key(namespace, spec.name);
    if (this.deployments.has(key)) {
      throw new ConflictError(`deployments.apps "${spec.name}" already exists`);
    }
    const dep = deploymentBody(namespace, spec);
    this.deployments.set(key, dep);
    return dep;
  }

  async createDeploymentManifest(
    namespace: string,
    manifest: KubernetesDeployment,
  ): Promise<KubernetesDeployment> {
    const key = RecordedKubernetesClient.key(namespace, manifest.metadata.name);
    if (this.deployments.has(key)) {
      throw new ConflictError(
        `deployments.apps "${manifest.metadata.name}" already exists`,
      );
    }
    this.deployments.set(key, manifest);
    return manifest;
  }

  async getDeployment(
    namespace: string,
    name: string,
  ): Promise<KubernetesDeployment> {
    const dep = this.deployments.get(
      RecordedKubernetesClient.key(namespace, name),
    );
    if (!dep) {
      throw new NotFoundError(`deployments.apps "${name}" not found`);
    }
    return dep;
  }

  async deploymentExists(namespace: string, name: string): Promise<boolean> {
    return this.deployments.has(RecordedKubernetesClient.key(namespace, name));
  }

  // The labelSelector is ignored by the in-memory double: in tests the caller
  // controls which deployments are seeded, so filtering by label is unnecessary.
  async listDeployments(
    namespace: string,
    _labelSelector?: string,
  ): Promise<string[]> {
    const prefix = `${namespace}/`;
    const names: string[] = [];
    for (const [key] of this.deployments) {
      if (key.startsWith(prefix)) {
        names.push(key.slice(prefix.length));
      }
    }
    return names;
  }

  async deleteDeployment(namespace: string, name: string): Promise<void> {
    const key = RecordedKubernetesClient.key(namespace, name);
    if (!this.deployments.has(key)) {
      throw new NotFoundError(`deployments.apps "${name}" not found`);
    }
    this.deployments.delete(key);
  }

  async patchDeployment(
    namespace: string,
    name: string,
    patch: object,
  ): Promise<void> {
    const key = RecordedKubernetesClient.key(namespace, name);
    const dep = this.deployments.get(key);
    if (!dep) {
      throw new NotFoundError(`deployments.apps "${name}" not found`);
    }
    const p = patch as {
      spec?: {
        template?: {
          spec?: {
            containers?: KubernetesContainer[];
          };
        };
      };
    };
    // Emulate the strategic-merge semantics the real API server applies:
    // container fields are replaced, except env (merges by name) and
    // resources.requests/limits (merges key-by-key) — patched entries win,
    // unmentioned live entries (e.g. Autopilot-injected cpu keys) survive.
    const patchContainer = p.spec?.template?.spec?.containers?.[0];
    const existing = dep.spec.template.spec.containers[0];
    if (patchContainer !== undefined && existing !== undefined) {
      const merged: KubernetesContainer = { ...existing, ...patchContainer };
      if (patchContainer.env && existing.env) {
        const byName = new Map(existing.env.map((e) => [e.name, e]));
        for (const entry of patchContainer.env) byName.set(entry.name, entry);
        merged.env = [...byName.values()];
      }
      if (patchContainer.resources !== undefined) {
        merged.resources = {
          requests: {
            ...existing.resources?.requests,
            ...patchContainer.resources.requests,
          },
          limits: {
            ...existing.resources?.limits,
            ...patchContainer.resources.limits,
          },
        };
      }
      dep.spec.template.spec.containers[0] = merged;
    }
  }

  async createSecret(
    namespace: string,
    spec: SecretSpec,
  ): Promise<KubernetesSecret> {
    const key = RecordedKubernetesClient.key(namespace, spec.name);
    if (this.secrets.has(key)) {
      throw new ConflictError(`secrets "${spec.name}" already exists`);
    }
    const secret = secretBody(namespace, spec);
    this.secrets.set(key, secret);
    return secret;
  }

  async getSecret(namespace: string, name: string): Promise<KubernetesSecret> {
    const secret = this.secrets.get(
      RecordedKubernetesClient.key(namespace, name),
    );
    if (!secret) {
      throw new NotFoundError(`secrets "${name}" not found`);
    }
    return secret;
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    const key = RecordedKubernetesClient.key(namespace, name);
    if (!this.secrets.has(key)) {
      throw new NotFoundError(`secrets "${name}" not found`);
    }
    this.secrets.delete(key);
  }

  async createPvc(namespace: string, spec: PvcSpec): Promise<KubernetesPvc> {
    const key = RecordedKubernetesClient.key(namespace, spec.name);
    if (this.pvcs.has(key)) {
      throw new ConflictError(
        `persistentvolumeclaims "${spec.name}" already exists`,
      );
    }
    const pvc = pvcBody(namespace, spec);
    this.pvcs.set(key, pvc);
    return pvc;
  }

  async getPvc(namespace: string, name: string): Promise<KubernetesPvc> {
    const pvc = this.pvcs.get(RecordedKubernetesClient.key(namespace, name));
    if (!pvc) {
      throw new NotFoundError(`persistentvolumeclaims "${name}" not found`);
    }
    return pvc;
  }

  async deletePvc(namespace: string, name: string): Promise<void> {
    const key = RecordedKubernetesClient.key(namespace, name);
    if (!this.pvcs.has(key)) {
      throw new NotFoundError(`persistentvolumeclaims "${name}" not found`);
    }
    this.pvcs.delete(key);
  }
}

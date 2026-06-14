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
 *   404 → NotFoundError, 409 → ConflictError, 403 → ForbiddenError,
 *   other → ApiError (with the status code).
 */

import { readFileSync } from "node:fs";
import {
  ApiError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
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
}

export interface SecretSpec {
  name: string;
  /** Plain string values; encoded to base64 `data` on the wire. */
  stringData: Record<string, string>;
}

// ─── Resource bodies (k8s wire shapes) ──────────────────────────────────────

export interface KubernetesDeployment {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    [key: string]: unknown;
  };
  spec: {
    replicas: number;
    selector: { matchLabels: Record<string, string> };
    template: {
      metadata: { labels: Record<string, string> };
      spec: {
        containers: Array<{
          name: string;
          image: string;
          env?: Array<{ name: string; value: string }>;
        }>;
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
    [key: string]: unknown;
  };
  data: Record<string, string>;
  [key: string]: unknown;
}

// ─── Interface ──────────────────────────────────────────────────────────────

export interface KubernetesClient {
  createDeployment(
    namespace: string,
    spec: DeploymentSpec,
  ): Promise<KubernetesDeployment>;
  getDeployment(namespace: string, name: string): Promise<KubernetesDeployment>;
  deleteDeployment(namespace: string, name: string): Promise<void>;
  createSecret(namespace: string, spec: SecretSpec): Promise<KubernetesSecret>;
  getSecret(namespace: string, name: string): Promise<KubernetesSecret>;
  deleteSecret(namespace: string, name: string): Promise<void>;
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

// ─── Pure body shapers ────────────────────────────────────────────────────────

export function deploymentBody(
  namespace: string,
  spec: DeploymentSpec,
): KubernetesDeployment {
  const labels = spec.labels ?? { app: spec.name };
  const env = spec.env
    ? Object.entries(spec.env).map(([name, value]) => ({ name, value }))
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

// ─── In-cluster config loading ────────────────────────────────────────────────

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface InClusterConfig {
  apiServer: string;
  token: string;
  caCert?: string;
}

/**
 * Read in-cluster config from the mounted ServiceAccount. Paths are overridable
 * so tests can point at temp files (or skip this entirely and inject directly).
 */
export function loadInClusterConfig(opts?: {
  tokenPath?: string;
  caPath?: string;
  apiServer?: string;
}): InClusterConfig {
  const tokenPath = opts?.tokenPath ?? `${SA_DIR}/token`;
  const caPath = opts?.caPath ?? `${SA_DIR}/ca.crt`;
  const apiServer = opts?.apiServer ?? defaultApiServer();

  const token = readFileSync(tokenPath, "utf-8").trim();
  let caCert: string | undefined;
  try {
    caCert = readFileSync(caPath, "utf-8");
  } catch {
    caCert = undefined;
  }

  return { apiServer, token, caCert };
}

/**
 * Read the in-cluster CA cert (PEM) best-effort. A missing file yields
 * `undefined` rather than throwing — unlike the token, a missing CA must not
 * crash client construction.
 */
function readCaBestEffort(caPath?: string): string | undefined {
  try {
    return readFileSync(caPath ?? `${SA_DIR}/ca.crt`, "utf-8");
  } catch {
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
    case 404:
      return new NotFoundError(message);
    case 409:
      return new ConflictError(message);
    case 403:
      return new ForbiddenError(message);
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
   * the cluster's self-signed cert. Reading is best-effort: a missing file
   * leaves the CA undefined rather than throwing.
   */
  caPath?: string;
  /** Injected fetch — defaults to the global `fetch`. Never overrides the global. */
  fetchFn?: typeof fetch;
}

/** RequestInit plus Bun's `tls` option (not in the standard DOM types). */
type RequestInitWithTls = RequestInit & { tls?: { ca?: string } };

export class HttpKubernetesClient implements KubernetesClient {
  private readonly apiServer: string;
  private readonly token: string;
  private readonly caCert?: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts?: HttpKubernetesClientOpts) {
    this.apiServer = opts?.apiServer ?? defaultApiServer();
    this.token =
      opts?.token ??
      readFileSync(opts?.tokenPath ?? `${SA_DIR}/token`, "utf-8").trim();
    this.caCert = opts?.caCert ?? readCaBestEffort(opts?.caPath);
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

  private authHeaders(extra?: Record<string, string>): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      ...extra,
    };
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const finalInit: RequestInitWithTls = this.caCert
      ? { ...init, tls: { ca: this.caCert } }
      : init;
    const resp = await this.fetchFn(url, finalInit as RequestInit);
    const text = await resp.text();
    const body = text ? JSON.parse(text) : undefined;
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

  async getDeployment(
    namespace: string,
    name: string,
  ): Promise<KubernetesDeployment> {
    return this.request<KubernetesDeployment>(
      deploymentUrl(this.apiServer, namespace, name),
      { method: "GET", headers: this.authHeaders() },
    );
  }

  async deleteDeployment(namespace: string, name: string): Promise<void> {
    await this.request<unknown>(
      deploymentUrl(this.apiServer, namespace, name),
      { method: "DELETE", headers: this.authHeaders() },
    );
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
}

// ─── RecordedKubernetesClient (in-memory double) ──────────────────────────────

export interface KubernetesCassette {
  /** Pre-seeded deployments keyed by `${namespace}/${name}`. */
  deployments: Record<string, KubernetesDeployment>;
  /** Pre-seeded secrets keyed by `${namespace}/${name}`. */
  secrets: Record<string, KubernetesSecret>;
}

/**
 * Pure in-memory KubernetesClient for tests. Replays from a seeded cassette and
 * supports create/get/delete with the same typed errors as the HTTP client
 * (404 → NotFoundError, 409 → ConflictError on duplicate create).
 */
export class RecordedKubernetesClient implements KubernetesClient {
  private readonly deployments: Map<string, KubernetesDeployment>;
  private readonly secrets: Map<string, KubernetesSecret>;

  constructor(cassette: KubernetesCassette) {
    this.deployments = new Map(Object.entries(cassette.deployments));
    this.secrets = new Map(Object.entries(cassette.secrets));
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

  async deleteDeployment(namespace: string, name: string): Promise<void> {
    const key = RecordedKubernetesClient.key(namespace, name);
    if (!this.deployments.has(key)) {
      throw new NotFoundError(`deployments.apps "${name}" not found`);
    }
    this.deployments.delete(key);
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
}

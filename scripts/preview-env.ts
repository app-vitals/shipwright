#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlags } from "@app-vitals/agent-lib/cli-flags";
import { type Command, type ExecFn, runCommands } from "./minikube.ts";
import {
  GATE_SECRET_KEY,
  GATE_SECRET_NAME,
  gateIngressValues,
  helmSetEscape,
} from "./preview-gate.ts";

/**
 * scripts/preview-env.ts — install the full Shipwright preview profile onto an
 * EXISTING kube context (a throwaway kind cluster in CI).
 *
 * Run via `task preview:up`.
 *
 * Unlike scripts/minikube.ts this never creates or deletes a cluster: the
 * caller owns the cluster and its images (the five preview images are built
 * and side-loaded before this runs). The ordering constraints are:
 *
 *   1. The three Secrets referenced by examples/values-preview.yaml must exist
 *      BEFORE the install, or the pods hang in CreateContainerConfigError.
 *   2. The ingress controller must be Ready BEFORE the install, or its
 *      admission webhook refuses the chart's Ingress.
 *   3. `helm dependency build` must run BEFORE the install.
 *
 * With `opts.gate` the htpasswd Secret `shipwright-preview-gate` is created
 * before the install and the release carries the basic-auth annotations
 * (see scripts/preview-gate.ts).
 *
 * Secret values never appear in an argv, label or log line: the driver writes
 * them to files in a private temp directory, the commands reference those
 * files via `--from-file`, and the directory is removed afterwards.
 *
 * Architecture (mirrors scripts/minikube.ts): a PURE builder returns the
 * command list and a thin driver runs it through an INJECTED exec.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RELEASE = "shipwright";
const NAMESPACE = "shipwright";
const DEFAULT_TIMEOUT = "600s";
const VALUES_FILE = "examples/values-preview.yaml";

const INGRESS_NAMESPACE = "ingress-nginx";
const INGRESS_DEPLOYMENT = "ingress-nginx-controller";
/** kind-specific ingress-nginx manifest (hostPort, control-plane scheduling). */
const INGRESS_MANIFEST_URL =
  "https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/kind/deploy.yaml";

/** Deployments rendered by the preview profile, waited on after the install. */
export const PREVIEW_DEPLOYMENTS: readonly string[] = [
  "shipwright-admin",
  "shipwright-metrics",
  "shipwright-task-store",
  "shipwright-chat",
  "shipwright-mcp-server",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreviewSecrets = {
  mcpServerToken: string;
  /** Seeded as the task-store admin token; also used by mcp-server and metrics. */
  taskStoreToken: string;
  /** Shared by admin (signs the admin_session JWT) and metrics (verifies it). */
  sessionSecret: string;
  /** 64 hex chars: admin's SHIPWRIGHT_ENCRYPTION_KEY, in the same Secret as the session secret. */
  encryptionKey: string;
};

/** File holding the htpasswd content for the ingress basic-auth gate. */
export type PreviewGate = { htpasswdFile: string };

export type PreviewOpts = {
  /** Existing kube context, required. */
  context: string;
  /** Chart directory to install. */
  chartPath: string;
  /** Ingress host. When set, also sets admin.appBaseUrl. The values file defaults to preview.localhost. */
  host?: string;
  /**
   * Present only in the preview job. Creates the basic-auth Secret
   * (shipwright-preview-gate) before the install and sets the ingress-nginx
   * auth annotations on the release. Without it the preview is ungated.
   */
  gate?: PreviewGate;
  /** helm --timeout. Default "600s". */
  timeout?: string;
  /** Directory holding the secret files from previewSecretFiles. */
  secretsDir?: string;
};

export type PortForward = {
  name: "admin" | "metrics" | "taskStore" | "chat" | "mcp" | "ingress";
  namespace: string;
  service: string;
  local: number;
  remote: number;
};

/** Service names and ports match the chart for a release named "shipwright". */
export const PORT_FORWARDS: readonly PortForward[] = [
  {
    name: "admin",
    namespace: NAMESPACE,
    service: "shipwright-admin",
    local: 13001,
    remote: 3001,
  },
  {
    name: "metrics",
    namespace: NAMESPACE,
    service: "shipwright-metrics",
    local: 13460,
    remote: 3460,
  },
  {
    name: "taskStore",
    namespace: NAMESPACE,
    service: "shipwright-task-store",
    local: 13002,
    remote: 3000,
  },
  {
    name: "chat",
    namespace: NAMESPACE,
    service: "shipwright-chat",
    local: 13003,
    remote: 3000,
  },
  {
    name: "mcp",
    namespace: NAMESPACE,
    service: "shipwright-mcp-server",
    local: 13004,
    remote: 3010,
  },
  {
    name: "ingress",
    namespace: INGRESS_NAMESPACE,
    service: INGRESS_DEPLOYMENT,
    local: 18080,
    remote: 80,
  },
];

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export function generatePreviewSecrets(
  randomHex: (bytes: number) => string,
): PreviewSecrets {
  return {
    mcpServerToken: randomHex(24),
    taskStoreToken: randomHex(24),
    sessionSecret: randomHex(32),
    encryptionKey: randomHex(32),
  };
}

type SecretFile = { secret: string; key: string; value: string };

/**
 * The files backing each Secret, keyed by file name. The task-store token is
 * written once per Secret because the three consumers read it by different
 * Secret/key names (see the header of examples/values-preview.yaml).
 */
export function previewSecretFiles(
  secrets: PreviewSecrets,
): Record<string, SecretFile> {
  const entries: SecretFile[] = [
    {
      secret: "shipwright-preview-mcp",
      key: "SHIPWRIGHT_MCP_SERVER_TOKEN",
      value: secrets.mcpServerToken,
    },
    {
      secret: "shipwright-preview-mcp",
      key: "SHIPWRIGHT_TASK_STORE_TOKEN",
      value: secrets.taskStoreToken,
    },
    {
      secret: "shipwright-preview-task-store-seed",
      key: "TASK_STORE_SEED_ADMIN_TOKEN",
      value: secrets.taskStoreToken,
    },
    {
      secret: "shipwright-preview-metrics",
      key: "METRICS_TASK_STORE_TOKEN",
      value: secrets.taskStoreToken,
    },
    {
      secret: "shipwright-preview-admin-keys",
      key: "SHIPWRIGHT_SESSION_SECRET",
      value: secrets.sessionSecret,
    },
    {
      secret: "shipwright-preview-admin-keys",
      key: "SHIPWRIGHT_ENCRYPTION_KEY",
      value: secrets.encryptionKey,
    },
  ];
  return Object.fromEntries(entries.map((e) => [`${e.secret}.${e.key}`, e]));
}

/**
 * Write the secret files to a fresh private directory under `baseDir`, run
 * `fn` with that directory, and remove it afterwards — even when `fn` throws.
 */
export function withSecretFiles<T>(
  secrets: PreviewSecrets,
  baseDir: string,
  fn: (dir: string) => T,
): T {
  const dir = mkdtempSync(join(baseDir, "preview-secrets-"));
  try {
    for (const [name, file] of Object.entries(previewSecretFiles(secrets))) {
      writeFileSync(join(dir, name), file.value, { mode: 0o600 });
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

/**
 * Build the full install sequence. Pure: no I/O, no spawning. Secret values
 * are never read here — only the paths of the files that will hold them.
 */
export function buildPreviewCommands(
  opts: PreviewOpts,
  secrets: PreviewSecrets,
): Command[] {
  const {
    context,
    chartPath,
    host,
    gate,
    timeout = DEFAULT_TIMEOUT,
    secretsDir = "preview-secrets",
  } = opts;
  const kubectl = (...args: string[]): string[] => [
    "kubectl",
    "--context",
    context,
    ...args,
  ];
  const helm = (...args: string[]): string[] => [
    "helm",
    "--kube-context",
    context,
    ...args,
  ];

  const cmds: Command[] = [];

  // 1. Namespace and Secrets, before anything in the chart references them.
  cmds.push({
    kind: "kubectl",
    label: `create namespace ${NAMESPACE}`,
    argv: kubectl("create", "namespace", NAMESPACE),
  });
  const bySecret = new Map<string, string[]>();
  for (const [name, file] of Object.entries(previewSecretFiles(secrets))) {
    const flags = bySecret.get(file.secret) ?? [];
    flags.push(`--from-file=${file.key}=${secretsDir}/${name}`);
    bySecret.set(file.secret, flags);
  }
  if (gate) {
    cmds.push({
      kind: "kubectl",
      label: `create secret ${GATE_SECRET_NAME}`,
      argv: kubectl(
        "create",
        "secret",
        "generic",
        GATE_SECRET_NAME,
        "--namespace",
        NAMESPACE,
        `--from-file=${GATE_SECRET_KEY}=${gate.htpasswdFile}`,
      ),
    });
  }
  for (const [secret, flags] of bySecret) {
    cmds.push({
      kind: "kubectl",
      label: `create secret ${secret}`,
      argv: kubectl(
        "create",
        "secret",
        "generic",
        secret,
        "--namespace",
        NAMESPACE,
        ...flags,
      ),
    });
  }

  // 2. Ingress controller, Ready before the chart's Ingress is validated.
  cmds.push({
    kind: "kubectl",
    label: "install the ingress-nginx controller",
    argv: kubectl("apply", "-f", INGRESS_MANIFEST_URL),
  });
  if (gate) {
    // The gate's configuration-snippet annotation (strips the forwarded
    // Authorization header) is rejected by ingress-nginx v1.12.1 by default:
    // allow-snippet-annotations is false and snippets are Critical risk.
    cmds.push({
      kind: "kubectl",
      label: "allow snippet annotations on the ingress controller",
      argv: kubectl(
        "patch",
        "configmap",
        INGRESS_DEPLOYMENT,
        "--namespace",
        INGRESS_NAMESPACE,
        "--type",
        "merge",
        "-p",
        '{"data":{"allow-snippet-annotations":"true","annotations-risk-level":"Critical"}}',
      ),
    });
  }
  cmds.push({
    kind: "kubectl",
    label: "wait for the ingress controller",
    argv: kubectl(
      "rollout",
      "status",
      `deployment/${INGRESS_DEPLOYMENT}`,
      "--namespace",
      INGRESS_NAMESPACE,
      "--timeout=180s",
    ),
  });

  // 3. Chart dependencies are not vendored expanded.
  cmds.push({
    kind: "helm",
    label: "resolve chart dependencies",
    argv: helm("dependency", "build", chartPath),
  });

  // 4. Install with the preview profile. --wait so the rollout checks below
  //    start from a settled release.
  const hostSets = host
    ? [
        "--set",
        `networking.ingress.host=${host}`,
        "--set",
        `admin.appBaseUrl=https://${host}`,
      ]
    : [];
  const gateSets = gate
    ? gateIngressValues().flatMap(([k, v]) => [
        "--set",
        `networking.ingress.annotations.${helmSetEscape(k)}=${v}`,
      ])
    : [];
  cmds.push({
    kind: "helm",
    label: `install/upgrade release "${RELEASE}"`,
    argv: helm(
      "upgrade",
      "--install",
      RELEASE,
      chartPath,
      "--namespace",
      NAMESPACE,
      "--create-namespace",
      "--values",
      `${chartPath}/${VALUES_FILE}`,
      ...hostSets,
      ...gateSets,
      "--wait",
      "--timeout",
      timeout,
    ),
  });

  // 5. Per-Deployment rollout status, so a failure names the broken service.
  for (const deployment of PREVIEW_DEPLOYMENTS) {
    cmds.push({
      kind: "kubectl",
      label: `wait for ${deployment}`,
      argv: kubectl(
        "rollout",
        "status",
        `deployment/${deployment}`,
        "--namespace",
        NAMESPACE,
        "--timeout=5m",
      ),
    });
  }

  return cmds;
}

/** metrics.provider.basePath from the preview values profile ("" when unset). */
export function readMetricsBasePath(valuesYaml: string): string {
  const values = Bun.YAML.parse(valuesYaml) as {
    metrics?: { provider?: { basePath?: string } };
  };
  return (values.metrics?.provider?.basePath ?? "").replace(/\/+$/, "");
}

/** Environment the deployed-target canary suite reads. */
export function buildTargetsEnv(
  secrets: PreviewSecrets,
  metricsBasePath = "",
): Record<string, string> {
  const url = (name: PortForward["name"]): string => {
    const forward = PORT_FORWARDS.find((p) => p.name === name);
    return `http://127.0.0.1:${forward?.local}`;
  };
  return {
    PREVIEW_ADMIN_URL: url("admin"),
    // The metrics app mounts every route under metrics.provider.basePath.
    PREVIEW_METRICS_URL: `${url("metrics")}${metricsBasePath}`,
    PREVIEW_TASK_STORE_URL: url("taskStore"),
    PREVIEW_CHAT_URL: url("chat"),
    PREVIEW_MCP_URL: url("mcp"),
    PREVIEW_TASK_STORE_TOKEN: secrets.taskStoreToken,
    PREVIEW_MCP_TOKEN: secrets.mcpServerToken,
  };
}

/** Argv for one background `kubectl port-forward`. */
export function buildPortForwardArgv(
  context: string,
  p: PortForward,
): string[] {
  return [
    "kubectl",
    "--context",
    context,
    "port-forward",
    "--namespace",
    p.namespace,
    `svc/${p.service}`,
    `${p.local}:${p.remote}`,
  ];
}

// ---------------------------------------------------------------------------
// Real I/O — entrypoint only
// ---------------------------------------------------------------------------

function realExec(argv: string[]): void {
  const result = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(
      `command failed (exit ${result.exitCode}): ${argv[0]} ${argv[1] ?? ""} ...`,
    );
  }
}

function startPortForwards(context: string): void {
  mkdirSync("state", { recursive: true });
  const log = openSync("state/preview-port-forward.log", "a");
  for (const p of PORT_FORWARDS) {
    const proc = Bun.spawn(buildPortForwardArgv(context, p), {
      stdout: log,
      stderr: log,
      stdin: "ignore",
    });
    proc.unref();
    console.log(`[preview] port-forward ${p.name} on :${p.local}`);
  }
}

function main(): void {
  const flags = parseFlags(process.argv, [
    "--context",
    "--chart",
    "--host",
    "--htpasswd-file",
    "--env-out",
  ] as const);
  const context = flags["--context"];
  const chartPath = flags["--chart"];
  if (!context || !chartPath) {
    console.error(
      "usage: preview-env.ts --context <ctx> --chart <dir> [--host <h>] [--htpasswd-file <f>] [--env-out <file>]",
    );
    process.exit(1);
  }
  const htpasswdFile = flags["--htpasswd-file"];
  const secrets = generatePreviewSecrets((n) => randomBytes(n).toString("hex"));

  withSecretFiles(secrets, tmpdir(), (secretsDir) => {
    const cmds = buildPreviewCommands(
      {
        context,
        chartPath,
        host: flags["--host"],
        gate: htpasswdFile ? { htpasswdFile } : undefined,
        secretsDir,
      },
      secrets,
    );
    runCommands(cmds, realExec as ExecFn);
  });

  startPortForwards(context);

  const envOut = flags["--env-out"];
  if (envOut) {
    const body = Object.entries(
      buildTargetsEnv(
        secrets,
        readMetricsBasePath(
          readFileSync(`${chartPath}/${VALUES_FILE}`, "utf8"),
        ),
      ),
    )
      .map(([k, v]) => `${k}=${v}\n`)
      .join("");
    appendFileSync(envOut, body);
    console.log(`[preview] wrote targets to ${envOut}`);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`\n[preview] FAILED: ${(err as Error).message}`);
    process.exit(1);
  }
}

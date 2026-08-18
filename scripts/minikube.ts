#!/usr/bin/env bun
import { mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/**
 * scripts/minikube.ts — bring the full Shipwright stack up on Minikube.
 *
 * Run via `task minikube:up` / `task minikube:down`.
 *
 * WHY A SCRIPT: the sequence has five ordering constraints that are easy to get
 * wrong and produce confusing failures rather than clear errors:
 *
 *   1. VM sizing must be set at `minikube start`. The agent pod alone requests
 *      500m CPU / 2Gi memory (admin/src/agent-manifest.ts); an under-sized VM
 *      schedules it and then thrashes.
 *   2. `minikube addons enable ingress` must run BEFORE the install, or the
 *      rendered Ingress has no controller and nothing answers.
 *   3. The install must wait for the ingress controller's admission webhook pod
 *      to be Ready before applying the chart. `addons enable` returns as soon as
 *      the Deployment is created, not once the webhook Service has a ready
 *      endpoint — installing immediately after races it and helm fails with
 *      "connect: connection refused" against the webhook.
 *   4. `helm dependency build` must run BEFORE the install — Chart.lock pins the
 *      PostgreSQL subchart from an OCI registry and it is not vendored expanded.
 *   5. The /etc/hosts entry can only be written AFTER the VM has an IP.
 *
 * Architecture (mirrors scripts/dev-tmux.ts): a PURE builder
 * (buildMinikubeCommands / buildTeardownCommands) returns the command list, and
 * a thin driver runs it through an INJECTED exec. All ordering logic is
 * therefore unit-testable with no Docker, no VM, and no network — see
 * scripts/minikube.unit.test.ts.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RELEASE = "shipwright";
export const NAMESPACE = "shipwright";
export const CHART_PATH = "charts/shipwright";
export const VALUES_FILE = "charts/shipwright/examples/values-minikube.yaml";
export const INGRESS_HOST = "shipwright.local";

/**
 * With the docker driver (the default on macOS/Colima), `minikube ip` returns
 * an address on a Docker-internal network the host cannot route to at all —
 * and even if it could, the ingress controller Service is NodePort (a high
 * port), not port 80. So the host must reach it through a `kubectl
 * port-forward` to a local port instead of the raw minikube IP on :80.
 */
export const INGRESS_LOCAL_PORT = 8080;
export const PORT_FORWARD_PID_FILE = "state/minikube-port-forward.pid";
export const PORT_FORWARD_LOG_FILE = "state/minikube-port-forward.log";

/**
 * Default VM size. The floor for the platform plus one agent — see the sizing
 * note in examples/values-minikube.yaml. Below 4 CPU / 6Gi the agent thrashes.
 */
export const DEFAULT_CPUS = 4;
export const DEFAULT_MEMORY_MB = 8192;
export const DEFAULT_DISK = "40g";

/** Deployments waited on after install, in dependency-ish order. */
export const DEPLOYMENTS = [
  "shipwright-admin",
  "shipwright-metrics",
  "shipwright-task-store",
  "shipwright-chat",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandKind = "minikube" | "helm" | "kubectl";

export type Command = {
  kind: CommandKind;
  /** Full argv, including the binary name, so exec is a single spawn. */
  argv: string[];
  /** Human-readable step label, printed by the driver. */
  label: string;
};

/** Runs a single built command. Injected for testability. */
export type ExecFn = (argv: string[]) => void;

export type BuildOpts = {
  /** Skip `minikube start` when the VM is already running. */
  alreadyRunning?: boolean;
  cpus?: number;
  memoryMb?: number;
  disk?: string;
  release?: string;
  namespace?: string;
  chartPath?: string;
  valuesFile?: string;
  /** Helm --timeout for the install. Agent image pulls are large. */
  timeout?: string;
  /** Run `helm test` after the rollout completes. */
  runHelmTest?: boolean;
};

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

/**
 * Build the full bring-up sequence. Pure: no I/O, no spawning.
 *
 * Order is the contract here — see the four constraints in the file header.
 */
export function buildMinikubeCommands(opts: BuildOpts = {}): Command[] {
  const {
    alreadyRunning = false,
    cpus = DEFAULT_CPUS,
    memoryMb = DEFAULT_MEMORY_MB,
    disk = DEFAULT_DISK,
    release = RELEASE,
    namespace = NAMESPACE,
    chartPath = CHART_PATH,
    valuesFile = VALUES_FILE,
    timeout = "15m",
    runHelmTest = true,
  } = opts;

  const cmds: Command[] = [];

  // 1. Start the VM at a size that can actually hold an agent. Skipped when it
  //    is already running — `minikube start` would ignore new sizing flags on an
  //    existing VM anyway, so silently "resizing" is not on offer.
  if (!alreadyRunning) {
    cmds.push({
      kind: "minikube",
      label: `start VM (${cpus} cpus, ${memoryMb}MB, ${disk} disk)`,
      argv: [
        "minikube",
        "start",
        `--cpus=${cpus}`,
        `--memory=${memoryMb}`,
        `--disk-size=${disk}`,
      ],
    });
  }

  // 2. BEFORE the install: without the controller the Ingress is inert.
  cmds.push({
    kind: "minikube",
    label: "enable the ingress addon",
    argv: ["minikube", "addons", "enable", "ingress"],
  });

  // 2b. BEFORE the install: `addons enable` returns as soon as the controller
  //     Deployment is created, not once its admission webhook is reachable. The
  //     chart's Ingress resource is validated against that webhook on apply, so
  //     installing immediately after enabling races it — the webhook Service has
  //     no ready endpoint yet and helm fails with "connection refused".
  cmds.push({
    kind: "kubectl",
    label: "wait for the ingress admission webhook",
    argv: [
      "kubectl",
      "wait",
      "--namespace",
      "ingress-nginx",
      "--for=condition=ready",
      "pod",
      "--selector=app.kubernetes.io/component=controller",
      "--timeout=120s",
    ],
  });

  // 3. BEFORE the install: Chart.lock pins the PostgreSQL subchart via OCI.
  cmds.push({
    kind: "helm",
    label: "resolve chart dependencies",
    argv: ["helm", "dependency", "build", chartPath],
  });

  // 4. Install/upgrade. --wait so the driver does not race the rollout checks.
  cmds.push({
    kind: "helm",
    label: `install/upgrade release "${release}"`,
    argv: [
      "helm",
      "upgrade",
      "--install",
      release,
      chartPath,
      "--namespace",
      namespace,
      "--create-namespace",
      "--values",
      valuesFile,
      "--wait",
      "--timeout",
      timeout,
    ],
  });

  // 5. Explicit per-Deployment rollout status: `--wait` alone reports a single
  //    aggregate failure, which makes "which service is broken?" a guess.
  for (const deployment of DEPLOYMENTS) {
    cmds.push({
      kind: "kubectl",
      label: `wait for ${deployment}`,
      argv: [
        "kubectl",
        "rollout",
        "status",
        `deployment/${deployment}`,
        "--namespace",
        namespace,
        "--timeout=5m",
      ],
    });
  }

  // 6. Proves the stack answers over HTTP, not just that pods are Running.
  if (runHelmTest) {
    cmds.push({
      kind: "helm",
      label: "run helm test (health checks)",
      argv: ["helm", "test", release, "--namespace", namespace],
    });
  }

  return cmds;
}

export type AccessUrls = {
  admin: string;
  devLogin: string;
  metrics: string;
  taskStore: string;
  agentNew: string;
};

/**
 * Build the browsable URLs for the stack once the local port-forward is up.
 *
 * The metrics path is "/dashboard/dashboard", not "/dashboard" — the metrics
 * service mounts its entire router under provider.basePath (set to
 * "/dashboard" in examples/values-minikube.yaml), and its own dashboard route
 * is itself named "/dashboard", so the two compose. See
 * charts/shipwright/templates/metrics-deployment.yaml's probe paths, which
 * hit the same basePath-prefixed shape for /health.
 *
 * devLogin is the entry point to hand a developer, NOT admin. This profile runs
 * auth.mode=open, and "/" redirects to /admin/login — a page that only offers a
 * Google sign-in button, which this profile never configures. That is a dead end.
 * /admin/dev-login mints the dev session outright and lands on /admin/agents.
 */
export function buildAccessUrls(host: string, port: number): AccessUrls {
  const base = `http://${host}:${port}`;
  return {
    admin: `${base}/`,
    devLogin: `${base}/admin/dev-login`,
    metrics: `${base}/dashboard/dashboard`,
    taskStore: `${base}/task-store/health`,
    agentNew: `${base}/admin/agents/new`,
  };
}

/**
 * Build the teardown sequence: uninstall the release, then delete the VM.
 *
 * Uninstall first so Helm can run its hooks and drop the PVCs while the API
 * server is still up; `minikube delete` alone would leave a stale release record
 * if the VM were ever reused.
 */
export function buildTeardownCommands(opts: BuildOpts = {}): Command[] {
  const { release = RELEASE, namespace = NAMESPACE } = opts;
  return [
    {
      kind: "helm",
      label: `uninstall release "${release}"`,
      argv: ["helm", "uninstall", release, "--namespace", namespace],
    },
    {
      kind: "minikube",
      label: "delete the VM",
      argv: ["minikube", "delete"],
    },
  ];
}

// ---------------------------------------------------------------------------
// Preflight (pure — the existence check is injected)
// ---------------------------------------------------------------------------

export const REQUIRED_BINARIES = ["minikube", "helm", "kubectl"] as const;

/** Names of required binaries that are NOT on PATH. Empty means good to go. */
export function missingBinaries(
  which: (bin: string) => string | null,
): string[] {
  return REQUIRED_BINARIES.filter((bin) => !which(bin));
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** Run the built sequence through the injected exec. Returns what it ran. */
export function runCommands(cmds: Command[], exec: ExecFn): Command[] {
  for (const cmd of cmds) {
    console.log(`\n[minikube] ${cmd.label}`);
    console.log(`[minikube] $ ${cmd.argv.join(" ")}`);
    exec(cmd.argv);
  }
  return cmds;
}

// ---------------------------------------------------------------------------
// Real I/O — entrypoint only
// ---------------------------------------------------------------------------

function realExec(argv: string[]): void {
  const result = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(
      `command failed (exit ${result.exitCode}): ${argv.join(" ")}`,
    );
  }
}

/** True when a Minikube VM is already running. */
function minikubeIsRunning(): boolean {
  const result = Bun.spawnSync(["minikube", "status", "--format={{.Host}}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return new TextDecoder().decode(result.stdout).trim() === "Running";
}

/** True if a process with this PID exists (signal 0 sends nothing, just probes). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPortForwardPid(): number | null {
  try {
    const pid = Number.parseInt(
      readFileSync(PORT_FORWARD_PID_FILE, "utf8").trim(),
      10,
    );
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a `kubectl port-forward` to the ingress controller is running on
 * INGRESS_LOCAL_PORT, starting one if none is alive yet. Idempotent across
 * repeated `task minikube:up` runs, the same way `minikubeIsRunning` is for
 * the VM itself.
 *
 * WHY NOT `minikube tunnel`: that needs a sudo password and a terminal left
 * open for the whole session. This uses the Kubernetes API connection that
 * already works (kubectl talks to it throughout the rest of this script), so
 * it needs no elevated privileges and no extra terminal.
 */
function ensurePortForward(): void {
  const existing = readPortForwardPid();
  if (existing !== null && isProcessAlive(existing)) {
    console.log(
      `\n[minikube] port-forward already running on :${INGRESS_LOCAL_PORT} (pid ${existing})`,
    );
    return;
  }

  mkdirSync(dirname(PORT_FORWARD_PID_FILE), { recursive: true });
  const log = openSync(PORT_FORWARD_LOG_FILE, "a");
  const proc = Bun.spawn(
    [
      "kubectl",
      "port-forward",
      "--namespace",
      "ingress-nginx",
      "svc/ingress-nginx-controller",
      `${INGRESS_LOCAL_PORT}:80`,
    ],
    { stdout: log, stderr: log, stdin: "ignore" },
  );
  proc.unref();
  Bun.write(PORT_FORWARD_PID_FILE, `${proc.pid}\n`);
  console.log(
    `\n[minikube] started port-forward on :${INGRESS_LOCAL_PORT} (pid ${proc.pid}, log: ${PORT_FORWARD_LOG_FILE})`,
  );
}

/** Best-effort: kill the tracked port-forward, if any, and drop the PID file. */
function stopPortForward(): void {
  const pid = readPortForwardPid();
  if (pid !== null && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone — nothing to clean up.
    }
  }
  try {
    unlinkSync(PORT_FORWARD_PID_FILE);
  } catch {
    // No PID file to remove — fine.
  }
}

function printNextSteps(): void {
  const urls = buildAccessUrls(INGRESS_HOST, INGRESS_LOCAL_PORT);
  console.log("\n────────────────────────────────────────────────────────────");
  console.log("Shipwright is up.\n");
  console.log("Add the ingress host to /etc/hosts (once):");
  console.log(`  echo "127.0.0.1 ${INGRESS_HOST}" | sudo tee -a /etc/hosts\n`);
  console.log(
    "Log in (auth.mode=open — this mints a dev session, no password):",
  );
  console.log(`  ${urls.devLogin}\n`);
  console.log(`  admin console   ${urls.admin}`);
  console.log(`  metrics         ${urls.metrics}`);
  console.log(`  task store      ${urls.taskStore}\n`);
  console.log(
    "Visit the dev-login link FIRST — the admin console redirects to a Google",
  );
  console.log("sign-in page that this profile does not configure.\n");
  console.log("No agent exists yet — create one at:");
  console.log(`  ${urls.agentNew}\n`);
  console.log(
    "Set that agent's ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the",
  );
  console.log("admin UI before it can work.");
  console.log(
    "\nThe stack is reachable through a `kubectl port-forward` this script",
  );
  console.log(
    `started in the background (pid file: ${PORT_FORWARD_PID_FILE}). It is`,
  );
  console.log("torn down automatically by: task minikube:down");
}

async function main(): Promise<void> {
  const down = process.argv.includes("--down");

  const missing = missingBinaries((bin) => Bun.which(bin));
  if (missing.length > 0) {
    console.error(
      `[minikube] missing required binaries: ${missing.join(", ")}`,
    );
    console.error("[minikube] install them and re-run.");
    process.exit(1);
  }

  if (down) {
    stopPortForward();
    // Best-effort: a partially-installed stack should still tear down, so a
    // failing uninstall must not block `minikube delete`.
    for (const cmd of buildTeardownCommands()) {
      console.log(`\n[minikube] ${cmd.label}`);
      try {
        realExec(cmd.argv);
      } catch (err) {
        console.warn(`[minikube] ignoring: ${(err as Error).message}`);
      }
    }
    console.log("\n[minikube] torn down.");
    return;
  }

  const alreadyRunning = minikubeIsRunning();
  if (alreadyRunning) {
    console.log("[minikube] VM already running — skipping `minikube start`.");
    console.log(
      "[minikube] note: sizing flags do not apply to an existing VM. " +
        "Run `task minikube:down` first to resize.",
    );
  }

  runCommands(buildMinikubeCommands({ alreadyRunning }), realExec);
  ensurePortForward();
  printNextSteps();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n[minikube] FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
}

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
/** HTTPS local port — only forwarded by profiles that terminate TLS. */
export const INGRESS_LOCAL_TLS_PORT = 8443;
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

/**
 * "addon" is the pre-existing default: minikube's own `ingress` addon,
 * webhook-waited and reached at svc/ingress-nginx-controller in the
 * ingress-nginx namespace. The two "cloud-native-*" profiles instead install
 * the chart's OWN bundled ingress controller subchart (CNH-8.1) — the
 * controller comes up as part of the same helm release, in the shipwright
 * namespace, so there is nothing for `minikube addons enable` to do and no
 * separate webhook to wait on before the install.
 */
export type Profile = "addon" | "cloud-native-nginx" | "cloud-native-traefik";

/** A local:remote port pair passed to `kubectl port-forward`. */
export type PortPair = { local: number; remote: number };

export type ProfileConfig = {
  profile: Profile;
  /** Run `minikube addons enable ingress` + wait on its webhook before install. */
  useIngressAddon: boolean;
  /** `--values` file for the helm install, unless overridden by BuildOpts. */
  valuesFile: string;
  /** Namespace the ingress controller Service/Deployment lives in. */
  controllerNamespace: string;
  /** Service the port-forward targets, e.g. "svc/shipwright-traefik". */
  controllerService: string;
  /** Port pairs forwarded to the controller Service, local:remote. */
  portPairs: PortPair[];
  /**
   * Bundled controller Deployment to `kubectl rollout status` wait on after
   * install, or null for the addon profile (whose webhook-pod wait happens
   * BEFORE install instead, and is unaffected by this mechanism).
   */
  controllerRollout: { name: string; kind: "deployment" } | null;
  /** URL scheme for buildAccessUrls — https once TLS is bundled and enabled. */
  scheme: "http" | "https";
  /** Local port used to build the printed access URL for this profile. */
  accessPort: number;
};

/**
 * Per-profile config consumed by the pure command builder. Adding a profile
 * means adding an entry here — buildMinikubeCommands/ensurePortForward/
 * printNextSteps all read from this map rather than branching on profile name.
 */
export const PROFILES: Record<Profile, ProfileConfig> = {
  addon: {
    profile: "addon",
    useIngressAddon: true,
    valuesFile: VALUES_FILE,
    controllerNamespace: "ingress-nginx",
    controllerService: "svc/ingress-nginx-controller",
    portPairs: [{ local: INGRESS_LOCAL_PORT, remote: 80 }],
    controllerRollout: null,
    scheme: "http",
    accessPort: INGRESS_LOCAL_PORT,
  },
  "cloud-native-nginx": {
    profile: "cloud-native-nginx",
    useIngressAddon: false,
    // NOT ci/cloud-native-nginx-values.yaml — that file pins admin/metrics
    // images to a local 0.1.0 tag with pullPolicy: Never, relying on CI's
    // `kind load docker-image` step to side-load them. A real minikube VM has
    // no equivalent side-load step, so those pods would hang on
    // ErrImageNeverPull. This values file bundles the same ingress-nginx +
    // cert-manager subcharts but pulls the real GHCR image and uses dev auth
    // — see its own header comment.
    valuesFile:
      "charts/shipwright/examples/values-minikube-cloud-native-nginx.yaml",
    controllerNamespace: NAMESPACE,
    controllerService: "svc/shipwright-ingress-nginx-controller",
    // Both ports: tls.redirect=true (values-minikube-cloud-native-nginx.yaml)
    // means port 80 still exists and 301s to 443 — forwarding only 8443 would
    // work for the app itself, but 8080 is kept reachable too so the redirect
    // behavior is also exercised, matching acceptance criterion 2's :8443 check.
    portPairs: [
      { local: INGRESS_LOCAL_PORT, remote: 80 },
      { local: INGRESS_LOCAL_TLS_PORT, remote: 443 },
    ],
    controllerRollout: {
      name: "shipwright-ingress-nginx-controller",
      kind: "deployment",
    },
    scheme: "https",
    accessPort: INGRESS_LOCAL_TLS_PORT,
  },
  "cloud-native-traefik": {
    profile: "cloud-native-traefik",
    useIngressAddon: false,
    // NOT ci/cloud-native-traefik-values.yaml — same local-image/pullPolicy:
    // Never issue as the cloud-native-nginx profile above (see that entry's
    // comment). This values file bundles the same Traefik subchart but pulls
    // the real GHCR image and uses dev auth — see its own header comment.
    valuesFile:
      "charts/shipwright/examples/values-minikube-cloud-native-traefik.yaml",
    controllerNamespace: NAMESPACE,
    controllerService: "svc/shipwright-traefik",
    // No tls: stanza in values-minikube-cloud-native-traefik.yaml — plain
    // HTTP only.
    portPairs: [{ local: INGRESS_LOCAL_PORT, remote: 80 }],
    controllerRollout: { name: "shipwright-traefik", kind: "deployment" },
    scheme: "http",
    accessPort: INGRESS_LOCAL_PORT,
  },
};

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
  /** Overrides the resolved profile's values file when set. */
  valuesFile?: string;
  /** Helm --timeout for the install. Agent image pulls are large. */
  timeout?: string;
  /** Run `helm test` after the rollout completes. */
  runHelmTest?: boolean;
  /** Which ingress setup to install against. Defaults to "addon" — the
   *  pre-existing minikube-ingress-addon behavior — so every caller that
   *  predates profiles keeps its exact command list. */
  profile?: Profile;
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
    timeout = "15m",
    runHelmTest = true,
    profile = "addon",
  } = opts;
  const profileConfig = PROFILES[profile];
  // opts.valuesFile, when explicitly passed, wins over the profile default —
  // preserves the existing override/testability contract for callers.
  const valuesFile = opts.valuesFile ?? profileConfig.valuesFile;

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

  // 2 & 2b. BEFORE the install, addon profile only: without the controller the
  //     Ingress is inert, and `addons enable` returns as soon as the controller
  //     Deployment is created, not once its admission webhook is reachable — the
  //     chart's Ingress resource is validated against that webhook on apply, so
  //     installing immediately after enabling races it and helm fails with
  //     "connection refused". Cloud-native profiles install their OWN ingress
  //     controller as a chart-bundled subchart in the SAME helm release below —
  //     there is no separate addon to enable and no pre-install webhook to wait
  //     on (its rollout is waited on AFTER the install instead, with the rest of
  //     the release's Deployments).
  if (profileConfig.useIngressAddon) {
    cmds.push({
      kind: "minikube",
      label: "enable the ingress addon",
      argv: ["minikube", "addons", "enable", "ingress"],
    });

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
  }

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

  // 5b. Cloud-native profiles only: the bundled ingress controller comes up as
  //     part of this SAME helm release (not a pre-install minikube addon), so
  //     its rollout is waited on here, alongside the app Deployments above.
  if (profileConfig.controllerRollout) {
    const { name } = profileConfig.controllerRollout;
    cmds.push({
      kind: "kubectl",
      label: `wait for ${name}`,
      argv: [
        "kubectl",
        "rollout",
        "status",
        `deployment/${name}`,
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
export function buildAccessUrls(
  host: string,
  port: number,
  scheme: "http" | "https" = "http",
): AccessUrls {
  const base = `${scheme}://${host}:${port}`;
  return {
    admin: `${base}/`,
    devLogin: `${base}/admin/dev-login`,
    metrics: `${base}/dashboard/dashboard`,
    taskStore: `${base}/task-store/health`,
    agentNew: `${base}/admin/agents/new`,
  };
}

/**
 * Command that hands `url` to the OS browser, or null on a platform with no
 * known opener. Best-effort by design — a headless box (CI, no DISPLAY, SSH)
 * must still finish the bring-up, so the caller ignores failures here.
 */
export function buildOpenCommand(
  url: string,
  platform: string = process.platform,
): string[] | null {
  if (platform === "darwin") return ["open", url];
  if (platform === "linux") return ["xdg-open", url];
  return null;
}

/**
 * Whether /etc/hosts still needs the ingress-host line. The whole stack is
 * reached through `http://<host>:<port>`, so without this mapping the URL does
 * not resolve and auto-open lands on a browser error page.
 *
 * Matches a real mapping only: the host must be a whole field on a line that is
 * not commented out. A bare substring test would accept "#127.0.0.1 host".
 */
export function hostsEntryPresent(hostsFile: string, host: string): boolean {
  return hostsFile
    .split("\n")
    .map((line) => line.split("#")[0])
    .some((line) => line.trim().split(/\s+/).includes(host));
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

/**
 * Build the argv for a single `kubectl port-forward` targeting a profile's
 * controller Service. One process, multiple `local:remote` positional pairs —
 * kubectl accepts several port pairs on one invocation, so a profile that
 * needs both HTTP and HTTPS (cloud-native-nginx) still needs only one PID to
 * track, matching the existing single-PID-file design.
 */
export function buildPortForwardArgv(config: ProfileConfig): string[] {
  return [
    "kubectl",
    "port-forward",
    "--namespace",
    config.controllerNamespace,
    config.controllerService,
    ...config.portPairs.map((p) => `${p.local}:${p.remote}`),
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

/** Human-readable "on :8080" / "on :8080, :8443" for log lines. */
function describePorts(config: ProfileConfig): string {
  return config.portPairs.map((p) => `:${p.local}`).join(", ");
}

/**
 * Ensure a `kubectl port-forward` to the profile's controller Service is
 * running, starting one if none is alive yet. Idempotent across repeated
 * `task minikube:up`-style runs, the same way `minikubeIsRunning` is for the
 * VM itself. One process per profile, carrying every port pair the profile
 * needs (see buildPortForwardArgv) — still a single PID to track.
 *
 * WHY NOT `minikube tunnel`: that needs a sudo password and a terminal left
 * open for the whole session. This uses the Kubernetes API connection that
 * already works (kubectl talks to it throughout the rest of this script), so
 * it needs no elevated privileges and no extra terminal.
 */
function ensurePortForward(config: ProfileConfig): void {
  const existing = readPortForwardPid();
  if (existing !== null && isProcessAlive(existing)) {
    console.log(
      `\n[minikube] port-forward already running on ${describePorts(config)} (pid ${existing})`,
    );
    return;
  }

  mkdirSync(dirname(PORT_FORWARD_PID_FILE), { recursive: true });
  const log = openSync(PORT_FORWARD_LOG_FILE, "a");
  const proc = Bun.spawn(buildPortForwardArgv(config), {
    stdout: log,
    stderr: log,
    stdin: "ignore",
  });
  proc.unref();
  Bun.write(PORT_FORWARD_PID_FILE, `${proc.pid}\n`);
  console.log(
    `\n[minikube] started port-forward on ${describePorts(config)} (pid ${proc.pid}, log: ${PORT_FORWARD_LOG_FILE})`,
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

/**
 * Final output: ONE url, opened for you.
 *
 * Deliberately just the dev-login link. Every other surface (admin console,
 * metrics, task store, agent creation) is reachable from the console once you
 * are signed in, and listing them here buried the only link that does anything
 * useful on a cold stack — the console root redirects to a Google sign-in page
 * this profile never configures, so it is a dead end. /admin/dev-login mints
 * the dev session outright and lands on /admin/agents.
 */
function printNextSteps(config: ProfileConfig): void {
  const urls = buildAccessUrls(INGRESS_HOST, config.accessPort, config.scheme);
  console.log("\n────────────────────────────────────────────────────────────");
  console.log("Shipwright is up.\n");
  console.log(`  ${urls.devLogin}\n`);
  console.log("Then create an agent:\n");
  console.log(`  ${urls.agentNew}\n`);
  console.log(
    "  Runtime: pick 'Provisioned in-cluster' and paste a Claude credential.",
  );
  console.log(
    "  No Slack needed — chat with the agent from the console's Chat tab.\n",
  );

  // Cloud-native-nginx bundles cert-manager and issues its own selfsigned
  // cert — surface the check the manual verification plan (CNH-8.2 AC2) uses
  // to confirm the Issuer/Certificate actually reached Ready before assuming
  // HTTPS just works.
  if (config.profile === "cloud-native-nginx") {
    console.log(
      "  TLS is issued by the bundled cert-manager Issuer — check it's Ready:",
    );
    console.log("    kubectl get issuer,certificate -n shipwright\n");
  }

  if (!ingressHostResolves()) {
    console.log(`${INGRESS_HOST} is not in /etc/hosts yet — add it, then open`);
    console.log("the link above:");
    console.log(
      `  echo "127.0.0.1 ${INGRESS_HOST}" | sudo tee -a /etc/hosts\n`,
    );
    return;
  }

  openInBrowser(urls.devLogin);
}

/** True when /etc/hosts maps the ingress host. Unreadable file → assume no. */
export function ingressHostResolves(
  readFile: (path: string, encoding: string) => string = (p, e) =>
    readFileSync(p, e),
): boolean {
  try {
    return hostsEntryPresent(readFile("/etc/hosts", "utf8"), INGRESS_HOST);
  } catch {
    return false;
  }
}

/** Best-effort browser launch — never fails the bring-up. */
export function openInBrowser(
  url: string,
  exec: ExecFn = realExec,
  platform: string = process.platform,
): void {
  const argv = buildOpenCommand(url, platform);
  if (argv === null) return;
  try {
    exec(argv);
  } catch {
    // No browser to launch (headless, no DISPLAY). The URL is printed above.
  }
}

/**
 * Parse `--profile <name>` from argv. Returns "addon" (the pre-existing
 * default) when the flag is absent, so every pre-CNH-8.2 invocation of this
 * script keeps behaving exactly as before.
 */
export function parseProfileArg(argv: string[]): string {
  const i = argv.indexOf("--profile");
  if (i === -1 || i === argv.length - 1) return "addon";
  return argv[i + 1];
}

/** True when `name` is a known Profile key. */
export function isKnownProfile(name: string): name is Profile {
  return Object.hasOwn(PROFILES, name);
}

async function main(): Promise<void> {
  const down = process.argv.includes("--down");

  const profileArg = parseProfileArg(process.argv);
  if (!isKnownProfile(profileArg)) {
    console.error(`[minikube] unknown --profile "${profileArg}".`);
    console.error(
      `[minikube] valid profiles: ${Object.keys(PROFILES).join(", ")}`,
    );
    process.exit(1);
  }
  const profileConfig = PROFILES[profileArg];

  const missing = missingBinaries((bin) => Bun.which(bin));
  if (missing.length > 0) {
    console.error(
      `[minikube] missing required binaries: ${missing.join(", ")}`,
    );
    console.error("[minikube] install them and re-run.");
    process.exit(1);
  }

  if (down) {
    // Teardown does not know which profile brought the stack up (it isn't
    // recorded anywhere), and `helm uninstall`/`minikube delete` target the
    // same release/namespace regardless of which controller was bundled — so
    // teardown itself needs no profile. The port-forward PID file, however,
    // always holds exactly one process regardless of profile, so killing
    // whatever is on record (not re-deriving it from a profile) is correct.
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

  runCommands(
    buildMinikubeCommands({ alreadyRunning, profile: profileArg }),
    realExec,
  );
  ensurePortForward(profileConfig);
  printNextSteps(profileConfig);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n[minikube] FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
}

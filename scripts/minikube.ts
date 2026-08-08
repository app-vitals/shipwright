#!/usr/bin/env bun
/**
 * scripts/minikube.ts — bring the full Shipwright stack up on Minikube.
 *
 * Run via `task minikube:up` / `task minikube:down`.
 *
 * WHY A SCRIPT: the sequence has four ordering constraints that are easy to get
 * wrong and produce confusing failures rather than clear errors:
 *
 *   1. VM sizing must be set at `minikube start`. The agent pod alone requests
 *      500m CPU / 2Gi memory (admin/src/agent-manifest.ts); an under-sized VM
 *      schedules it and then thrashes.
 *   2. `minikube addons enable ingress` must run BEFORE the install, or the
 *      rendered Ingress has no controller and nothing answers.
 *   3. `helm dependency build` must run BEFORE the install — Chart.lock pins the
 *      PostgreSQL subchart from an OCI registry and it is not vendored expanded.
 *   4. The /etc/hosts entry can only be written AFTER the VM has an IP.
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
    throw new Error(`command failed (exit ${result.exitCode}): ${argv.join(" ")}`);
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

function minikubeIp(): string | null {
  const result = Bun.spawnSync(["minikube", "ip"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim() || null;
}

function printNextSteps(): void {
  const ip = minikubeIp();
  console.log("\n────────────────────────────────────────────────────────────");
  console.log("Shipwright is up.\n");
  if (ip) {
    console.log("Add the ingress host to /etc/hosts (once):");
    console.log(`  echo "${ip} ${INGRESS_HOST}" | sudo tee -a /etc/hosts\n`);
  }
  console.log(`  admin console   http://${INGRESS_HOST}/`);
  console.log(`  metrics         http://${INGRESS_HOST}/dashboard`);
  console.log(`  task store      http://${INGRESS_HOST}/task-store/health\n`);
  console.log("No agent exists yet — create one at:");
  console.log(`  http://${INGRESS_HOST}/admin/agents/new\n`);
  console.log(
    "Set that agent's ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the",
  );
  console.log("admin UI before it can work.");
  console.log("Tear down with: task minikube:down");
  console.log("────────────────────────────────────────────────────────────");
}

async function main(): Promise<void> {
  const down = process.argv.includes("--down");

  const missing = missingBinaries((bin) => Bun.which(bin));
  if (missing.length > 0) {
    console.error(`[minikube] missing required binaries: ${missing.join(", ")}`);
    console.error("[minikube] install them and re-run.");
    process.exit(1);
  }

  if (down) {
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
  printNextSteps();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n[minikube] FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
}

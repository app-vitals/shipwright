/**
 * scripts/minikube.unit.test.ts
 *
 * The value of `task minikube:up` is almost entirely in the ORDER of its steps —
 * four constraints that, when violated, fail confusingly rather than loudly:
 * ingress addon before install, `helm dependency build` before install, sizing
 * only at `minikube start`, /etc/hosts only after the VM has an IP.
 *
 * These tests pin that order against the pure builder, with no VM, no Docker and
 * no network.
 */

import { describe, expect, it } from "bun:test";
import {
  buildAccessUrls,
  buildMinikubeCommands,
  buildTeardownCommands,
  type Command,
  DEPLOYMENTS,
  missingBinaries,
  runCommands,
} from "./minikube.ts";

/** Index of the first command whose argv joins to something matching `pattern`. */
function indexOf(cmds: Command[], pattern: RegExp): number {
  return cmds.findIndex((c) => pattern.test(c.argv.join(" ")));
}

function argvLines(cmds: Command[]): string[] {
  return cmds.map((c) => c.argv.join(" "));
}

describe("buildMinikubeCommands — ordering constraints", () => {
  it("enables the ingress addon BEFORE the helm install", () => {
    // Otherwise the rendered Ingress has no controller and nothing answers.
    const cmds = buildMinikubeCommands();
    const addon = indexOf(cmds, /addons enable ingress/);
    const install = indexOf(cmds, /helm upgrade --install/);
    expect(addon).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThanOrEqual(0);
    expect(addon).toBeLessThan(install);
  });

  it("waits for the ingress admission webhook AFTER enabling the addon and BEFORE the install", () => {
    // `addons enable` returns once the controller Deployment exists, not once
    // its webhook Service has a ready endpoint — installing immediately after
    // races it and helm fails with "connection refused" against the webhook.
    const cmds = buildMinikubeCommands();
    const addon = indexOf(cmds, /addons enable ingress/);
    const wait = indexOf(cmds, /wait.*ingress-nginx.*condition=ready/);
    const install = indexOf(cmds, /helm upgrade --install/);
    expect(wait).toBeGreaterThan(addon);
    expect(wait).toBeLessThan(install);
  });

  it("resolves chart dependencies BEFORE the helm install", () => {
    // Chart.lock pins the PostgreSQL subchart via OCI; it is not vendored expanded.
    const cmds = buildMinikubeCommands();
    expect(indexOf(cmds, /helm dependency build/)).toBeLessThan(
      indexOf(cmds, /helm upgrade --install/),
    );
  });

  it("starts the VM before anything else", () => {
    const cmds = buildMinikubeCommands();
    expect(indexOf(cmds, /minikube start/)).toBe(0);
  });

  it("waits for rollouts AFTER the install", () => {
    const cmds = buildMinikubeCommands();
    expect(indexOf(cmds, /rollout status/)).toBeGreaterThan(
      indexOf(cmds, /helm upgrade --install/),
    );
  });

  it("runs helm test LAST, after every rollout has been waited on", () => {
    const cmds = buildMinikubeCommands();
    const helmTest = indexOf(cmds, /helm test/);
    const lastRollout = cmds.reduce(
      (acc, c, i) => (/rollout status/.test(c.argv.join(" ")) ? i : acc),
      -1,
    );
    expect(helmTest).toBeGreaterThan(lastRollout);
    expect(helmTest).toBe(cmds.length - 1);
  });
});

describe("buildMinikubeCommands — VM sizing", () => {
  it("defaults to a size that can actually hold one agent pod", () => {
    // The agent requests 500m CPU / 2Gi memory on its own; below 4 CPU / 6Gi the
    // pod schedules and then thrashes.
    const start = argvLines(buildMinikubeCommands())[0];
    expect(start).toContain("--cpus=4");
    expect(start).toContain("--memory=8192");
    expect(start).toContain("--disk-size=40g");
  });

  it("honors explicit sizing overrides", () => {
    const start = argvLines(
      buildMinikubeCommands({ cpus: 6, memoryMb: 12288, disk: "60g" }),
    )[0];
    expect(start).toContain("--cpus=6");
    expect(start).toContain("--memory=12288");
    expect(start).toContain("--disk-size=60g");
  });

  it("skips `minikube start` when the VM is already running", () => {
    // Sizing flags are ignored on an existing VM, so silently "resizing" is not
    // on offer — the entrypoint tells the user to tear down first instead.
    const cmds = buildMinikubeCommands({ alreadyRunning: true });
    expect(indexOf(cmds, /minikube start/)).toBe(-1);
    // ...but the ingress addon is still ensured (it is idempotent).
    expect(indexOf(cmds, /addons enable ingress/)).toBe(0);
  });
});

describe("buildMinikubeCommands — install shape", () => {
  it("uses upgrade --install so re-running is idempotent", () => {
    const install = argvLines(buildMinikubeCommands()).find((l) =>
      l.includes("helm upgrade"),
    );
    expect(install).toContain("helm upgrade --install shipwright");
  });

  it("installs the full-stack minikube values profile", () => {
    const install = argvLines(buildMinikubeCommands()).find((l) =>
      l.includes("helm upgrade"),
    );
    expect(install).toContain(
      "--values charts/shipwright/examples/values-minikube.yaml",
    );
  });

  it("creates the namespace and waits, with a timeout that fits image pulls", () => {
    const install = argvLines(buildMinikubeCommands()).find((l) =>
      l.includes("helm upgrade"),
    );
    expect(install).toContain("--namespace shipwright");
    expect(install).toContain("--create-namespace");
    expect(install).toContain("--wait");
    expect(install).toContain("--timeout 15m");
  });

  it("waits on every service Deployment individually", () => {
    // `--wait` alone reports one aggregate failure, which turns "which service
    // is broken?" into a guess.
    const lines = argvLines(buildMinikubeCommands());
    for (const deployment of DEPLOYMENTS) {
      expect(
        lines.some((l) => l.includes(`rollout status deployment/${deployment}`)),
      ).toBe(true);
    }
  });

  it("covers all four Shipwright services", () => {
    expect([...DEPLOYMENTS]).toEqual([
      "shipwright-admin",
      "shipwright-metrics",
      "shipwright-task-store",
      "shipwright-chat",
    ]);
  });

  it("can skip helm test", () => {
    const cmds = buildMinikubeCommands({ runHelmTest: false });
    expect(indexOf(cmds, /helm test/)).toBe(-1);
  });

  it("honors release/namespace/chart overrides consistently", () => {
    const lines = argvLines(
      buildMinikubeCommands({ release: "sw2", namespace: "other" }),
    );
    expect(lines.some((l) => l.includes("helm upgrade --install sw2"))).toBe(true);
    expect(lines.some((l) => l.includes("helm test sw2 --namespace other"))).toBe(
      true,
    );
    expect(
      lines.every((l) => !l.includes("--namespace shipwright")),
    ).toBe(true);
  });
});

describe("buildTeardownCommands", () => {
  it("uninstalls the release BEFORE deleting the VM", () => {
    // Helm needs a live API server to run its hooks and drop PVCs.
    const cmds = buildTeardownCommands();
    expect(indexOf(cmds, /helm uninstall/)).toBeLessThan(
      indexOf(cmds, /minikube delete/),
    );
  });

  it("targets the configured release and namespace", () => {
    const lines = argvLines(buildTeardownCommands({ release: "sw2", namespace: "n" }));
    expect(lines[0]).toBe("helm uninstall sw2 --namespace n");
  });
});

describe("buildAccessUrls", () => {
  it("doubles the /dashboard segment for metrics", () => {
    // The metrics service mounts its whole router under provider.basePath
    // (set to "/dashboard" in examples/values-minikube.yaml), and its own
    // dashboard route is itself named "/dashboard" — the two compose. A bare
    // "/dashboard" 404s; only "/dashboard/dashboard" resolves.
    const urls = buildAccessUrls("shipwright.local", 8080);
    expect(urls.metrics).toBe("http://shipwright.local:8080/dashboard/dashboard");
  });

  it("builds the admin, task-store, and agent-creation URLs against the given host and port", () => {
    const urls = buildAccessUrls("shipwright.local", 8080);
    expect(urls.admin).toBe("http://shipwright.local:8080/");
    expect(urls.taskStore).toBe("http://shipwright.local:8080/task-store/health");
    expect(urls.agentNew).toBe("http://shipwright.local:8080/admin/agents/new");
  });

  it("points the login URL at /admin/dev-login, not the OAuth login page", () => {
    // auth.mode=open configures no Google OAuth, so /admin/login is a dead end.
    // Only /admin/dev-login mints a session on this profile.
    const urls = buildAccessUrls("shipwright.local", 8080);
    expect(urls.devLogin).toBe("http://shipwright.local:8080/admin/dev-login");
    expect(urls.devLogin).not.toContain("/admin/login");
  });

  it("honors an arbitrary host and port", () => {
    const urls = buildAccessUrls("127.0.0.1", 9999);
    expect(urls.admin).toBe("http://127.0.0.1:9999/");
    expect(urls.metrics).toBe("http://127.0.0.1:9999/dashboard/dashboard");
  });
});

describe("missingBinaries", () => {
  it("returns nothing when every required binary is present", () => {
    expect(missingBinaries(() => "/usr/local/bin/x")).toEqual([]);
  });

  it("reports every missing binary, not just the first", () => {
    expect(missingBinaries(() => null)).toEqual(["minikube", "helm", "kubectl"]);
  });

  it("reports only the ones actually absent", () => {
    expect(missingBinaries((bin) => (bin === "helm" ? null : "/bin/x"))).toEqual([
      "helm",
    ]);
  });
});

describe("runCommands", () => {
  it("executes every built command in order through the injected exec", () => {
    const ran: string[][] = [];
    const cmds = buildMinikubeCommands();
    runCommands(cmds, (argv) => ran.push(argv));
    expect(ran).toEqual(cmds.map((c) => c.argv));
  });

  it("propagates a failing command instead of continuing", () => {
    // A failed `helm dependency build` must not be followed by an install that
    // then fails for a confusing, unrelated reason.
    const ran: string[][] = [];
    expect(() =>
      runCommands(buildMinikubeCommands(), (argv) => {
        ran.push(argv);
        if (argv.join(" ").includes("dependency build")) {
          throw new Error("boom");
        }
      }),
    ).toThrow("boom");
    expect(ran.some((a) => a.join(" ").includes("helm upgrade"))).toBe(false);
  });
});

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
  buildOpenCommand,
  buildPortForwardArgv,
  buildTeardownCommands,
  type Command,
  hostsEntryPresent,
  ingressHostResolves,
  openInBrowser,
  DEPLOYMENTS,
  missingBinaries,
  PROFILES,
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
        lines.some((l) =>
          l.includes(`rollout status deployment/${deployment}`),
        ),
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
    expect(lines.some((l) => l.includes("helm upgrade --install sw2"))).toBe(
      true,
    );
    expect(
      lines.some((l) => l.includes("helm test sw2 --namespace other")),
    ).toBe(true);
    expect(lines.every((l) => !l.includes("--namespace shipwright"))).toBe(
      true,
    );
  });
});

describe("buildMinikubeCommands — addon profile regression (byte-identical)", () => {
  it("emits the exact same command list with no profile opt as with profile: 'addon'", () => {
    // Acceptance criterion 1: `task minikube:up` must be byte-identical to
    // before this task. Compare the default call against an explicit
    // `profile: "addon"` call — both must produce identical argv lists.
    const noProfile = buildMinikubeCommands();
    const explicitAddon = buildMinikubeCommands({ profile: "addon" });
    expect(explicitAddon).toEqual(noProfile);
  });

  it("pins the full default (addon) command list, argv for argv", () => {
    // A hard snapshot of the pre-cloud-native-profile behavior. Any accidental
    // reordering, insertion, or removal for the addon profile fails this test.
    const cmds = buildMinikubeCommands();
    expect(cmds.map((c) => c.argv)).toEqual([
      ["minikube", "start", "--cpus=4", "--memory=8192", "--disk-size=40g"],
      ["minikube", "addons", "enable", "ingress"],
      [
        "kubectl",
        "wait",
        "--namespace",
        "ingress-nginx",
        "--for=condition=ready",
        "pod",
        "--selector=app.kubernetes.io/component=controller",
        "--timeout=120s",
      ],
      ["helm", "dependency", "build", "charts/shipwright"],
      [
        "helm",
        "upgrade",
        "--install",
        "shipwright",
        "charts/shipwright",
        "--namespace",
        "shipwright",
        "--create-namespace",
        "--values",
        "charts/shipwright/examples/values-minikube.yaml",
        "--wait",
        "--timeout",
        "15m",
      ],
      [
        "kubectl",
        "rollout",
        "status",
        "deployment/shipwright-admin",
        "--namespace",
        "shipwright",
        "--timeout=5m",
      ],
      [
        "kubectl",
        "rollout",
        "status",
        "deployment/shipwright-metrics",
        "--namespace",
        "shipwright",
        "--timeout=5m",
      ],
      [
        "kubectl",
        "rollout",
        "status",
        "deployment/shipwright-task-store",
        "--namespace",
        "shipwright",
        "--timeout=5m",
      ],
      [
        "kubectl",
        "rollout",
        "status",
        "deployment/shipwright-chat",
        "--namespace",
        "shipwright",
        "--timeout=5m",
      ],
      ["helm", "test", "shipwright", "--namespace", "shipwright"],
    ]);
  });
});

describe("buildMinikubeCommands — cloud-native profiles", () => {
  it("cloud-native-nginx skips the minikube ingress addon enable step", () => {
    const cmds = buildMinikubeCommands({ profile: "cloud-native-nginx" });
    expect(indexOf(cmds, /addons enable ingress/)).toBe(-1);
  });

  it("cloud-native-nginx skips the ingress-nginx namespace webhook wait", () => {
    const cmds = buildMinikubeCommands({ profile: "cloud-native-nginx" });
    expect(indexOf(cmds, /wait.*ingress-nginx.*condition=ready/)).toBe(-1);
  });

  it("cloud-native-traefik skips the minikube ingress addon enable step", () => {
    const cmds = buildMinikubeCommands({ profile: "cloud-native-traefik" });
    expect(indexOf(cmds, /addons enable ingress/)).toBe(-1);
  });

  it("cloud-native-traefik skips the ingress-nginx namespace webhook wait", () => {
    const cmds = buildMinikubeCommands({ profile: "cloud-native-traefik" });
    expect(indexOf(cmds, /wait.*ingress-nginx.*condition=ready/)).toBe(-1);
  });

  it("still resolves chart dependencies BEFORE the install for both cloud-native profiles", () => {
    for (const profile of ["cloud-native-nginx", "cloud-native-traefik"] as const) {
      const cmds = buildMinikubeCommands({ profile });
      expect(indexOf(cmds, /helm dependency build/)).toBeLessThan(
        indexOf(cmds, /helm upgrade --install/),
      );
    }
  });

  it("resolves the cloud-native-nginx values file from the profile by default", () => {
    const install = argvLines(
      buildMinikubeCommands({ profile: "cloud-native-nginx" }),
    ).find((l) => l.includes("helm upgrade"));
    expect(install).toContain(
      "--values charts/shipwright/ci/cloud-native-nginx-values.yaml",
    );
  });

  it("resolves the cloud-native-traefik values file from the profile by default", () => {
    const install = argvLines(
      buildMinikubeCommands({ profile: "cloud-native-traefik" }),
    ).find((l) => l.includes("helm upgrade"));
    expect(install).toContain(
      "--values charts/shipwright/ci/cloud-native-traefik-values.yaml",
    );
  });

  it("an explicit valuesFile override still wins over the profile default", () => {
    const install = argvLines(
      buildMinikubeCommands({
        profile: "cloud-native-nginx",
        valuesFile: "custom-values.yaml",
      }),
    ).find((l) => l.includes("helm upgrade"));
    expect(install).toContain("--values custom-values.yaml");
  });

  it("waits on the bundled ingress-nginx controller Deployment in the shipwright namespace", () => {
    const lines = argvLines(
      buildMinikubeCommands({ profile: "cloud-native-nginx" }),
    );
    expect(
      lines.some((l) =>
        l.includes(
          "rollout status deployment/shipwright-ingress-nginx-controller --namespace shipwright",
        ),
      ),
    ).toBe(true);
  });

  it("waits on the bundled traefik controller Deployment in the shipwright namespace", () => {
    const lines = argvLines(
      buildMinikubeCommands({ profile: "cloud-native-traefik" }),
    );
    expect(
      lines.some((l) =>
        l.includes(
          "rollout status deployment/shipwright-traefik --namespace shipwright",
        ),
      ),
    ).toBe(true);
  });

  it("waits on the bundled controller AFTER the install and alongside the app Deployments", () => {
    const cmds = buildMinikubeCommands({ profile: "cloud-native-nginx" });
    const install = indexOf(cmds, /helm upgrade --install/);
    const controllerWait = indexOf(
      cmds,
      /rollout status deployment\/shipwright-ingress-nginx-controller/,
    );
    const helmTest = indexOf(cmds, /helm test/);
    expect(controllerWait).toBeGreaterThan(install);
    expect(controllerWait).toBeLessThan(helmTest);
  });

  it("still waits on every app Deployment for cloud-native profiles too", () => {
    const lines = argvLines(
      buildMinikubeCommands({ profile: "cloud-native-traefik" }),
    );
    for (const deployment of DEPLOYMENTS) {
      expect(
        lines.some((l) =>
          l.includes(`rollout status deployment/${deployment}`),
        ),
      ).toBe(true);
    }
  });

  it("rejects an unknown profile key at the PROFILES map level", () => {
    expect(Object.keys(PROFILES).sort()).toEqual(
      ["addon", "cloud-native-nginx", "cloud-native-traefik"].sort(),
    );
  });
});

describe("buildPortForwardArgv — profile-aware targets", () => {
  it("addon profile forwards svc/ingress-nginx-controller in the ingress-nginx namespace on 8080:80", () => {
    const argv = buildPortForwardArgv(PROFILES.addon);
    expect(argv).toEqual([
      "kubectl",
      "port-forward",
      "--namespace",
      "ingress-nginx",
      "svc/ingress-nginx-controller",
      "8080:80",
    ]);
  });

  it("cloud-native-nginx forwards svc/shipwright-ingress-nginx-controller in the shipwright namespace on both 8080:80 and 8443:443", () => {
    const argv = buildPortForwardArgv(PROFILES["cloud-native-nginx"]);
    expect(argv).toEqual([
      "kubectl",
      "port-forward",
      "--namespace",
      "shipwright",
      "svc/shipwright-ingress-nginx-controller",
      "8080:80",
      "8443:443",
    ]);
  });

  it("cloud-native-traefik forwards svc/shipwright-traefik in the shipwright namespace on 8080:80 only", () => {
    const argv = buildPortForwardArgv(PROFILES["cloud-native-traefik"]);
    expect(argv).toEqual([
      "kubectl",
      "port-forward",
      "--namespace",
      "shipwright",
      "svc/shipwright-traefik",
      "8080:80",
    ]);
  });
});

describe("buildAccessUrls — profile-aware scheme", () => {
  it("defaults to http, unchanged for existing callers", () => {
    const urls = buildAccessUrls("shipwright.local", 8080);
    expect(urls.admin).toBe("http://shipwright.local:8080/");
  });

  it("builds https URLs when an https scheme is passed explicitly", () => {
    const urls = buildAccessUrls("shipwright.local", 8443, "https");
    expect(urls.admin).toBe("https://shipwright.local:8443/");
    expect(urls.devLogin).toBe("https://shipwright.local:8443/admin/dev-login");
    expect(urls.taskStore).toBe(
      "https://shipwright.local:8443/task-store/health",
    );
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
    const lines = argvLines(
      buildTeardownCommands({ release: "sw2", namespace: "n" }),
    );
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
    expect(urls.metrics).toBe(
      "http://shipwright.local:8080/dashboard/dashboard",
    );
  });

  it("builds the admin, task-store, and agent-creation URLs against the given host and port", () => {
    const urls = buildAccessUrls("shipwright.local", 8080);
    expect(urls.admin).toBe("http://shipwright.local:8080/");
    expect(urls.taskStore).toBe(
      "http://shipwright.local:8080/task-store/health",
    );
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

describe("buildOpenCommand", () => {
  it("uses `open` on macOS and `xdg-open` on Linux", () => {
    expect(buildOpenCommand("http://x/y", "darwin")).toEqual([
      "open",
      "http://x/y",
    ]);
    expect(buildOpenCommand("http://x/y", "linux")).toEqual([
      "xdg-open",
      "http://x/y",
    ]);
  });

  it("returns null on a platform with no known opener", () => {
    // The caller treats null as "skip"; bringing the stack up must not depend
    // on being able to launch a browser.
    expect(buildOpenCommand("http://x/y", "win32")).toBeNull();
    expect(buildOpenCommand("http://x/y", "aix")).toBeNull();
  });
});

describe("hostsEntryPresent", () => {
  it("finds the host as a whole field on an active line", () => {
    expect(
      hostsEntryPresent("127.0.0.1 shipwright.local", "shipwright.local"),
    ).toBe(true);
    expect(
      hostsEntryPresent(
        "127.0.0.1\tlocalhost shipwright.local\n",
        "shipwright.local",
      ),
    ).toBe(true);
  });

  it("ignores commented-out mappings", () => {
    // A bare substring test would accept this and then auto-open a dead link.
    expect(
      hostsEntryPresent("# 127.0.0.1 shipwright.local", "shipwright.local"),
    ).toBe(false);
    expect(
      hostsEntryPresent(
        "127.0.0.1 other # shipwright.local",
        "shipwright.local",
      ),
    ).toBe(false);
  });

  it("does not match a host that merely contains the name", () => {
    expect(
      hostsEntryPresent(
        "127.0.0.1 not-shipwright.local.example",
        "shipwright.local",
      ),
    ).toBe(false);
  });

  it("returns false for an empty hosts file", () => {
    expect(hostsEntryPresent("", "shipwright.local")).toBe(false);
  });
});

describe("ingressHostResolves", () => {
  it("returns true when the injected reader finds the host mapped", () => {
    expect(
      ingressHostResolves(() => "127.0.0.1 shipwright.local\n"),
    ).toBe(true);
  });

  it("returns false when the injected reader finds no mapping", () => {
    expect(
      ingressHostResolves(() => "127.0.0.1 localhost\n"),
    ).toBe(false);
  });

  it("returns false (not throw) when the injected reader fails", () => {
    // Mirrors an unreadable /etc/hosts — the try/catch swallows the error.
    expect(
      ingressHostResolves(() => {
        throw new Error("EACCES");
      }),
    ).toBe(false);
  });
});

describe("openInBrowser", () => {
  it("execs the argv built by buildOpenCommand for the given platform", () => {
    const calls: string[][] = [];
    openInBrowser("http://x/y", (argv) => calls.push(argv), "darwin");
    expect(calls).toEqual([["open", "http://x/y"]]);
  });

  it("does not call exec when buildOpenCommand has no known opener", () => {
    const calls: string[][] = [];
    openInBrowser("http://x/y", (argv) => calls.push(argv), "win32");
    expect(calls).toEqual([]);
  });

  it("swallows a failing exec instead of throwing", () => {
    // No browser to launch (headless, no DISPLAY) — the caller must not crash.
    expect(() =>
      openInBrowser(
        "http://x/y",
        () => {
          throw new Error("no display");
        },
        "linux",
      ),
    ).not.toThrow();
  });
});

describe("missingBinaries", () => {
  it("returns nothing when every required binary is present", () => {
    expect(missingBinaries(() => "/usr/local/bin/x")).toEqual([]);
  });

  it("reports every missing binary, not just the first", () => {
    expect(missingBinaries(() => null)).toEqual([
      "minikube",
      "helm",
      "kubectl",
    ]);
  });

  it("reports only the ones actually absent", () => {
    expect(
      missingBinaries((bin) => (bin === "helm" ? null : "/bin/x")),
    ).toEqual(["helm"]);
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

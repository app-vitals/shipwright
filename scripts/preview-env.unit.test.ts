/**
 * scripts/preview-env.unit.test.ts
 *
 * Pins the ORDER and the isolation guarantees of the preview bring-up against
 * the pure builder: no cluster, no Docker, no network.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "./minikube.ts";
import {
  buildPreviewCommands,
  buildTargetsEnv,
  generatePreviewSecrets,
  PORT_FORWARDS,
  PREVIEW_DEPLOYMENTS,
  type PreviewOpts,
  type PreviewSecrets,
  previewSecretFiles,
  withSecretFiles,
} from "./preview-env.ts";
import { gateIngressValues, helmSetEscape } from "./preview-gate.ts";

const CTX = "kind-preview";
const OPTS: PreviewOpts = { context: CTX, chartPath: "charts/shipwright" };

let counter = 0;
const fakeHex = (bytes: number): string => {
  counter += 1;
  return counter.toString(16).padStart(2, "0").repeat(bytes);
};

function secrets(): PreviewSecrets {
  return generatePreviewSecrets(fakeHex);
}

function lines(cmds: Command[]): string[] {
  return cmds.map((c) => c.argv.join(" "));
}

function indexOf(cmds: Command[], pattern: RegExp): number {
  return lines(cmds).findIndex((l) => pattern.test(l));
}

describe("buildPreviewCommands", () => {
  it("never emits a kind or minikube command", () => {
    const cmds = buildPreviewCommands(OPTS, secrets());
    expect(cmds.some((c) => c.kind !== "kubectl" && c.kind !== "helm")).toBe(
      false,
    );
    for (const cmd of cmds) {
      expect(["kind", "minikube"]).not.toContain(cmd.argv[0]);
    }
  });

  it("scopes every kubectl and helm command to the given context", () => {
    const cmds = buildPreviewCommands(OPTS, secrets());
    for (const { argv } of cmds) {
      if (argv[0] === "kubectl") {
        const i = argv.indexOf("--context");
        expect(argv[i + 1]).toBe(CTX);
      } else if (argv[0] === "helm") {
        const i = argv.indexOf("--kube-context");
        expect(argv[i + 1]).toBe(CTX);
      } else {
        throw new Error(`unexpected binary ${argv[0]}`);
      }
    }
  });

  it("creates all three Secrets before the helm install", () => {
    const cmds = buildPreviewCommands(OPTS, secrets());
    const install = indexOf(cmds, /helm .*upgrade --install/);
    for (const name of [
      "shipwright-preview-mcp",
      "shipwright-preview-task-store-seed",
      "shipwright-preview-metrics",
    ]) {
      const i = indexOf(cmds, new RegExp(`create secret generic ${name}\\b`));
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(install);
    }
  });

  it("waits for the ingress controller before the helm install", () => {
    const cmds = buildPreviewCommands(OPTS, secrets());
    const install = indexOf(cmds, /helm .*upgrade --install/);
    const wait = indexOf(
      cmds,
      /rollout status deployment\/ingress-nginx-controller/,
    );
    expect(wait).toBeGreaterThanOrEqual(0);
    expect(wait).toBeLessThan(install);
  });

  it("builds chart dependencies before the helm install", () => {
    const cmds = buildPreviewCommands(OPTS, secrets());
    const dep = indexOf(cmds, /helm .*dependency build/);
    expect(dep).toBeGreaterThanOrEqual(0);
    expect(dep).toBeLessThan(indexOf(cmds, /helm .*upgrade --install/));
  });

  it("installs with the preview values file, --wait and the default timeout", () => {
    const cmds = buildPreviewCommands(OPTS, secrets());
    const install = lines(cmds)[indexOf(cmds, /helm .*upgrade --install/)];
    expect(install).toContain("charts/shipwright/examples/values-preview.yaml");
    expect(install).toContain("--wait");
    expect(install).toContain("--timeout 600s");
  });

  it("sets the ingress host and the admin base URL when a host is given", () => {
    const cmds = buildPreviewCommands(
      { ...OPTS, host: "abc.example" },
      secrets(),
    );
    const install = lines(cmds)[indexOf(cmds, /helm .*upgrade --install/)];
    expect(install).toContain("networking.ingress.host=abc.example");
    expect(install).toContain("admin.appBaseUrl=https://abc.example");
  });

  it("leaves host overrides out when no host is given", () => {
    const install = lines(buildPreviewCommands(OPTS, secrets())).find((l) =>
      /helm .*upgrade --install/.test(l),
    );
    expect(install).not.toContain("networking.ingress.host");
    expect(install).not.toContain("admin.appBaseUrl");
  });

  it("emits no gate resources and no auth annotation without a gate", () => {
    const cmds = buildPreviewCommands(OPTS, secrets());
    const all = lines(cmds).join("\n");
    expect(all).not.toContain("shipwright-preview-gate");
    for (const { argv } of cmds) {
      for (const a of argv) {
        expect(a).not.toContain("auth-");
        expect(a).not.toContain("configuration-snippet");
        expect(a).not.toContain("allow-snippet-annotations");
      }
    }
  });

  describe("with a gate", () => {
    const gated = (): Command[] =>
      buildPreviewCommands(
        { ...OPTS, gate: { htpasswdFile: "/tmp/htpasswd" } },
        secrets(),
      );

    it("creates the gate Secret from the htpasswd file before the install", () => {
      const cmds = gated();
      const i = indexOf(
        cmds,
        /create secret generic shipwright-preview-gate .*--from-file=auth=\/tmp\/htpasswd/,
      );
      expect(i).toBeGreaterThanOrEqual(0);
      expect(lines(cmds)[i]).toContain("--namespace shipwright");
      expect(i).toBeLessThan(indexOf(cmds, /helm .*upgrade --install/));
    });

    it("installs with every gateIngressValues pair as an escaped --set", () => {
      const cmds = gated();
      const { argv } = cmds[indexOf(cmds, /helm .*upgrade --install/)];
      for (const [k, v] of gateIngressValues()) {
        const arg = `networking.ingress.annotations.${helmSetEscape(k)}=${v}`;
        const at = argv.indexOf(arg);
        expect(at).toBeGreaterThan(0);
        expect(argv[at - 1]).toBe("--set");
      }
    });

    it("enables snippet annotations on the controller before it is awaited", () => {
      const cmds = gated();
      const patch = indexOf(cmds, /patch configmap ingress-nginx-controller/);
      expect(patch).toBeGreaterThanOrEqual(0);
      expect(lines(cmds)[patch]).toContain("allow-snippet-annotations");
      expect(patch).toBeLessThan(
        indexOf(cmds, /rollout status deployment\/ingress-nginx-controller/),
      );
    });
  });

  it("ends by waiting for every preview Deployment", () => {
    const cmds = buildPreviewCommands(OPTS, secrets());
    const tail = lines(cmds).slice(-PREVIEW_DEPLOYMENTS.length);
    expect(PREVIEW_DEPLOYMENTS).toContain("shipwright-mcp-server");
    PREVIEW_DEPLOYMENTS.forEach((name, i) => {
      expect(tail[i]).toContain(`rollout status deployment/${name}`);
    });
  });

  it("keeps secret values out of every argv and label", () => {
    const s = secrets();
    const cmds = buildPreviewCommands(OPTS, s);
    for (const cmd of cmds) {
      for (const value of [s.mcpServerToken, s.taskStoreToken]) {
        expect(cmd.label).not.toContain(value);
        expect(cmd.argv.join(" ")).not.toContain(value);
      }
    }
  });

  it("reads Secret data from files under the given secrets directory", () => {
    const cmds = buildPreviewCommands(
      { ...OPTS, secretsDir: "/run/preview" },
      secrets(),
    );
    const create = lines(cmds).filter((l) =>
      l.includes("create secret generic"),
    );
    expect(create).toHaveLength(3);
    for (const l of create) expect(l).toContain("--from-file=");
    expect(create.join("\n")).toContain("/run/preview/");
  });
});

describe("generatePreviewSecrets", () => {
  it("returns two different tokens of at least 32 hex characters", () => {
    const s = secrets();
    expect(s.mcpServerToken).toMatch(/^[0-9a-f]{32,}$/);
    expect(s.taskStoreToken).toMatch(/^[0-9a-f]{32,}$/);
    expect(s.mcpServerToken).not.toBe(s.taskStoreToken);
  });
});

describe("buildTargetsEnv", () => {
  it("maps the forwarded ports and tokens to PREVIEW_* variables", () => {
    const s = secrets();
    expect(buildTargetsEnv(s)).toEqual({
      PREVIEW_ADMIN_URL: "http://127.0.0.1:13001",
      PREVIEW_METRICS_URL: "http://127.0.0.1:13460",
      PREVIEW_TASK_STORE_URL: "http://127.0.0.1:13002",
      PREVIEW_CHAT_URL: "http://127.0.0.1:13003",
      PREVIEW_MCP_URL: "http://127.0.0.1:13004",
      PREVIEW_TASK_STORE_TOKEN: s.taskStoreToken,
      PREVIEW_MCP_TOKEN: s.mcpServerToken,
    });
  });
});

describe("PORT_FORWARDS", () => {
  it("uses the fixed local ports", () => {
    const locals = Object.fromEntries(
      PORT_FORWARDS.map((p) => [p.name, p.local]),
    );
    expect(locals).toEqual({
      admin: 13001,
      metrics: 13460,
      taskStore: 13002,
      chat: 13003,
      mcp: 13004,
      ingress: 18080,
    });
  });
});

describe("secret files", () => {
  it("shares the task-store token across the three Secrets", () => {
    const s = secrets();
    const files = previewSecretFiles(s);
    const values = Object.values(files).map((f) => f.value);
    expect(values.filter((v) => v === s.taskStoreToken)).toHaveLength(3);
    expect(values).toContain(s.mcpServerToken);
  });

  it("writes files for the callback and removes them afterwards", () => {
    const s = secrets();
    const base = mkdtempSync(join(tmpdir(), "preview-env-test-"));
    let seenDir = "";
    try {
      withSecretFiles(s, base, (dir) => {
        seenDir = dir;
        const first = Object.keys(previewSecretFiles(s))[0];
        expect(readFileSync(join(dir, first), "utf8").length).toBeGreaterThan(
          0,
        );
      });
      expect(existsSync(seenDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("removes the files even when the callback throws", () => {
    const base = mkdtempSync(join(tmpdir(), "preview-env-test-"));
    let seenDir = "";
    try {
      expect(() =>
        withSecretFiles(secrets(), base, (dir) => {
          seenDir = dir;
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(existsSync(seenDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

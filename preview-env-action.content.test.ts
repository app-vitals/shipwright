/**
 * Content guard for .github/actions/preview-env/action.yml: the composite
 * action that builds the five preview images from untrusted source, side-loads
 * them into a kind cluster and brings the stack up with the trusted script.
 * It must be a composite action (not a reusable workflow) so the cluster
 * survives to the caller, and must never feed secrets or build args to a build.
 *
 * Lives at the repo root (not under .github/) because `bun test` never walks
 * dot-directories.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Action = {
  inputs: Record<string, { required?: boolean }>;
  outputs: Record<string, { value?: string }>;
  runs: { using: string; steps: Step[] };
};

const text = readFileSync(
  join(ROOT, ".github/actions/preview-env/action.yml"),
  "utf8",
);
const action = Bun.YAML.parse(text) as Action;
const steps = action.runs.steps;
const builds = steps.filter((s) =>
  s.uses?.startsWith("docker/build-push-action@"),
);

describe("preview-env composite action", () => {
  it("is a composite action", () => {
    expect(action.runs.using).toBe("composite");
  });

  it("declares the documented inputs and output", () => {
    expect(action.inputs["source-path"]?.required).toBe(true);
    expect(action.inputs["trusted-path"]?.required).toBe(true);
    expect(action.inputs.host?.required).toBeFalsy();
    expect(action.inputs["htpasswd-file"]?.required).toBeFalsy();
    expect(action.outputs["env-file"]).toBeDefined();
  });

  it("references no secrets, environment or cloudflared", () => {
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/^\s*environment:/m);
    expect(text).not.toContain("cloudflared");
  });

  it("SHA-pins every third-party action", () => {
    const uses = steps.map((s) => s.uses).filter((u): u is string => !!u);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      if (u.startsWith("./")) continue;
      expect(u).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("adds chart repos via the local helm-repos action", () => {
    expect(steps.some((s) => s.uses === "./.github/actions/helm-repos")).toBe(
      true,
    );
  });

  it("creates the kind cluster named preview", () => {
    const kind = steps.find((s) => s.uses?.startsWith("helm/kind-action@"));
    expect(kind?.with?.cluster_name).toBe("preview");
  });

  it("builds the five images with source-path as context", () => {
    expect(builds.length).toBe(5);
    for (const b of builds) {
      expect(String(b.with?.context)).toContain("inputs.source-path");
      expect(String(b.with?.file)).toContain("inputs.source-path");
    }
    const tags = builds.map((b) => String(b.with?.tags)).join("\n");
    for (const svc of [
      "admin",
      "metrics",
      "task-store",
      "mcp-server",
      "agent",
    ]) {
      expect(tags).toContain(`shipwright-${svc}:0.1.0`);
    }
  });

  it("uses a per-service GitHub Actions layer cache", () => {
    const scopes = new Set<string>();
    for (const b of builds) {
      expect(String(b.with?.["cache-from"])).toContain("type=gha");
      expect(String(b.with?.["cache-to"])).toContain("type=gha");
      const m = String(b.with?.["cache-from"]).match(/scope=([^,\s]+)/);
      expect(m).not.toBeNull();
      scopes.add(m?.[1] ?? "");
    }
    expect(scopes.size).toBe(5);
  });

  it("passes no build args or secrets to builds", () => {
    for (const b of builds) {
      expect(Object.keys(b.with ?? {})).not.toContain("build-args");
      expect(Object.keys(b.with ?? {})).not.toContain("secrets");
      expect(Object.keys(b.with ?? {})).not.toContain("secret-files");
    }
    expect(text).not.toContain("--build-arg");
    expect(text).not.toContain("--secret");
  });

  it("side-loads images into the preview cluster", () => {
    const load = steps.find((s) => s.run?.includes("kind load docker-image"));
    expect(load?.run).toContain("--name preview");
  });

  it("runs the bring-up script from trusted-path against the source chart", () => {
    const up = steps.find((s) => s.run?.includes("scripts/preview-env.ts"));
    expect(up).toBeDefined();
    expect(up?.run).toContain("--context kind-preview");
    expect(up?.run).toContain("--env-out");
    expect(up?.run).toContain("--htpasswd-file");
    expect(up?.run).toContain("--host");
    expect(JSON.stringify(up)).toContain("inputs.trusted-path");
    expect(JSON.stringify(up)).toContain("inputs.source-path");
  });
});

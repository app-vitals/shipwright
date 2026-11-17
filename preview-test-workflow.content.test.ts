/**
 * Content guard for .github/workflows/preview-test.yml: the automatic preview
 * test runs on untrusted PR code (including forks), so it must be
 * pull_request-only, read-only, secret-free and SHA-pinned.
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
  if?: string;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number;
  steps: Step[];
};
type Workflow = {
  on: Record<string, unknown> | string | string[];
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
};

const text = readFileSync(
  join(ROOT, ".github/workflows/preview-test.yml"),
  "utf8",
);
const wf = Bun.YAML.parse(text) as Workflow;
const allSteps = Object.values(wf.jobs).flatMap((j) => j.steps);

describe("preview-test.yml", () => {
  it("triggers only on pull_request", () => {
    expect(Object.keys(wf.on as Record<string, unknown>)).toEqual([
      "pull_request",
    ]);
  });

  it("has contents: read only", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("references no secrets, environment or cloudflared", () => {
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/^\s*environment:/m);
    expect(text).not.toContain("cloudflared");
  });

  it("SHA-pins every third-party action", () => {
    const uses = allSteps.map((s) => s.uses).filter((u): u is string => !!u);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      if (u.startsWith("./")) continue;
      expect(u).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("cancels superseded runs per PR number", () => {
    expect(wf.concurrency.group).toContain("github.event.pull_request.number");
    expect(wf.concurrency["cancel-in-progress"]).toBe(true);
  });

  it("has a fail-open changes job covering the preview surface", () => {
    const changes = wf.jobs.changes;
    expect(changes).toBeDefined();
    const run = changes.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("=true");
    for (const p of [
      "charts/",
      "admin",
      "metrics",
      "task-store",
      "mcp-server",
      "agent",
      "preview/",
      "scripts/preview-",
      ".github/actions/preview-env/",
      "preview-test\\.yml",
      "preview\\.yml",
      "package\\.json",
      "bun\\.lock",
    ]) {
      expect(run).toContain(p);
    }
  });

  it("gates a 30-minute preview-test job on changes", () => {
    const job = wf.jobs["preview-test"];
    expect(job["timeout-minutes"]).toBe(30);
    expect(job.needs).toBe("changes");
    expect(job.if).toContain("needs.changes.outputs");
  });

  it("uses the preview-env action with the PR source as source-path", () => {
    const step = wf.jobs["preview-test"].steps.find(
      (s) => s.uses === "./.github/actions/preview-env",
    );
    expect(step?.with?.["source-path"]).toBeDefined();
    expect(step?.with?.["trusted-path"]).toBeDefined();
  });

  it("runs helm test then the canary against the env file", () => {
    const runs = wf.jobs["preview-test"].steps.map((s) => s.run ?? "");
    const helm = runs.findIndex((r) =>
      /helm test shipwright\b.*--namespace shipwright|helm test shipwright\b.*-n shipwright/.test(
        r,
      ),
    );
    const canary = runs.findIndex((r) =>
      r.includes("task preview:canary ENV_FILE="),
    );
    expect(helm).toBeGreaterThanOrEqual(0);
    expect(canary).toBeGreaterThan(helm);
  });

  it("uploads diagnostics on failure without reading Secrets", () => {
    const steps = wf.jobs["preview-test"].steps;
    expect(
      steps.some(
        (s) =>
          s.if?.includes("failure()") &&
          s.uses?.startsWith("actions/upload-artifact@"),
      ),
    ).toBe(true);
    expect(text).not.toMatch(/get\s+secrets?\b/);
    expect(text).not.toMatch(/kubectl[^\n]*-o\s*yaml/);
  });
});

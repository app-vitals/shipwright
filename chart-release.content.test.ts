/**
 * Content guard for .github/workflows/chart-release.yml (ADR 0001, RCN-9.10):
 * the chart is published with a version derived at publish time, with no bump
 * PR or admin merge, and every publish ends with an idempotent annotated
 * chart-<version> tag. The logic is tested in
 * .github/workflows/test-chart-release.sh; this guards the wiring.
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
  id?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  needs?: string;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  steps: Step[];
};
type Workflow = {
  on: {
    push?: { tags?: string[]; branches?: string[]; paths?: string[] };
    pull_request?: unknown;
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const text = read(".github/workflows/chart-release.yml");
const wf = Bun.YAML.parse(text) as Workflow;
const publish = wf.jobs.publish;
const idx = (name: string) =>
  publish.steps.findIndex((s) => (s.name ?? "").includes(name));
const step = (name: string) => publish.steps[idx(name)];

describe("chart-release.yml triggers", () => {
  it("publishes on release tags, agent/Dockerfile, chart changes and manual runs", () => {
    expect(wf.on.push?.tags).toEqual([
      "admin-v*",
      "metrics-v*",
      "agent-v*",
      "task-store-v*",
    ]);
    expect(wf.on.push?.branches).toEqual(["main"]);
    expect(wf.on.push?.paths).toContain("charts/shipwright/**");
    expect(wf.on.push?.paths).toContain("agent/Dockerfile");
    expect(wf.on.workflow_dispatch).toBeDefined();
    expect(wf.on.pull_request).toBeDefined();
  });

  it("debounces tag bursts for 90s and gates publish on the debounce", () => {
    const d = wf.jobs.debounce;
    expect(d.if).toContain("refs/tags/");
    expect(d.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(JSON.stringify(d.steps)).toContain("DEBOUNCE_SECONDS");
    expect(JSON.stringify(d.steps)).toContain("90");
    expect(publish.needs).toBe("debounce");
  });

  it("publishes only from main or a release tag (a dispatch on another branch never publishes)", () => {
    expect(publish.if).toContain("github.event_name != 'pull_request'");
    expect(publish.if).toContain("github.ref == 'refs/heads/main'");
    expect(publish.if).toContain("startsWith(github.ref, 'refs/tags/')");
  });

  it("serializes publishes without cancelling an in-flight one", () => {
    expect(publish.concurrency).toEqual({
      group: "chart-release",
      "cancel-in-progress": false,
    });
    expect(publish.permissions).toEqual({ contents: "write" });
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("pins actions to a SHA", () => {
    for (const line of text
      .split("\n")
      .filter((l) => /\buses:/.test(l) && !/uses: \.\//.test(l))) {
      expect(line).toMatch(/@[0-9a-f]{40} # v\d/);
    }
  });
});

describe("chart-release.yml publish path", () => {
  it("has no bump PR, admin merge or Chart.yaml commit", () => {
    expect(text).not.toContain("gh pr");
    expect(text).not.toContain("--admin");
    expect(text).not.toContain("auto-bump");
    expect(text).not.toContain("chore/chart-v");
  });

  it("derives the version, stamps a scratch copy, then packages it with --version", () => {
    const derive = step("Derive chart version");
    const stamp = step("Stamp image pins");
    const pkg = step("Package stamped chart");
    expect(derive.run).toContain(
      "derive_chart_version charts/shipwright/Chart.yaml gh-pages/index.yaml",
    );
    expect(stamp.run).toContain("stamp_pins");
    expect(stamp.run).toContain("stamp_chart_yaml");
    expect(stamp.run).toContain("cp -r charts/shipwright");
    expect(pkg.run).toContain('helm package "$SCRATCH/shipwright" --version "$VERSION"');
    expect(text).not.toContain("helm package charts/shipwright");
    expect(idx("Derive chart version")).toBeLessThan(idx("Stamp image pins"));
    expect(idx("Stamp image pins")).toBeLessThan(idx("Package stamped chart"));
  });

  it("skips the publish when the stamped chart equals the latest published one", () => {
    const pkg = step("Package stamped chart");
    expect(pkg.run).toContain("chart_packages_equivalent");
    expect(pkg.run).toContain("publish=false");
    for (const name of ["Merge repo index", "Commit and push to gh-pages"]) {
      expect(step(name).if).toBe("steps.package.outputs.publish == 'true'");
    }
  });

  it("keeps the index format: same --merge and --url", () => {
    expect(step("Merge repo index").run).toContain(
      'helm repo index gh-pages/ --merge gh-pages/index.yaml --url "$PAGES_URL"',
    );
    expect(wf.jobs.publish.steps.some((s) => s.run?.includes("PAGES_URL"))).toBe(true);
  });

  it("derives from an unreadable-index-safe path (no floor fallback to a missing index)", () => {
    expect(step("Derive chart version").run).toContain("set -euo pipefail");
  });
});

describe("chart-release.yml chart tag", () => {
  const tag = step("Create chart tag");

  it("creates the tag last, after the gh-pages push", () => {
    expect(idx("Create chart tag")).toBe(publish.steps.length - 1);
    expect(idx("Create chart tag")).toBeGreaterThan(
      idx("Commit and push to gh-pages"),
    );
  });

  it("tags every untagged published version via the idempotent publish_chart_tag", () => {
    expect(tag.run).toContain(
      'tag_missing_chart_versions gh-pages "$CHART_TAG_FLOOR" origin',
    );
    expect(tag.run).toContain("lib/chart-drift-check.sh");
    const lib = read(".github/workflows/lib/chart-release.sh");
    const fn = lib.slice(lib.indexOf("tag_missing_chart_versions() {"));
    expect(fn).toContain("versions_missing_chart_tag");
    expect(fn).toContain("recorded_release");
    expect(fn).toContain("Source-Commit");
    expect(fn).toContain("publish_chart_tag");
    const commit = step("Commit and push to gh-pages");
    expect(commit.run).toContain("release_record");
    expect(commit.run).toContain('-m "$RECORD"');
  });

  it("uses the same chart tag floor as check-chart-drift.yml", () => {
    const floor = (t: string) => (Bun.YAML.parse(t) as { env?: Record<string, unknown> }).env?.CHART_TAG_FLOOR;
    expect(floor(text)).toBeDefined();
    expect(floor(text)).toBe(floor(read(".github/workflows/check-chart-drift.yml")));
  });

  it("checks out full history and tags, and keeps credentials for the tag push", () => {
    const checkout = publish.steps[0] as Step & {
      with?: Record<string, unknown>;
    };
    expect(checkout.with?.["fetch-depth"]).toBe(0);
    expect(checkout.with?.["fetch-tags"]).toBe(true);
    expect(checkout.with?.["persist-credentials"]).toBeUndefined();
  });

  it("the lib creates annotated tags and never moves one", () => {
    const lib = read(".github/workflows/lib/chart-release.sh");
    expect(lib).toContain('git tag -a "$tag"');
    expect(lib).toContain("refusing to move it");
    expect(lib).not.toMatch(/git tag -f|--force|push -f/);
  });
});

describe("chart-release.yml dry run", () => {
  const dry = wf.jobs["dry-run"];
  it("runs on pull_request only and exercises derive + stamp + package + the additive index check", () => {
    expect(dry.if).toContain("pull_request");
    const runs = dry.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("derive_chart_version");
    expect(runs).toContain("stamp_pins");
    expect(runs).toContain("--version");
    expect(runs).toContain("additive only");
    expect(runs).not.toContain("git push");
  });
});

describe("retired bump-PR path", () => {
  it("check-chart-drift.yml reads the published chart and checks chart tags", () => {
    const drift = read(".github/workflows/check-chart-drift.yml");
    expect(drift).toContain("latest_chart_version");
    expect(drift).toContain("versions_missing_chart_tag");
    expect(drift).not.toContain("charts/shipwright/values.yaml");
  });

  it("helm.yml and ct.yaml no longer enforce a version increment", () => {
    expect(read(".github/workflows/helm.yml")).not.toMatch(
      /ct lint [^\n]*--check-version-increment/,
    );
    expect(read("ct.yaml")).toContain("check-version-increment: false");
  });

  it("ci.yml no longer allowlists the chart bump files", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toContain("charts/shipwright/Chart");
    expect(ci).not.toContain("CHANGELOG");
  });
});

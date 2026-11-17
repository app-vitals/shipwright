/**
 * release.content.test.ts
 *
 * RCN-9.3: one repo-local release workflow replaces the six per-service
 * build-*.yml workflows (release standard, ADR 0002).
 * Asserts the contract the old files each carried: trigger, per-service path
 * filters, tag prefixes, image names, strict step order (compute tag -> build ->
 * verify -> push -> annotated tag last, via DISPATCH_TOKEN), agent-only version
 * stamping, task-store :latest, release-record labels and trailers, and the
 * whisper jobs (sha tag, no git tag, PR validate, recovery dispatch).
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: asserting on shell and GitHub expression text
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

const ROOT = import.meta.dir;
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

// biome-ignore lint/suspicious/noExplicitAny: parsed workflow YAML is untyped
type Any = any;
const text = read(".github/workflows/release.yml");
const wf = YAML.parse(text) as Any;

const stepIndex = (steps: Any[], re: RegExp) =>
  steps.findIndex((s) => re.test(s.name ?? s.uses ?? ""));
const runOf = (steps: Any[], re: RegExp) => steps[stepIndex(steps, re)].run;

const SERVICES = JSON.parse(wf.jobs.filter.env.SERVICES) as Array<{
  service: string;
  tag_prefix: string;
  dockerfile: string;
  image: string;
  latest: string;
}>;
const release = wf.jobs.release;
const steps = release.steps as Any[];

describe("release.yml triggers", () => {
  it("runs after CI via workflow_run and gates on a successful main run", () => {
    expect(wf.on.workflow_run.workflows).toEqual(["CI"]);
    expect(wf.on.workflow_run.types).toEqual(["completed"]);
    const gate = wf.jobs.filter.if;
    expect(gate).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(gate).toContain("github.event.workflow_run.head_branch == 'main'");
  });

  it("checks out the commit CI ran on, not the latest main", () => {
    expect(steps[0].with.ref).toBe("${{ github.event.workflow_run.head_sha }}");
    expect(steps[0].with["persist-credentials"]).toBe(false);
  });
});

describe("release.yml service matrix", () => {
  it("covers the five semver services with the right image, dockerfile and tag prefix", () => {
    expect(SERVICES.map((s) => s.service)).toEqual([
      "agent",
      "admin",
      "metrics",
      "task-store",
      "mcp-server",
    ]);
    for (const s of SERVICES) {
      expect(s.tag_prefix).toBe(`${s.service}-v`);
      expect(s.dockerfile).toBe(`${s.service}/Dockerfile`);
      expect(s.image).toBe(`ghcr.io/app-vitals/shipwright-${s.service}`);
      expect(existsSync(join(ROOT, s.dockerfile))).toBe(true);
    }
  });

  it("only task-store also publishes :latest", () => {
    expect(
      SERVICES.filter((s) => s.latest === "true").map((s) => s.service),
    ).toEqual(["task-store"]);
    const build = runOf(steps, /Build Docker image/);
    expect(build).toContain('-t "$IMAGE:latest"');
    const push = runOf(steps, /Push Docker image/);
    expect(push).toContain('docker push "$IMAGE:latest"');
  });

  it("drives the matrix from the filter job and tags with the matrix prefix", () => {
    expect(release.strategy.matrix).toBe(
      "${{ fromJSON(needs.filter.outputs.matrix) }}",
    );
    expect(release.strategy["fail-fast"]).toBe(false);
    const compute = steps[stepIndex(steps, /Compute next tag/)];
    expect(compute.with.tag_prefix).toBe("${{ matrix.tag_prefix }}");
    expect(compute.with.dry_run).toBe(true);
    expect(compute.uses).toContain(
      "mathieudutour/github-tag-action@af99e60ce8132224b8e6ebab5023449fe256ed46",
    );
  });

  it("has per-service path filters, each including package.json, bun.lock and release.yml", () => {
    const filters = YAML.parse(
      wf.jobs.filter.steps.find((s: Any) => s.id === "filter").with.filters,
    ) as Record<string, string[]>;
    expect(Object.keys(filters)).toEqual(SERVICES.map((s) => s.service));
    for (const s of ["admin", "metrics", "task-store", "mcp-server"]) {
      expect(filters[s]).toEqual([
        `${s}/**`,
        "package.json",
        "bun.lock",
        ".github/workflows/release.yml",
      ]);
    }
    expect(filters.agent).toEqual([
      "agent/**",
      "plugins/**",
      ".claude-plugin/**",
      "package.json",
      "bun.lock",
      ".github/workflows/release.yml",
    ]);
  });
});

describe("release.yml step order (a tag means proven)", () => {
  const idx = {
    compute: stepIndex(steps, /Compute next tag/),
    build: stepIndex(steps, /Build Docker image/),
    verify: stepIndex(steps, /Verify image/),
    login: stepIndex(steps, /Log in to GHCR/),
    push: stepIndex(steps, /Push Docker image/),
    tag: stepIndex(steps, /Tag release/),
  };

  it("runs compute -> build -> verify -> push -> tag, tag last", () => {
    expect(idx.compute).toBeGreaterThan(-1);
    expect(idx.build).toBeGreaterThan(idx.compute);
    expect(idx.verify).toBeGreaterThan(idx.build);
    expect(idx.push).toBeGreaterThan(idx.verify);
    expect(idx.tag).toBe(steps.length - 1);
    expect(idx.tag).toBeGreaterThan(idx.push);
  });

  it("never pushes an image or creates a tag before verify", () => {
    steps.slice(0, idx.verify + 1).forEach((s, i) => {
      expect(JSON.stringify(s.run ?? "")).not.toMatch(
        /docker push|git push|git\/refs/,
      );
      if (i < idx.verify)
        expect(s.uses ?? "").not.toContain("docker/login-action");
    });
    expect(idx.login).toBeGreaterThan(idx.verify);
  });

  it("verify smoke-checks the agent binaries and only inspects the other images", () => {
    const verify = runOf(steps, /Verify image/);
    expect(verify).toContain('docker image inspect "$IMAGE:$NEW_TAG"');
    expect(verify).toContain("for b in mise claude gh node bun");
  });

  it("creates the annotated tag last with DISPATCH_TOKEN so downstream workflows fire", () => {
    const tag = steps[idx.tag];
    expect(tag.env.DISPATCH_TOKEN).toBe("${{ secrets.DISPATCH_TOKEN }}");
    expect(tag.run).toContain('git tag -a "$NEW_TAG" "$SOURCE_SHA"');
    expect(tag.run).toContain("x-access-token:${DISPATCH_TOKEN}");
    expect(tag.run).toContain('git push origin "refs/tags/$NEW_TAG"');
    expect(tag.run).not.toContain("GITHUB_TOKEN");
    expect(release.permissions.contents).toBe("read");
  });

  it("writes the release record as tag trailers", () => {
    const run = steps[idx.tag].run as string;
    for (const t of [
      "Release $NEW_TAG",
      "Release-Version: $NEW_TAG",
      "Source-Sha: $SOURCE_SHA",
      "Upstream-Versions:",
      "Release-Run:",
      "Workflow-Run: $WORKFLOW_RUN",
    ]) {
      expect(run).toContain(t);
    }
  });

  it("labels the image with the release record and the source repo", () => {
    const build = runOf(steps, /Build Docker image/) as string;
    for (const l of [
      "org.opencontainers.image.source=https://github.com/app-vitals/shipwright",
      "com.app-vitals.release.version=",
      "com.app-vitals.release.source-sha=",
      "com.app-vitals.release.upstream-versions=",
      "com.app-vitals.release.run-id=",
      "com.app-vitals.release.workflow-run=",
    ]) {
      expect(build).toContain(l);
    }
  });

  it("stamps AGENT_VERSION for the agent image only", () => {
    const build = runOf(steps, /Build Docker image/) as string;
    expect(build).toContain('if [ "$SERVICE" = agent ]');
    expect(build).toContain('AGENT_VERSION="${NEW_TAG#agent-v}"');
    expect(build.match(/AGENT_VERSION/g)?.length).toBe(3);
    expect(text.match(/--build-arg/g)?.length).toBe(1);
  });
});

describe("release.yml whisper jobs", () => {
  it("keeps the PR validate job", () => {
    expect(wf.on.pull_request.paths).toEqual([
      "whisper/**",
      ".github/workflows/release.yml",
    ]);
    const job = wf.jobs["whisper-validate"];
    expect(job.if).toBe("github.event_name == 'pull_request'");
    const run = job.steps.map((s: Any) => s.run ?? "").join("\n");
    expect(run).toContain("python3 -m unittest discover -s whisper");
    expect(run).toContain("bash whisper/verify-image.sh shipwright-whisper:ci");
  });

  it("keeps the ci_run_id recovery dispatch and trusted CI resolution", () => {
    expect(wf.on.workflow_dispatch.inputs.ci_run_id.required).toBe(true);
    const run = wf.jobs["whisper-changes"].steps
      .map((s: Any) => s.run ?? "")
      .join("\n");
    expect(run).toContain("python3 whisper/resolve-ci-run.py");
    expect(run).toContain("whisper .github/workflows/release.yml");
  });

  it("publishes sha-<commit> only after build and verify, with no git tag", () => {
    const job = wf.jobs["whisper-publish"];
    expect(job.env.IMAGE).toContain("shipwright-whisper:sha-");
    const names = job.steps.map((s: Any) => s.name ?? s.uses ?? "");
    const build = names.findIndex((n: string) => /Build and verify/.test(n));
    const login = names.findIndex((n: string) =>
      /docker\/login-action/.test(n),
    );
    const push = names.findIndex((n: string) => /Push verified image/.test(n));
    expect(build).toBeLessThan(login);
    expect(login).toBeLessThan(push);
    expect(JSON.stringify(job)).not.toMatch(
      /git tag|git push|git\/refs|DISPATCH_TOKEN/,
    );
  });
});

describe("old per-service build workflows are gone", () => {
  const OLD = [
    "admin",
    "agent",
    "metrics",
    "task-store",
    "mcp-server",
    "whisper",
  ].map((s) => `build-${s}.yml`);
  const NAMES =
    /Build and Push (Admin|Agent|Metrics|Task-Store|Mcp-Server) Image|Build Whisper Image/;

  it("deleted the six files", () => {
    for (const f of OLD) {
      expect(existsSync(join(ROOT, ".github/workflows", f))).toBe(false);
    }
  });

  it("nothing under .github, whisper, docs or the root tests names them", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir))) {
        const rel = join(dir, e);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else files.push(rel);
      }
    };
    for (const d of [
      ".github",
      "whisper",
      "docs",
      "scripts",
      "agent/Dockerfile",
    ]) {
      if (statSync(join(ROOT, d)).isDirectory()) walk(d);
      else files.push(d);
    }
    for (const f of readdirSync(ROOT))
      if (f.endsWith(".test.ts")) files.push(f);
    const self = "release.content.test.ts";
    for (const f of files.filter(
      (f) => f !== self && !f.startsWith("docs/adr"),
    )) {
      const body = read(f);
      for (const o of OLD) expect([f, body.includes(o)]).toEqual([f, false]);
      expect([f, NAMES.test(body)]).toEqual([f, false]);
    }
  });
});

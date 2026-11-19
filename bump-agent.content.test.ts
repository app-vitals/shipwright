/**
 * Content guard for .github/workflows/bump-agent.yml (RCN-13.5), the standard
 * bump workflow (ADR 0003) the release conductor dispatches.
 *
 * Pins the input contract, the run name, and that the workflow reuses the
 * platform-release bump scripts instead of forking their logic. The bump logic
 * is unit-tested in scripts/platform-release-bump.unit.test.ts and the merge
 * gate in scripts/platform-bump-gate.unit.test.ts; platform-release.yml keeps
 * its own content test (platform-release.content.test.ts), unchanged.
 *
 * Lives at the repo root (not under .github/) because `bun test` never walks
 * dot-directories.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);
const PATH = join(ROOT, ".github/workflows/bump-agent.yml");

type Step = {
  name?: string;
  uses?: string;
  id?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
};
type Workflow = {
  on: {
    repository_dispatch?: unknown;
    workflow_dispatch?: {
      inputs?: Record<
        string,
        { required?: boolean; type?: string; default?: unknown }
      >;
    };
  };
  "run-name"?: string;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>;
};

const text = readFileSync(PATH, "utf8");
const wf = Bun.YAML.parse(text) as Workflow;
const job = wf.jobs.bump;
const steps = job.steps;
const allRuns = steps.map((s) => s.run ?? "").join("\n");
/** GitHub expression text, built so this source holds no literal template-looking strings. */
const gha = (expr: string) => `$${"{{"} ${expr} }}`;

describe("bump-agent.yml inputs and run name", () => {
  const inputs = wf.on.workflow_dispatch?.inputs ?? {};

  it("is dispatch-only", () => {
    expect(wf.on.workflow_dispatch).toBeDefined();
    expect(wf.on.repository_dispatch).toBeUndefined();
  });

  it("requires a string version", () => {
    expect(inputs.version?.required).toBe(true);
    expect(inputs.version?.type).toBe("string");
  });

  it("has an optional string run_id", () => {
    expect(inputs.run_id?.required).toBe(false);
    expect(inputs.run_id?.type).toBe("string");
  });

  it("has an optional boolean dry_run defaulting to false", () => {
    expect(inputs.dry_run?.required).toBe(false);
    expect(inputs.dry_run?.type).toBe("boolean");
    expect(inputs.dry_run?.default).toBe(false);
  });

  it("records run_id in the run name, falling back to the plain name", () => {
    expect(wf["run-name"]).toBe(
      gha(
        "inputs.run_id && format('Bump Agent ({0})', inputs.run_id) || 'Bump Agent'",
      ),
    );
  });

  it("reads the version from the input via env", () => {
    expect(job.env?.VERSION).toBe(gha("inputs.version"));
  });
});

describe("bump-agent.yml reuses the platform-release scripts", () => {
  it("calls each script, which exist", () => {
    for (const [call, script] of [
      ['bun scripts/platform-release-bump.ts "$VERSION"', "scripts/platform-release-bump.ts"],
      ['bun scripts/platform-docs-snapshot.ts "$VERSION" .platform-src', "scripts/platform-docs-snapshot.ts"],
      ["bun scripts/platform-bump-branch-guard.ts", "scripts/platform-bump-branch-guard.ts"],
      ['bash scripts/platform-bump-gate.sh "$PR_URL"', "scripts/platform-bump-gate.sh"],
    ]) {
      expect(allRuns).toContain(call);
      expect(existsSync(join(ROOT, script))).toBe(true);
    }
  });

  it("uses the same fixed branch and only secrets platform-release.yml references", () => {
    const old = readFileSync(
      join(ROOT, ".github/workflows/platform-release.yml"),
      "utf8",
    );
    expect(job.env?.BRANCH).toBe("chore/platform-release");
    const secrets = (t: string) => new Set(t.match(/secrets\.[A-Z_]+/g) ?? []);
    for (const s of secrets(text)) expect(secrets(old).has(s)).toBe(true);
  });

  it("shares the platform-release concurrency group and never cancels", () => {
    expect(wf.concurrency?.group).toBe("platform-release");
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("re-dispatches itself, not the old workflow, on a main conflict", () => {
    expect(allRuns).toContain("gh workflow run bump-agent.yml");
    expect(allRuns).not.toContain("gh workflow run platform-release.yml");
  });
});

describe("bump-agent.yml no-op and dry run", () => {
  const detect = steps.find((s) => s.id === "diff");

  it("succeeds without a PR when the pin is already at the version", () => {
    expect(detect?.run).toContain('echo "changed=false" >> "$GITHUB_OUTPUT"');
    expect(detect?.run).toContain("no PR needed");
    for (const name of ["Commit and push", "Open or update the bump PR"]) {
      expect(steps.find((s) => s.name === name)?.if).toBe(
        "steps.diff.outputs.changed == 'true'",
      );
    }
    expect(steps.find((s) => s.id === "merge")?.if).toBe(
      "steps.diff.outputs.changed == 'true'",
    );
  });

  it("a dry run stops before the push, via env", () => {
    expect(detect?.env?.DRY_RUN).toBe(gha("inputs.dry_run"));
    expect(detect?.run).toContain('[ "$DRY_RUN" = "true" ]');
    const run = detect?.run ?? "";
    const dry = run.slice(run.indexOf('[ "$DRY_RUN"'));
    expect(dry.indexOf("changed=false")).toBeLessThan(dry.indexOf("else"));
  });

  it("never interpolates a GitHub expression into a run script", () => {
    for (const s of steps) expect(s.run ?? "").not.toContain("${{");
  });
});

describe("platform-release-retry.yml sees in-flight bump-agent.yml runs", () => {
  const retry = readFileSync(
    join(ROOT, ".github/workflows/platform-release-retry.yml"),
    "utf8",
  );
  const rwf = Bun.YAML.parse(retry) as Workflow;
  const select = rwf.jobs.retry.steps.find((s) => s.id === "select");

  it("bump-agent.yml shares the platform-release group and bump branch", () => {
    expect(wf.concurrency?.group).toBe("platform-release");
    expect(job.env?.BRANCH).toBe(rwf.jobs.retry.env?.BRANCH);
  });

  it("the in-flight guard counts both workflows before retry, merge or exhausted", () => {
    const run = select?.run ?? "";
    expect(run).toContain(
      "for WORKFLOW in platform-release.yml bump-agent.yml; do",
    );
    expect(run).toContain('gh run list --workflow "$WORKFLOW"');
    expect(run).not.toContain("gh run list --workflow platform-release.yml");
    const guard = run.slice(run.indexOf("INFLIGHT=0"));
    expect(run.slice(0, run.indexOf("INFLIGHT=0"))).toContain(
      '[ "$ACTION" = "merge" ]',
    );
    expect(guard).toContain('echo "action=wait"');
  });
});

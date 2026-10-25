/**
 * Content guard for .github/workflows/platform-release.yml (AGR-4.1), the
 * receiver of the platform's `platform-release` dispatch (AGR-3.3).
 *
 * Pins the trigger contract the sender relies on, the injection rule (the
 * externally supplied version never appears as a `${{ }}` expression inside a
 * run script), SHA-pinned actions, a pr-title-lint-clean title, the freeze
 * guard label and the loud failure path. The bump logic itself is unit-tested
 * in scripts/platform-release-bump.unit.test.ts.
 *
 * Lives at the repo root (not under .github/) because `bun test` never walks
 * dot-directories.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);
const PATH = join(ROOT, ".github/workflows/platform-release.yml");

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Workflow = {
  on: {
    repository_dispatch?: { types?: string[] };
    workflow_dispatch?: {
      inputs?: Record<string, { required?: boolean; type?: string }>;
    };
  };
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      permissions?: Record<string, string>;
      steps: Step[];
    }
  >;
};

const text = readFileSync(PATH, "utf8");
const wf = Bun.YAML.parse(text) as Workflow;
const job = wf.jobs.bump;
const steps = job.steps;
const runOf = (pred: (s: Step) => boolean) =>
  steps.filter(pred).map((s) => s.run ?? "");
const allRuns = runOf(() => true).join("\n");
/** GitHub expression and shell-variable text, built so this source holds no literal template-looking strings. */
const gha = (expr: string) => `$${"{{"} ${expr} }}`;
const shellVar = (name: string) => "$" + `{${name}}`;

describe("platform-release.yml triggers", () => {
  it("receives the platform-release repository_dispatch", () => {
    expect(wf.on.repository_dispatch?.types).toEqual(["platform-release"]);
  });

  it("can be run by hand with a required version input", () => {
    const input = wf.on.workflow_dispatch?.inputs?.version;
    expect(input?.required).toBe(true);
    expect(input?.type).toBe("string");
  });

  it("reads the version from the sender's client_payload[version] or the input, via env", () => {
    expect(job.env?.VERSION).toBe(
      gha("github.event.client_payload.version || inputs.version"),
    );
  });
});

describe("platform-release.yml safety", () => {
  it("never interpolates a GitHub expression into a run script", () => {
    for (const step of steps) {
      expect(step.run ?? "", `step: ${step.name ?? step.uses}`).not.toContain(
        gha("").slice(0, 3),
      );
    }
  });

  it("pins every action to a full commit SHA", () => {
    const uses = steps.map((s) => s.uses).filter((u): u is string => !!u);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    // The version comment the rest of the repo keeps beside each pin.
    for (const line of text.split("\n").filter((l) => /\buses:/.test(l))) {
      expect(line).toMatch(/@[0-9a-f]{40} # v\d/);
    }
  });

  it("keeps workflow-level permissions read-only and widens only the job", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      issues: "write",
    });
  });
});

describe("platform-release.yml bump", () => {
  it("validates and re-pins through scripts/platform-release-bump.ts, then refreshes bun.lock", () => {
    const bump = allRuns.indexOf(
      'bun scripts/platform-release-bump.ts "$VERSION"',
    );
    const install = allRuns.indexOf("bun install");
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(bump);
  });

  it("commits only package.json files, bun.lock and the docs snapshot, on one fixed bump branch", () => {
    expect(job.env?.BRANCH).toBe("chore/platform-release");
    expect(allRuns).toContain("git add -A -- docs/platform");
    expect(allRuns).toContain("git add -u -- bun.lock '*package.json'");
    expect(allRuns).toContain('git push --force origin "$BRANCH"');
  });

  it("snapshots the platform docs from the release tag before committing", () => {
    const checkout = steps.find(
      (s) => s.with?.repository === "app-vitals/agent",
    );
    expect(checkout?.with?.ref).toBe(`refs/tags/v${gha("env.VERSION")}`);
    expect(checkout?.with?.token).toBe(gha("secrets.DISPATCH_TOKEN"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    const snap = allRuns.indexOf(
      'bun scripts/platform-docs-snapshot.ts "$VERSION" .platform-src',
    );
    expect(snap).toBeGreaterThan(allRuns.indexOf("platform-release-bump.ts"));
    expect(snap).toBeLessThan(allRuns.indexOf("git commit"));
  });

  it("opens or updates the PR with a pr-title-lint-clean title and the platform-cutover label", () => {
    expect(allRuns).toContain(
      `TITLE="chore(deps): bump @app-vitals/agent-* to ${shellVar("VERSION")}"`,
    );
    // pr-title-lint: conventional type(scope): subject.
    expect("chore(deps): bump @app-vitals/agent-* to 0.2.0").toMatch(
      /^(feat|fix|chore|docs|refactor|test|ci|perf|build)(\([\w-]+\))?: \S/,
    );
    expect(allRuns).toContain('gh pr list --head "$BRANCH" --state open');
    expect(allRuns).toContain('gh pr edit "$PR_URL"');
    expect(allRuns).toContain("gh pr create");
    expect(allRuns).toContain("--label platform-cutover");
  });

  it("uses DISPATCH_TOKEN for the push and the PR so the PR's CI runs", () => {
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.token).toBe(gha("secrets.DISPATCH_TOKEN"));
    const pr = steps.find((s) => s.run?.includes("gh pr create"));
    expect(pr?.env?.GH_TOKEN).toBe(gha("secrets.DISPATCH_TOKEN"));
  });

  it("fails loudly: a failure() step opens or comments on an issue", () => {
    const onFailure = steps.filter((s) => s.if === "failure()");
    expect(onFailure.length).toBe(1);
    expect(onFailure[0].run).toContain("gh issue create");
    expect(onFailure[0].run).toContain("gh issue comment");
  });
});

describe("platform-docs-guard.yml", () => {
  const guard = readFileSync(
    join(ROOT, ".github/workflows/platform-docs-guard.yml"),
    "utf8",
  );

  it("runs the guard on PRs with the head branch passed via env, not interpolated", () => {
    expect(guard).toContain("pull_request:");
    expect(guard).toContain(
      'bun scripts/platform-docs-guard.ts "$RUNNER_TEMP/changed.txt" "$HEAD_REF"',
    );
    const run = (Bun.YAML.parse(guard) as Workflow).jobs["docs-guard"].steps
      .map((s) => s.run ?? "")
      .join("\n");
    expect(run).not.toContain(gha("").slice(0, 3));
  });
});

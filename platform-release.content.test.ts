/**
 * Content guard for .github/workflows/platform-release.yml (AGR-4.1), the
 * receiver of the platform's `platform-release` dispatch (AGR-3.3).
 *
 * Pins the trigger contract the sender relies on, the injection rule (the
 * externally supplied version never appears as a `${{ }}` expression inside a
 * run script), SHA-pinned actions, a pr-title-lint-clean title, the
 * loud failure path. The bump logic itself is unit-tested
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
  id?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Workflow = {
  on: {
    repository_dispatch?: { types?: string[] };
    workflow_dispatch?: {
      inputs?: Record<
        string,
        { required?: boolean; type?: string; default?: string }
      >;
    };
  };
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      "timeout-minutes"?: number;
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
const shellVar = (name: string) => ["$", "{", name, "}"].join("");

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

  it("waits for every pinned package on npm before bun install, deriving the list from the bump script", () => {
    const idx = steps.findIndex((s) => /npm view/.test(s.run ?? ""));
    const lockIdx = steps.findIndex((s) => s.name === "Refresh bun.lock");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(lockIdx);
    const wait = steps[idx];
    expect(wait.run).toContain("platform-release-bump.ts --list-packages");
    expect(wait.run).toContain("sleep 15");
    expect(wait.run).toMatch(/npm view "\$\{?pkg\}?@\$\{?VERSION\}?" version/);
    expect(wait.run).toContain("exit 1");
    // The version reaches the step through env only, never a template expression.
    expect(wait.run).not.toContain("${{");
    // The step precedes every `bun install` in the job.
    const firstInstall = steps.findIndex((s) =>
      /bun install/.test(s.run ?? ""),
    );
    expect(idx).toBeLessThan(firstInstall);
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

  it("opens or updates the PR with a pr-title-lint-clean title", () => {
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
    expect(allRuns).not.toContain("platform-cutover");
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

describe("platform-release.yml self-merge (PLD-2.3)", () => {
  const prIdx = steps.findIndex((s) => s.run?.includes("gh pr create"));
  const mergeIdx = steps.findIndex(
    (s) => s.name === "Wait for checks and merge",
  );
  const failIdx = steps.findIndex((s) => s.if === "failure()");
  const merge = steps[mergeIdx];

  it("gives the PR step id pr and writes pr_url to GITHUB_OUTPUT", () => {
    expect(steps[prIdx].id).toBe("pr");
    expect(steps[prIdx].run).toContain(
      'echo "pr_url=$' + '{PR_URL}" >> "$GITHUB_OUTPUT"',
    );
    // Both the update and the create branch write the output.
    expect(steps[prIdx].run?.split("pr_url=").length).toBe(3);
  });

  it("has a merge step gated on the diff, taking the PR URL and token via env", () => {
    expect(mergeIdx).toBeGreaterThan(-1);
    expect(merge.if).toBe("steps.diff.outputs.changed == 'true'");
    expect(merge.env?.PR_URL).toBe(gha("steps.pr.outputs.pr_url"));
    expect(merge.env?.GH_TOKEN).toBe(gha("secrets.DISPATCH_TOKEN"));
  });

  it("waits for required checks, reruns failures and admin-squash-merges", () => {
    const run = merge.run ?? "";
    expect(run).toContain("gh pr checks");
    expect(run).toContain("--watch");
    expect(run).toContain("--required");
    expect(run).toContain("gh run rerun");
    expect(run).toContain("Base branch was modified");
    expect(run).toContain("gh pr merge");
    expect(run).toContain("--squash --admin");
    expect(run).toContain("exit 1");
  });

  it("waits for the CI run on the PR head commit before checking required checks or merging", () => {
    const run = merge.run ?? "";
    const headSha = run.indexOf("headRefOid");
    const list = run.indexOf('gh run list --commit "$HEAD_SHA" --workflow CI');
    const watchRun = run.indexOf('gh run watch "$CI_RUN_ID"');
    const watchChecks = run.indexOf('gh pr checks "$PR_URL" --required');
    const mergeCmd = run.indexOf("gh pr merge");
    expect(headSha).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(headSha);
    expect(watchRun).toBeGreaterThan(list);
    expect(watchChecks).toBeGreaterThan(watchRun);
    expect(mergeCmd).toBeGreaterThan(watchChecks);
  });

  it("fails without merging when CI or the required checks never register", () => {
    const run = merge.run ?? "";
    expect(run).toContain('[ -z "$CI_RUN_ID" ]');
    expect(run).toContain('[ "$CHECK_COUNT" -eq 0 ]');
    const ciGuard = run.indexOf('[ -z "$CI_RUN_ID" ]');
    expect(run.indexOf("exit 1", ciGuard)).toBeLessThan(
      run.indexOf("gh pr merge"),
    );
  });

  it("only admin-merges after the required-checks loop has passed", () => {
    const run = merge.run ?? "";
    const loopEnd = run.indexOf("Checks passed");
    expect(loopEnd).toBeGreaterThan(run.indexOf("--watch"));
    expect(run.indexOf("--squash --admin")).toBeGreaterThan(loopEnd);
    expect(run).toContain("exhausted");
  });

  it("runs after the PR step and before the failure step", () => {
    expect(mergeIdx).toBeGreaterThan(prIdx);
    expect(mergeIdx).toBeLessThan(failIdx);
  });

  it("allows 30 minutes for the job", () => {
    expect(job["timeout-minutes"]).toBe(30);
  });
});

describe("platform-release.yml conflict rebuild (PBP-1.2)", () => {
  const merge = steps.find((s) => s.name === "Wait for checks and merge");
  const run = merge?.run ?? "";

  it("has an optional attempt input defaulting to 1", () => {
    const input = wf.on.workflow_dispatch?.inputs?.attempt;
    expect(input?.required).toBe(false);
    expect(input?.type).toBe("string");
    expect(String(input?.default)).toBe("1");
  });

  it("reads attempt via env, defaulting to 1 for repository_dispatch", () => {
    expect(merge?.env?.ATTEMPT).toBe(gha("inputs.attempt || '1'"));
    expect(merge?.env?.VERSION ?? job.env?.VERSION).toBeTruthy();
  });

  it("polls mergeable until it leaves UNKNOWN, before waiting on checks", () => {
    const poll = run.indexOf("gh pr view");
    expect(poll).toBeGreaterThanOrEqual(0);
    expect(run).toContain("--json mergeable");
    expect(run).toContain("UNKNOWN");
    expect(poll).toBeLessThan(run.indexOf("gh pr checks"));
    expect(poll).toBeLessThan(run.indexOf("--watch"));
  });

  it("logs a distinct ::error:: naming the conflict with main", () => {
    expect(run).toContain("CONFLICTING");
    expect(run).toMatch(/::error::[^\n]*conflict[^\n]*main/i);
  });

  it("re-dispatches once via workflow_dispatch with attempt+1, capped at 2", () => {
    expect(run).toContain("gh workflow run platform-release.yml");
    expect(run).toContain('-f version="$VERSION"');
    expect(run).toMatch(/-f attempt="\$\{?NEXT_ATTEMPT\}?"/);
    expect(run).toMatch(/MAX_REBUILD_ATTEMPTS=2/);
    expect(run).toMatch(
      /ATTEMPT" -lt "\$MAX_REBUILD_ATTEMPTS"|ATTEMPT" -ge "\$MAX_REBUILD_ATTEMPTS"/,
    );
  });

  it("exits 0 with a ::warning:: after re-dispatching, and fails loudly on the second conflict", () => {
    const dispatch = run.indexOf("gh workflow run");
    const afterDispatch = run.slice(dispatch);
    expect(afterDispatch).toMatch(/::warning::[^\n]*[Rr]egenerat/);
    expect(afterDispatch.indexOf("exit 0")).toBeGreaterThan(-1);
    // The cap branch fails with exit 1 and its own error text.
    expect(run).toMatch(/::error::[^\n]*still conflicts[^\n]*attempt/i);
  });

  it("keeps the generic check-failure path and never interpolates expressions", () => {
    expect(run).toContain("Required check(s) failed");
    expect(run).not.toContain("${{");
    expect(merge?.env?.GH_TOKEN).toBe(gha("secrets.DISPATCH_TOKEN"));
  });

  it("documents the rebuild behaviour in the header", () => {
    const header = text.slice(0, text.indexOf("\non:"));
    expect(header).toMatch(/CONFLICTING/);
    expect(header).toMatch(/attempt/);
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

/**
 * Content guard for .github/workflows/library-chart-release.yml (CHM-3.5), the
 * receiver of app-vitals/agent's `chart-release` dispatch (CHM-2.7), and the
 * library-pin step of check-chart-drift.yml. The pin/bump/drift logic itself is
 * tested in .github/workflows/test-auto-bump-chart.sh and
 * test-check-chart-drift.sh.
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
};
type Workflow = {
  on: {
    repository_dispatch?: { types?: string[] };
    workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> };
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

const load = (file: string) => {
  const text = readFileSync(join(ROOT, ".github/workflows", file), "utf8");
  return { text, wf: Bun.YAML.parse(text) as Workflow };
};
/** GitHub expression text, built so this source holds no literal template-looking strings. */
const gha = (expr: string) => `$${"{{"} ${expr} }}`;

describe("library-chart-release.yml", () => {
  const { text, wf } = load("library-chart-release.yml");
  const job = wf.jobs.bump;
  const runs = job.steps.map((s) => s.run ?? "").join("\n");

  it("receives the chart-release dispatch the library sender posts, plus a manual run", () => {
    expect(wf.on.repository_dispatch?.types).toEqual(["chart-release"]);
    expect(wf.on.workflow_dispatch?.inputs?.version?.required).toBe(true);
  });

  it("passes the external version through env only, never into a run script", () => {
    expect(job.env?.VERSION).toBe(
      gha("github.event.client_payload.version || inputs.version"),
    );
    for (const s of job.steps) {
      expect(s.run ?? "", `step: ${s.name}`).not.toContain("${{");
    }
  });

  it("pins actions to a SHA and keeps workflow permissions read-only", () => {
    for (const line of text.split("\n").filter((l) => /\buses:/.test(l))) {
      expect(line).toMatch(/@[0-9a-f]{40} # v\d/);
    }
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("bumps through lib/library-pin.sh on one fixed branch and refreshes the lock and vendored tgz", () => {
    expect(job.env?.BRANCH).toBe("chore/library-chart-release");
    expect(runs).toContain("source .github/workflows/lib/library-pin.sh");
    expect(runs).toContain(
      'bump_library_pin charts/shipwright "$VERSION"',
    );
    expect(runs).toContain("helm dependency update");
    expect(runs).toContain("agent-platform-${VERSION}.tgz");
    expect(runs).toContain('git push --force origin "$BRANCH"');
  });

  it("uses a pr-title-lint-clean title and the shared merge gate", () => {
    expect(runs).toContain(
      'TITLE="chore(deps): bump agent-platform library chart to ${VERSION}"',
    );
    expect(runs).toContain('bash scripts/platform-bump-gate.sh "$PR_URL"');
  });

  it("fails loudly: opens an issue on failure and closes it on success", () => {
    const failure = job.steps.find((s) => s.if === "failure()");
    expect(failure?.run).toContain("library chart release bump failed");
    expect(failure?.run).toContain("gh issue create");
    const ok = job.steps.find((s) => s.if === "success()");
    expect(ok?.run).toContain("gh issue close");
  });
});

describe("check-chart-drift.yml library pin check", () => {
  const { wf } = load("check-chart-drift.yml");
  const job = wf.jobs["check-drift"];
  const step = job.steps.find((s) => /library-pin\.sh/.test(s.run ?? ""));

  it("compares the pin against the published index and fails the job on drift or an unreadable index", () => {
    expect(step?.run).toContain("https://app-vitals.github.io/agent/index.yaml");
    expect(step?.run).toContain("compute_library_drift");
    expect(step?.run).toContain("::error");
    expect(step?.run).toContain("exit 1");
  });

  it("still runs when the tag drift step failed, and opens an issue when anything fails", () => {
    expect(step?.if).toBe(gha("!cancelled()"));
    expect(job.permissions?.issues).toBe("write");
    const failure = job.steps.find((s) => s.if === "failure()");
    expect(failure?.run).toContain("gh issue create");
  });
});

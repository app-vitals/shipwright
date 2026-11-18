/**
 * test-readiness content tests — open-PR supersession guard.
 *
 * Step 1 previously cut a fresh `docs/test-readiness-refresh-{YYYYMMDD}`
 * branch from origin/main every day the cron fired, with only a same-day
 * reuse check. When a prior day's docs-refresh PR touching the same
 * `docs/test-readiness/*.md` files got stuck open, the next day's run
 * created a fresh competing PR against the same files — if that one merged
 * first, the stuck PR became permanently unmergeable (confirmed in
 * production: a newer same-pattern PR merging turned an older open
 * docs-refresh PR CONFLICTING).
 *
 * These tests assert Step 1 documents checking for an existing open PR on
 * a `docs/test-readiness-refresh-*` branch (any date) before creating a new
 * branch, reusing/checking out that branch and merging origin/main into it
 * instead of branching fresh, and — on merge conflict — skipping Steps 2-4
 * for that repo only with a distinct report string in Step 4's summary.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

function readSkill(): string {
  return readFileSync(SKILL_MD_PATH, "utf8");
}

describe("test-readiness — SKILL.md exists", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });
});

describe("test-readiness — Step 1 open-PR supersession guard", () => {
  it("checks for an existing open PR on a docs/test-readiness-refresh-* branch before creating a new branch", () => {
    const content = readSkill();
    expect(content).toContain("gh pr list");
    expect(content).toContain("--state open");
    expect(content).toContain("docs/test-readiness-refresh-");
  });

  it("uses headRefName,createdAt fields and filters client-side by branch prefix", () => {
    const content = readSkill();
    expect(content).toContain("headRefName");
    expect(content).toContain("createdAt");
  });

  it("runs the open-PR check ahead of the existing same-day-reuse block", () => {
    const content = readSkill();
    const openPrCheckIdx = content.indexOf("gh pr list");
    const sameDayReuseIdx = content.indexOf("same-day rerun");
    expect(openPrCheckIdx).toBeGreaterThan(-1);
    expect(sameDayReuseIdx).toBeGreaterThan(-1);
    expect(openPrCheckIdx).toBeLessThan(sameDayReuseIdx);
  });

  it("documents reusing/checking out the earlier-day branch instead of branching fresh", () => {
    const lower = readSkill().toLowerCase();
    expect(
      lower.includes("reuse") &&
        (lower.includes("checkout") || lower.includes("check out")),
    ).toBe(true);
  });

  it("documents merging current origin/main into the reused branch", () => {
    const content = readSkill();
    expect(content).toMatch(/git merge origin\/main/);
  });

  it("documents skipping Steps 2-4 for that repo only on merge conflict", () => {
    const content = readSkill();
    expect(content).toMatch(/merge conflict/i);
    expect(content).toContain("that repo only");
  });
});

describe("test-readiness — Step 4 reports the reuse-merge conflict distinctly", () => {
  it("adds a distinct skip reason for reuse-merge conflicts, not folded into 'all artifacts fresh'", () => {
    const content = readSkill();
    expect(content).toContain("skipped — all artifacts fresh");
    expect(content).toMatch(
      /skipped — reuse-merge conflict, needs manual resolution/,
    );
  });

  it("keeps the new skip reason string distinct from the existing fresh-artifacts skip reason", () => {
    const content = readSkill();
    const freshIdx = content.indexOf("skipped — all artifacts fresh");
    const conflictIdx = content.indexOf(
      "skipped — reuse-merge conflict, needs manual resolution",
    );
    expect(freshIdx).toBeGreaterThan(-1);
    expect(conflictIdx).toBeGreaterThan(-1);
    expect(freshIdx).not.toBe(conflictIdx);
  });
});

describe("test-readiness — Step 3.5 shipwright label on PR creation", () => {
  function getStep35Section(): string {
    const content = readSkill();
    const step3Idx = content.indexOf("### Step 3:");
    const step3_5Idx = content.indexOf("### Step 3.5:");
    const step4Idx = content.indexOf("### Step 4:");
    expect(step3Idx).toBeGreaterThan(-1);
    expect(step3_5Idx).toBeGreaterThan(-1);
    expect(step4Idx).toBeGreaterThan(-1);
    expect(step3_5Idx).toBeGreaterThan(step3Idx);
    expect(step3_5Idx).toBeLessThan(step4Idx);
    return content.slice(step3_5Idx, step4Idx);
  }

  it("documents pushing the branch to origin", () => {
    const section = getStep35Section();
    expect(section).toMatch(/git push|push.*origin/);
  });

  it("documents checking for an existing PR on the branch before creating a new one", () => {
    const section = getStep35Section();
    expect(section).toContain("gh pr list");
    expect(section).toMatch(/PR.*already exists|existing.*PR|no PR exists/i);
  });

  it("includes a gh label create shipwright line with --force flag before the gh pr create invocation", () => {
    const section = getStep35Section();
    expect(section).toContain("gh label create shipwright");
    expect(section).toContain("--force");
    const labelCreateIdx = section.indexOf("gh label create shipwright");
    const prCreateIdx = section.indexOf("gh pr create");
    expect(labelCreateIdx).toBeGreaterThan(-1);
    expect(prCreateIdx).toBeGreaterThan(-1);
    expect(labelCreateIdx).toBeLessThan(prCreateIdx);
  });

  it("includes the shipwright label description and color in the label-create command", () => {
    const section = getStep35Section();
    expect(section).toContain("Opened autonomously by Shipwright");
    expect(section).toContain("1D76DB");
  });

  it("documents opening the PR with the shipwright label", () => {
    const section = getStep35Section();
    expect(section).toContain("gh pr create");
    expect(section).toContain("--label shipwright");
  });

  it("documents that --force makes the label-create step idempotent", () => {
    const section = getStep35Section();
    expect(section.toLowerCase()).toContain("idempotent");
    expect(section.toLowerCase()).toContain("--force");
  });

  it("documents handling the reused-branch case from Step 1 (open PR update vs new PR creation)", () => {
    const section = getStep35Section();
    expect(
      section.toLowerCase().includes("reused") ||
        section.toLowerCase().includes("earlier-day") ||
        section.toLowerCase().includes("supersession"),
    ).toBe(true);
  });
});

describe("test-readiness — Step 1 requires --repo", () => {
  function getStep1Section(): string {
    const content = readSkill();
    const step1Idx = content.indexOf("### Step 1:");
    const step2Idx = content.indexOf("### Step 2:");
    expect(step1Idx).toBeGreaterThan(-1);
    expect(step2Idx).toBeGreaterThan(-1);
    return content.slice(step1Idx, step2Idx).replace(/\s+/g, " ");
  }

  it("documents --repo as required in the argument hint and flag table", () => {
    const content = readSkill();
    expect(content).toMatch(/argument-hint:.*--repo org\/repo/);
    expect(content).not.toMatch(/argument-hint:.*\[--repo/);
    expect(content).toContain("| `--repo org/repo` |");
  });

  it("fails with a usage message when --repo is missing", () => {
    const step1 = getStep1Section();
    expect(step1).toContain("`--repo org/repo` is required");
    expect(step1).toContain("Usage: /shipwright:test-readiness --repo org/repo");
  });

  it("has no precheck, resolver or repos/ scan fallback", () => {
    const content = readSkill();
    expect(content).not.toContain("check-test-readiness.ts");
    expect(content).not.toContain("resolveScopedRepos");
    expect(content).not.toContain("for dir in repos/*/");
    expect(content).not.toContain("shipwright-test-readiness");
  });

  it("finds or clones the repo and skips the docs/test-readiness opt-in check", () => {
    const step1 = getStep1Section();
    expect(step1).toContain("git clone");
    expect(step1).toContain("opt-in");
  });
});

describe("test-readiness — Step 1.5 records coverage before the phase loop", () => {
  const content = readSkill();
  const stepIdx = content.indexOf("### Step 1.5: Record coverage");
  const section = content.slice(stepIdx, content.indexOf("### Step 2:"));

  it("places the record step ahead of the phase loop", () => {
    expect(stepIdx).toBeGreaterThan(-1);
    expect(stepIdx).toBeLessThan(content.indexOf("### Step 2:"));
  });

  it("runs coverage-summary.ts with --repo and --record", () => {
    expect(section).toMatch(
      /coverage-summary\.ts" --repo \{org\}\/\{repo\} --record/,
    );
  });

  it("invokes the reader via CLAUDE_PLUGIN_ROOT, not a repo-relative path", () => {
    expect(section).toContain(
      `bun run "\${CLAUDE_PLUGIN_ROOT}/scripts/coverage-summary.ts"`,
    );
    expect(section).not.toContain(
      "bun run plugins/shipwright/scripts/coverage-summary.ts",
    );
  });

  it("states it runs even when all phases are fresh and never blocks them", () => {
    expect(section).toMatch(/every invocation/i);
    expect(section).toMatch(/every phase artifact is fresh/i);
    expect(section).toMatch(/not_reporting/);
    expect(section).toMatch(/never\s+blocks the phases/i);
  });

  it("references coverage-output.md instead of restating the contract", () => {
    expect(section).toContain("references/coverage-output.md");
    expect(section).not.toContain("shipwright-coverage");
  });
});

describe("test-readiness — SCM-8.1 partial-refresh PR on early stop", () => {
  const content = readSkill();
  const s35Idx = content.indexOf("### Step 3.5:");
  const s4Idx = content.indexOf("### Step 4:");
  const failIdx = content.indexOf("## Failure handling");
  const step35 = content.slice(s35Idx, s4Idx);
  const step4 = content.slice(s4Idx, failIdx);
  const failure = content.slice(failIdx);

  it("does not gate Step 3.5 on all phases completing successfully", () => {
    expect(step35).not.toMatch(/after all phases have completed successfully/i);
    expect(step35).toMatch(/even when a (later )?phase failed/i);
    expect(step35).toMatch(/at least one phase produced artifacts/i);
  });

  it("Step 3 routes an early stop to Step 3.5", () => {
    const step3 = content.slice(content.indexOf("### Step 3:"), s35Idx);
    expect(step3).toMatch(/early stop[^]*Step 3\.5/);
  });

  it("names the failed phase and error in the PR title and body", () => {
    expect(step35).toMatch(/partial, phase \{N\} \{name\} failed/);
    expect(step35).toMatch(/completed phases/i);
    expect(step35).toMatch(/failed phase/i);
    expect(step35).toMatch(/error/i);
  });

  it("handles an existing open PR by commenting the failure", () => {
    expect(step35).toContain("gh pr comment");
    expect(step35).toContain("gh pr edit");
  });

  it("Step 4 summary lists the failed phase and error per repo", () => {
    expect(step4).toMatch(/failed phase/i);
    expect(step4).toMatch(/error/i);
  });

  it("Failure handling goes through Step 3.5 and Step 4 with the failed phase", () => {
    expect(failure).toContain("Step 3.5");
    expect(failure).not.toMatch(/Exit with a clear summary so the run log/);
    expect(failure).toMatch(/failed phase/i);
  });
});

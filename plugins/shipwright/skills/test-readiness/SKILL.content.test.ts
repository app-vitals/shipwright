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

describe("test-readiness — Step 1 fallback uses the config-driven resolver", () => {
  function getStep1Section(): string {
    const content = readSkill();
    const step1Idx = content.indexOf("### Step 1:");
    const step2Idx = content.indexOf("### Step 2:");
    expect(step1Idx).toBeGreaterThan(-1);
    expect(step2Idx).toBeGreaterThan(-1);
    return content.slice(step1Idx, step2Idx);
  }

  it("does not instruct raw repos/* directory iteration as a repo-list source", () => {
    const section = getStep1Section();
    expect(section).not.toContain("for dir in repos/*/");
  });

  it("references resolveScopedRepos as the fallback repo-list source", () => {
    const section = getStep1Section();
    expect(section).toContain("resolveScopedRepos");
    expect(section).toContain("check-helpers.ts");
  });

  it("documents the fail-closed behavior of the config-driven resolver", () => {
    const section = getStep1Section();
    expect(section.toLowerCase()).toContain("fail");
    expect(section.toLowerCase()).toContain("closed");
  });
});

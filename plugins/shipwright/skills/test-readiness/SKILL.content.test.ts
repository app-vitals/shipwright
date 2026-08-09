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

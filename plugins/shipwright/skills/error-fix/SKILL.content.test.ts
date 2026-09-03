/**
 * error-fix content tests — pagination-safe dedup query (task-store /tasks
 * pagination gap).
 *
 * Step 5's dedup check queries `GET /tasks?status=pending` and
 * `status=in_progress` unbounded (repo-unscoped — error-fix dedups
 * globally, not per-repo). task-store's plain GET /tasks path defaults to
 * `limit=50` and signals truncation via a `total` field (task-service.ts
 * `list()`), but a consumer that doesn't raise the limit and check `total`
 * against what it actually received silently undercounts once the active
 * task count exceeds 50 — exactly the failure mode that let three
 * already-queued tasks slip past dedup on 2026-07-23 (test-fix's own
 * dedup query, same shape).
 *
 * These tests assert Step 5 documents: an explicit high `limit=1000` on
 * both dedup queries, and a guard that checks the response's `total` field
 * against what was fetched and pages via `offset` if `total` is still not
 * fully covered.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

function readSkill(): string {
  return readFileSync(SKILL_MD_PATH, "utf8");
}

describe("error-fix — SKILL.md exists", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });
});

describe("error-fix — Step 8 task JSON derives org/repo, not the bare dir name", () => {
  it("documents deriving org/repo via git remote get-url origin", () => {
    const skill = readSkill();
    expect(skill).toContain("remote get-url origin");
    expect(skill.toLowerCase()).toContain("org/repo");
  });

  it("references entropy-fix's derivation pattern for consistency", () => {
    expect(readSkill()).toContain("entropy-fix");
  });

  it("the task JSON template's repo field is not documented as the bare dir name", () => {
    const skill = readSkill();
    const repoFieldLine = skill
      .split("\n")
      .find((line) => line.includes('"repo":') && line.includes("<"));
    expect(repoFieldLine).toBeDefined();
    expect(repoFieldLine).not.toContain("repo dir name from error-report.md");
  });
});

describe("error-fix — Step 5 dedup query is pagination-safe", () => {
  it("raises the dedup query limit well above the API's default page size", () => {
    expect(readSkill()).toContain("limit=1000");
  });

  it("documents checking the response's total field against what was fetched", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("total");
    expect(lower).toMatch(/check(ing)?.{0,40}total|total.{0,40}check/s);
  });

  it("documents paging via offset when total exceeds the fetched page", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("offset");
    expect(lower).toContain("page");
  });

  it("does not silently proceed with a partial result set", () => {
    const lower = readSkill().toLowerCase();
    expect(
      lower.includes("do not silently proceed") ||
        lower.includes("never silently proceed") ||
        lower.includes("without a partial"),
    ).toBe(true);
  });
});

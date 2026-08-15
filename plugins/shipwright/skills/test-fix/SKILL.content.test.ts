/**
 * test-fix content tests — pagination-safe dedup query (task-store /tasks
 * pagination gap).
 *
 * Step 4's dedup check queries `GET /tasks?status=pending&repo=...` and
 * `status=in_progress&repo=...` unbounded. task-store's plain GET /tasks
 * path defaults to `limit=50` and signals truncation via a `total` field
 * (task-service.ts `list()`), but a consumer that doesn't raise the limit
 * and check `total` against what it actually received silently undercounts
 * once a repo has more than 50 active tasks — exactly the failure mode that
 * let three already-queued tasks slip past dedup on 2026-07-23.
 *
 * These tests assert Step 4 documents: an explicit high `limit=1000` on
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

describe("test-fix — SKILL.md exists", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });
});

describe("test-fix — anti-gaming rejection rule for uncited line-coverage tasks", () => {
  it("requires a line-coverage task to cite the specific feature or genuine uncovered error path it maps to", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("line-coverage");
    expect(lower).toMatch(/cite (the )?specific feature|cite.{0,60}error path/s);
  });

  it("rejects or flags a citation-less line-coverage row instead of filing it as a normal task", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toMatch(/assertion-free filler/);
    expect(lower).toMatch(/(reject|flag)/);
  });

  it("names the gaming pattern of padding coverage without closing a real gap", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toMatch(/gam(e|ing)/);
  });
});

describe("test-fix — Step 4 dedup query is pagination-safe", () => {
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

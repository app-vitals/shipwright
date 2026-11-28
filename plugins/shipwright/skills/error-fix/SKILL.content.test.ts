/**
 * error-fix content tests — pagination-safe dedup query (task-store /tasks
 * pagination gap).
 *
 * The dedup check queries `GET /tasks?status=pending` and
 * `status=in_progress` unbounded (repo-unscoped — error-fix dedups
 * globally, not per-repo). task-store's plain GET /tasks path defaults to
 * `limit=50` and signals truncation via `nextCursor` (task-service.ts
 * `list()`), but a consumer that doesn't raise the limit and follow `nextCursor`
 * to completion silently undercounts once the active
 * task count exceeds 50 — exactly the failure mode that let three
 * already-queued tasks slip past dedup on 2026-07-23 (test-fix's own
 * dedup query, same shape).
 *
 * These tests assert the dedup step documents: an explicit high `limit=1000` on
 * both dedup queries, and a guard that checks the response's `nextCursor`
 * and pages via `cursor` until `nextCursor` is null.
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

describe("error-fix — per-repo contract (PCR-3.4)", () => {
  it("requires --repo with a usage error", () => {
    const skill = readSkill();
    expect(skill).toContain("Usage: /error-fix --repo org/repo");
    expect(skill).toContain("Error: --repo is required.");
  });

  it("uses --repo verbatim as the task repo instead of deriving it from a checkout", () => {
    const skill = readSkill();
    expect(skill).not.toContain("remote get-url origin");
    expect(skill).toContain('"repo": "<REPO>"');
  });

  it("reads findings from the store and links tasks back, with no report or ledger file", () => {
    const skill = readSkill();
    expect(skill).toContain("/patrol-findings?cronId=");
    expect(skill).toContain("/patrol-findings/batch");
    expect(skill).not.toContain("error-report.md");
    expect(skill).not.toContain("error-patrol-ledger");
    expect(skill).not.toContain("taskLinks");
  });

  it("documents the three routes and emits no hitl: true", () => {
    const skill = readSkill();
    expect(skill).toContain("Finding routing");
    for (const route of ["**auto**", "**review**", "**plan**"]) {
      expect(skill).toContain(route);
    }
    expect(skill).toContain("needs-review:");
    expect(skill).not.toMatch(/"hitl":\s*true/);
    expect(skill).not.toContain("hitl: <true");
  });
});

describe("error-fix — Step 5 dedup query is pagination-safe", () => {
  it("raises the dedup query limit well above the API's default page size", () => {
    expect(readSkill()).toContain("limit=1000");
  });

  it("documents checking the response's nextCursor field", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("nextcursor");
    expect(lower).toMatch(
      /check(ing)?.{0,40}nextcursor|nextcursor.{0,40}check/s,
    );
  });

  it("documents paging via cursor until nextCursor is null, with no offset paging", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("&cursor=");
    expect(lower).toContain("page");
    expect(lower).not.toContain("offset");
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

describe("PLU-4.4 origin provenance", () => {
  it("files tasks with originKind cron and the system-cron id as originRef", () => {
    const text = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
    expect(text).toContain('"originKind": "cron"');
    expect(text).toContain('"originRef": "<CRON_ID>"');
  });

  it("still writes source unchanged", () => {
    const text = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
    expect(text).toContain('"source": "error-fix"');
  });
});

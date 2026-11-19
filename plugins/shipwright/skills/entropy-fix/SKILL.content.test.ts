/**
 * entropy-fix content tests — pagination-safe dedup query (task-store
 * /tasks pagination gap).
 *
 * Step 6q.1's dedup check queries `GET /tasks?status=pending&repo=...` and
 * `status=in_progress&repo=...` unbounded. task-store's plain GET /tasks
 * path defaults to `limit=50` and signals truncation via `nextCursor`
 * (task-service.ts `list()`), but a consumer that doesn't raise the limit
 * and follow `nextCursor` to completion silently undercounts
 * once a repo has more than 50 active tasks — exactly the failure mode that
 * let three already-queued tasks slip past dedup on 2026-07-23.
 *
 * These tests assert Step 6q.1 documents: an explicit high `limit=1000` on
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

describe("entropy-fix — SKILL.md exists", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });
});

describe("entropy-fix — Step 6q.1 dedup query is pagination-safe", () => {
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

describe("SKILL.md — honors suppressions (.shipwright/suppressions.yml)", () => {
  const content = readSkill();

  it("re-checks suppressions between filtering and dry-run/dedup", () => {
    const step = content.indexOf("## Step 3.5: Re-check Suppressions");
    expect(step).toBeGreaterThan(
      content.indexOf("## Step 3: Filter and Group Findings"),
    );
    expect(step).toBeLessThan(content.indexOf("## Step 4: Dry-Run Output"));
  });

  it("reads .shipwright/suppressions.yml via the shared script", () => {
    expect(content).toContain(".shipwright/suppressions.yml");
    expect(content).toContain('suppressions.ts" --filter');
  });

  it("uses a skip message distinct from the active/recently-closed ones", () => {
    expect(content).toMatch(
      /Skipping .* suppressed in \.shipwright\/suppressions\.yml/,
    );
    expect(content).toContain(
      "Skipped (suppressed in .shipwright/suppressions.yml)",
    );
  });

  it("matches on file and symbol with rule entropy", () => {
    expect(content).toContain('{rule: "entropy", file, symbol');
  });
});

describe("PLU-4.4 origin provenance", () => {
  it("files tasks with originKind skill and its own name as originRef", () => {
    const text = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
    expect(text).toContain('"originKind": "skill"');
    expect(text).toContain('"originRef": "entropy-fix"');
  });

  it("still writes source unchanged", () => {
    const text = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
    expect(text).toContain('"source": "entropy-fix"');
  });
});

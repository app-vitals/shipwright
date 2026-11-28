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

describe("PCR-3.1 origin provenance", () => {
  it("stamps follow-on tasks originKind cron, originRef entropy-patrol and repo", () => {
    const text = readSkill();
    expect(text).toContain('"originKind": "cron"');
    expect(text).toContain('"originRef": "entropy-patrol"');
    expect(text).not.toContain('"originKind": "skill"');
    expect(text).toMatch(/"repo": "<repo/);
  });

  it("still writes source unchanged", () => {
    expect(readSkill()).toContain('"source": "entropy-fix"');
  });
});

describe("PCR-3.1 — required --repo", () => {
  it("prints a usage error when --repo is missing, in Setup", () => {
    const text = readSkill();
    const setup = text.indexOf("## Setup: Parse Arguments");
    const usage = text.indexOf(
      "Usage: /shipwright:entropy-fix --repo org/repo",
    );
    expect(setup).toBeGreaterThan(-1);
    expect(usage).toBeGreaterThan(setup);
    expect(usage).toBeLessThan(text.indexOf("## Step 1:"));
    expect(text).toContain("stop without");
  });

  it("does not detect the repo from git remotes or read entropy-report.md", () => {
    const text = readSkill();
    expect(text).not.toContain("git remote get-url origin");
    expect(text).not.toContain("entropy-report.md");
  });
});

describe("PCR-3.1 — no legacy state file outside the one-time import", () => {
  it("names the legacy ledger only inside the record/import step", () => {
    const text = readSkill();
    const start = text.indexOf("## Step 7: Record the run");
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf("\n---", start);
    const outside = text.slice(0, start) + text.slice(end);
    expect(outside).not.toContain("entropy-patrol-last-run");
    const inside = text.slice(start, end);
    expect(inside).toContain("state/entropy-patrol-last-run.json");
    expect(inside).toContain("--legacy-shape entropy-patrol-last-run");
    expect(inside).toContain("cron-run-recorder.ts");
  });
});

describe("PCR-3.1 — three-way routing (auto / review / plan)", () => {
  it("documents the three routes with their task shapes", () => {
    const text = readSkill();
    expect(text).toContain("### 6.1 Route each finding group");
    for (const route of ["**auto**", "**review**", "**plan**"]) {
      expect(text).toContain(route);
    }
    expect(text).toContain("needs-review:");
    expect(text).toContain('"kind": "prd"');
    expect(text).toContain("docs/task-store.md");
    expect(text).toContain("Finding routing");
  });

  it("maps per-finding HITL criteria to review and multi-PR/architectural to plan", () => {
    const text = readSkill();
    expect(text).toMatch(/per-finding.{0,400}review/s);
    expect(text).toMatch(/multi-PR|more than one PR/);
    expect(text).toMatch(/architectural/);
  });

  it("never creates a dev task with hitl: true; only the plan route uses it", () => {
    const text = readSkill();
    for (const m of text.matchAll(/"hitl":\s*true/g)) {
      const block = text.slice(text.lastIndexOf("```json", m.index), m.index);
      expect(block).toContain('"kind": "prd"');
    }
    for (const m of text.matchAll(/hitl:\s*true/g)) {
      const around = text.slice(Math.max(0, m.index - 300), m.index + 300);
      expect(around).toContain("plan");
    }
    expect(text.toLowerCase()).toContain("never `hitl: true` on a dev task");
  });

  it("dedups against blocked review tasks too", () => {
    expect(readSkill()).toContain("status=blocked");
  });

  it("records separate auto, review and plan metrics", () => {
    const text = readSkill();
    expect(text).toMatch(/"auto":/);
    expect(text).toMatch(/"review":/);
    expect(text).toMatch(/"plan":/);
    expect(text).toContain("cron-run-recorder.ts");
  });

  it("--dry-run records no run and writes no tasks", () => {
    const dry =
      readSkill().match(/`--dry-run`[^\n]*(\n {2}[^\n]*)*/)?.[0] ?? "";
    expect(dry).toMatch(/no run/i);
    expect(dry).toMatch(/task store/i);
  });
});

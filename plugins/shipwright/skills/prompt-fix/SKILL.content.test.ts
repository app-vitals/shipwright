/**
 * prompt-fix content tests — PAU-4.1
 *
 * Verifies the skill and its command stub: flags, step order, the per-run and
 * weekly caps, the task-id format, the body template (blast-radius block and
 * stop-if-differs rule), the PR must-prove list, and the propose-only guardrails.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");
const STUB_PATH = join(import.meta.dir, "../../commands/prompt-fix.md");
const POLICY_PATH = join(
  import.meta.dir,
  "../../scripts/prompt-audit/hitl-policy.ts",
);
const SCAN_SKILL_PATH = join(import.meta.dir, "../prompt-scan/SKILL.md");
const LEDGER_SCHEMA_PATH = join(
  import.meta.dir,
  "../prompt-scan/references/ledger-schema.md",
);

const skill = () => readFileSync(SKILL_MD_PATH, "utf8");
const stub = () => readFileSync(STUB_PATH, "utf8");

describe("prompt-fix — files exist", () => {
  it.each([SKILL_MD_PATH, STUB_PATH, POLICY_PATH])("%s exists", (p) => {
    expect(existsSync(p)).toBe(true);
  });
});

describe("prompt-fix — stub", () => {
  it("has the name, a description naming the flags, and invokes the skill", () => {
    const text = stub();
    expect(text).toMatch(/^---\nname: prompt-fix\n/);
    for (const flag of ["--dry-run", "--class", "--finding"])
      expect(text).toContain(flag);
    expect(text).toContain("Invoke the `prompt-fix` skill.");
  });
});

describe("prompt-fix — SKILL.md", () => {
  it("has frontmatter naming the skill", () => {
    expect(skill()).toMatch(/^---\nname: prompt-fix\n/);
  });

  it.each(["--dry-run", "--class <a|b|c|e|f>", "--finding <fp>"])(
    "documents %s",
    (flag) => {
      expect(skill()).toContain(flag);
    },
  );

  it("steps appear in order", () => {
    const text = skill();
    const headings = [
      "## Setup: Parse Arguments",
      "## Step 1: Verify the Report Exists",
      "## Step 2: Filter to `proposed` Findings Only",
      "## Step 3: Re-Check the Decisions Registry Live",
      "## Step 4: Pre-Filing Verification",
      "## Step 5: Cutover Freeze Check",
      "## Step 6: Weekly Cap Check",
      "## Step 7: Dry-Run Preview",
      "## Step 8: Dedup Against the Task Store",
      "## Step 9: Order and Cap at 10 Tasks per Run",
      "## Step 10: Build Task JSON",
      "## Step 11: Write and Append",
      "## Step 12: Mark the Ledger",
      "## Step 13: Print Summary",
      "## Known Gap",
      "## Constraints (Do Not Violate)",
    ];
    let last = -1;
    for (const h of headings) {
      const idx = text.indexOf(h);
      expect(idx, `missing heading: ${h}`).toBeGreaterThan(-1);
      expect(idx, `out of order: ${h}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("re-checks decisions and autonomy entries and cites pre-filing verification", () => {
    const text = skill();
    expect(text).toContain(".claude/shipwright/prompt-audit-decisions.md");
    expect(text).toContain("**Autonomy:**");
    expect(text).toContain("references/pre-filing-verification.md");
    expect(text).toContain("file:line");
  });

  it("states the cutover freeze and the weekly cap", () => {
    const text = skill();
    expect(text).toContain("PAU-2.3");
    expect(text).toContain("PAU-2.4");
    expect(text).toContain("cutover window");
    expect(text).toMatch(
      /At most \*\*2 prompt-fix tasks open or merged this ISO week/,
    );
    expect(text).toContain("weekly cap 2");
    expect(text).toContain("Refusing to file");
  });

  it("states the cap of 10, class c first, then projected saving", () => {
    const text = skill();
    expect(text).toContain("at most **10 tasks per run**");
    expect(text).toMatch(/class \(c\) first/);
    expect(text).toContain("projected saving");
  });

  it("rejects class d: only a, b, c, e and f are documented", () => {
    const text = skill();
    expect(text).toContain("(`a`, `b`, `c`, `e` or `f`)");
    expect(text).not.toMatch(/`c`, `d`/);
  });

  it("dedups before applying the per-run and weekly cap", () => {
    const text = skill();
    expect(text.indexOf("## Step 8: Dedup")).toBeLessThan(
      text.indexOf("## Step 9: Order and Cap"),
    );
  });

  it("dedups with limit=1000, the pagination guard and the prompt- prefix", () => {
    const text = skill();
    expect(text).toContain("status=pending&repo=");
    expect(text).toContain("status=in_progress&repo=");
    expect(text).toContain("limit=1000");
    expect(text).toContain("Pagination guard");
    expect(text).toContain("`prompt-` prefix");
    expect(text).toContain("/tasks/bulk");
    expect(text).toContain("`status: queued`");
    expect(text).toContain("`taskId`");
  });

  it("states the task-id format string and task shape", () => {
    const text = skill();
    expect(text).toContain("prompt-{class}-{fp8}-{repo-slug}-{YYYY-Www}");
    expect(text).toContain("Prompt audit: {rule} - {file}");
    expect(text).toContain('"source": "prompt-fix"');
    expect(text).toContain("chore/prompt-{fp8}-{slug}");
    expect(text).toContain('"layer": "Docs"');
  });

  it("computes hitl with hitl-policy.ts and launches propose-only", () => {
    const text = skill();
    expect(text).toContain("scripts/prompt-audit/hitl-policy.ts");
    expect(text).toContain("every task is `hitl: true`");
    expect(text).toContain("including class (c)");
    expect(text).toContain("never judged");
    expect(text).toContain("Quality-claimed");
  });

  it("embeds the blast-radius block and the stop-if-differs rule", () => {
    const text = skill();
    expect(text).toContain("## Blast radius (computed at filing)");
    expect(text).toContain("cli.ts blast --file {file} --json");
    expect(text).toContain(
      "If its output differs from the report above, STOP and escalate",
    );
  });

  it("carries the acceptance-criteria template", () => {
    const text = skill();
    expect(text).toContain("## Acceptance criteria");
    expect(text).toContain(
      "cli.ts measure --finding {fp} --before main --after HEAD --model {m}",
    );
    expect(text).toContain("tokenDelta <= -{N}");
    expect(text).toContain(
      "/shipwright:prompt-eval --finding {fp} --kind {kind} --max-cost-usd {X}",
    );
    expect(text).toContain("`measured` is populated");
  });

  it("lists the PR must-prove items", () => {
    const text = skill();
    const start = text.indexOf("## PR must prove");
    expect(start).toBeGreaterThan(-1);
    const section = text.slice(start, text.indexOf("## Suppress instead"));
    for (const item of [
      "content tests pass",
      "same-model token delta",
      "every removed line is dispositioned",
      "always-loaded set did not grow",
      "eval or production-series result",
      "`docs:` or `chore:`",
    ])
      expect(section).toContain(item);
  });

  it("includes the suppress-instead note", () => {
    expect(skill()).toContain("## Suppress instead");
  });

  it("documents the known gap", () => {
    const text = skill();
    expect(text).toContain("blocks agent pickup, **not merge**");
    expect(text).toContain("0 approvals");
    expect(text).toContain("bypass actor");
    expect(text).toContain("CODEOWNERS");
    expect(text).toContain("open question");
  });

  it("dry-run writes nothing", () => {
    const text = skill();
    expect(text).toContain("Ledger not modified");
    expect(text).toContain("`--dry-run` mutates nothing");
  });
});

describe("prompt-scan summary lists aged HITL prompt-fix tasks", () => {
  it("mentions open prompt-fix HITL tasks older than 14 days", () => {
    const text = readFileSync(SCAN_SKILL_PATH, "utf8");
    expect(text).toContain("older than 14 days");
    expect(text).toContain("prompt-fix");
  });
});

describe("ledger-schema documents prompt-fix transitions", () => {
  it("covers queued, taskId and regressed", () => {
    const text = readFileSync(LEDGER_SCHEMA_PATH, "utf8");
    expect(text).toContain("`prompt-fix` sets `queued`");
    expect(text).toContain("`regressed`");
    expect(text).toContain("`taskId`");
  });
});

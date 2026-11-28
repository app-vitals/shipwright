/**
 * PCR-4.2 — test-readiness on the system-cron contract.
 *
 * Content assertions for the test-readiness skill, its five phase skills and
 * the docs/test-readiness artifacts: every run is recorded through the shared
 * recorder, counts and refresh logs live in run metrics (not in the
 * artifacts), test-fix routes findings auto / review / plan instead of
 * `hitl: true`, and a docs PR opens only on material change.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(pluginRoot, "..", "..");

const skill = (name: string): string =>
  readFileSync(join(pluginRoot, "skills", name, "SKILL.md"), "utf8");
const doc = (name: string): string =>
  readFileSync(join(repoRoot, "docs", "test-readiness", name), "utf8");

const PHASES = [
  "test-inventory",
  "test-design",
  "test-migration",
  "test-roadmap",
  "test-fix",
] as const;

describe("test-readiness — run record through the shared recorder", () => {
  const body = skill("test-readiness");

  it("records via cron-run-recorder.ts with cron id test-readiness", () => {
    expect(body).toContain("cron-run-recorder.ts record");
    expect(body).toContain("--cron test-readiness");
    expect(body).toContain("--repo {org/repo}");
  });

  it("links the system-cron contract in docs/task-store.md", () => {
    expect(body).toContain("docs/task-store.md");
  });

  it("ends with the run-record step", () => {
    const stepIdx = body.indexOf("## Step 5: Record the run");
    expect(stepIdx).toBeGreaterThan(body.indexOf("### Step 4: Report"));
    expect(stepIdx).toBeGreaterThan(body.indexOf("## Failure handling"));
    expect(stepIdx).toBeGreaterThan(body.indexOf("## Notes"));
    // no further section follows, and the record command is inside it
    expect(body.slice(stepIdx + 3)).not.toMatch(/\n#{1,3} /);
    expect(body.lastIndexOf("cron-run-recorder.ts record")).toBeGreaterThan(
      stepIdx,
    );
  });

  it("records no-op and failed runs too, with outcome ok | no_op | failed", () => {
    expect(body).toMatch(/no_op/);
    expect(body).toMatch(/"outcome": "ok" \| "no_op" \| "failed"|failed/);
    expect(body).toContain("exactly one `RepoCronRun`");
  });

  it("puts counts in run metrics, including per-route counts and phase counts", () => {
    for (const k of [
      "rows_added",
      "rows_removed",
      "rows_reverified",
      "auto",
      "review",
      "plan",
      "docs_pr",
    ]) {
      expect(body).toContain(k);
    }
  });

  it("opens the docs PR only on material change via the shared checker", () => {
    expect(body).toContain("check-patrol-docs.ts");
    expect(body).toContain("materiallyChanged");
    expect(body.toLowerCase()).toContain("only on material change");
  });

  it("keeps --publish as the queue-for-real switch", () => {
    expect(body).toContain("`--publish`");
    expect(body).toMatch(/--publish[^\n]*real/i);
    expect(body).toContain("--dry-run");
  });

  it("uses no agent-local state file", () => {
    expect(body).not.toMatch(/state\/[a-z-]+\.json/);
  });
});

describe("phase skills — counts go to run metrics, never into artifacts", () => {
  for (const phase of PHASES.filter((p) => p !== "test-fix")) {
    it(`${phase} reports run metrics and forbids refresh-log / count lines in its artifact`, () => {
      const body = skill(phase);
      expect(body).toContain("## Run metrics");
      expect(body).toContain("refresh log");
      expect(body.toLowerCase()).toMatch(/never write[^\n]*refresh/);
      expect(body).toContain("docs/task-store.md");
    });
  }

  it("test-inventory names its row-count metrics", () => {
    const body = skill("test-inventory");
    expect(body).toContain("rows_added");
    expect(body).toContain("rows_removed");
    expect(body).toContain("rows_reverified");
  });

  it("test-fix reports routed-task counts in run metrics", () => {
    const body = skill("test-fix");
    expect(body).toContain("## Run metrics");
    for (const k of ["auto", "review", "plan"]) expect(body).toContain(k);
  });
});

describe("test-fix — routes findings auto / review / plan", () => {
  const body = skill("test-fix");

  it("documents the three routes", () => {
    expect(body).toContain("### 5.2 Route the Row");
    expect(body).toMatch(/\*\*auto\*\*/);
    expect(body).toMatch(/\*\*review\*\*/);
    expect(body).toMatch(/\*\*plan\*\*/);
  });

  it("creates review tasks blocked with a needs-review reason", () => {
    expect(body).toContain('`status: "blocked"`');
    expect(body).toContain("needs-review:");
    expect(body).toContain("POST /tasks/{id}/unblock");
  });

  it("creates plan tasks as kind prd for a human to plan", () => {
    expect(body).toContain('`kind: "prd"`');
    expect(body).toContain("/shipwright:prd");
  });

  it("links the finding-routing contract", () => {
    expect(body).toContain("docs/task-store.md");
    expect(body).toContain("Finding routing");
  });

  it("no longer emits hitl: true dev tasks or a HITL queue outcome", () => {
    expect(body).not.toContain("### 5.2 Compute the `hitl` Field");
    expect(body).not.toContain("{H} HITL");
    expect(body).not.toContain("HITL tasks are picked up via");
    expect(body).not.toMatch(/Set `hitl: true`/);
    expect(body).not.toContain("hitl: {true|false}");
    expect(body).toMatch(/never[^\n]*`?hitl: true`?/i);
  });

  it("stamps routed dev tasks hitl false", () => {
    expect(body).toContain("`hitl: false`");
  });
});

describe("docs/test-readiness artifacts — no refresh logs or count lines", () => {
  const files = [
    "test-inventory.md",
    "test-system.md",
    "test-migration.md",
    "test-readiness-plan.md",
  ];
  for (const f of files) {
    it(`${f} carries no refresh-log blocks`, () => {
      const text = doc(f);
      expect(text).not.toMatch(
        /^> \*\*20\d\d-\d\d-\d\d[^\n]*(refresh|delta|top-up)/im,
      );
      expect(text).not.toMatch(/^- \*\*Delta since the /m);
      expect(text).not.toMatch(/^- \*\*20\d\d-\d\d-\d\d delta/m);
      expect(text).not.toMatch(/\(last refreshed /);
      expect(text).not.toMatch(/preserved for continuity/);
      expect(text).not.toMatch(/^> \*\*\w+ pass \(/m);
      expect(text).not.toMatch(/\d+ rows? added, \d+ removed/);
    });
  }
});

describe("docs/test-readiness artifacts — no cycle-relative narrative", () => {
  // Matched case-insensitively and anywhere in a line, not just in bold
  // headers. Bare "cycle" stays legal (e.g. "the shipwright-loop dispatch
  // cycle"); only run-relative framing ("this cycle", "prior-cycle",
  // "2026-10-02 cycle", "every prior cycle") is banned, since the next
  // /test-readiness run would otherwise treat it as content to preserve.
  const files = [
    "test-inventory.md",
    "test-system.md",
    "test-migration.md",
    "test-readiness-plan.md",
    "naming.md",
  ];
  for (const f of files) {
    it(`${f} carries no "this/prior/new this cycle" narrative`, () => {
      const text = doc(f);
      expect(text).not.toMatch(
        /\b(this|prior|previous|last|earlier|next|future|every|several|single)[- ]cycles?\b/i,
      );
      expect(text).not.toMatch(/\bnew this cycle\b/i);
      expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d cycle\b/i);
    });
  }
});

describe("docs/test-readiness artifacts — no stacked or superseded readings", () => {
  // Each artifact keeps only the latest reading; git holds the history.
  // Word-bounded so code identifiers such as `isSupersededBySameHeadApproval`
  // stay legal while prose like "supersedes the 2026-11-25 figures" does not.
  const files = [
    "test-inventory.md",
    "test-system.md",
    "test-migration.md",
    "test-readiness-plan.md",
    "naming.md",
  ];
  for (const f of files) {
    it(`${f} carries no superseded/re-sourced/prior-pass readings`, () => {
      const text = doc(f);
      expect(text).not.toMatch(/\bsupersed(e|es|ed|ing)\b/i);
      expect(text).not.toMatch(/\bre-sourc(e|es|ed|ing)\b/i);
      expect(text).not.toMatch(/\bmeasured this pass\b/i);
      expect(text).not.toMatch(/\bolder readings?\b/i);
      expect(text).not.toMatch(/\bcarried forward\b/i);
      expect(text).not.toMatch(
        /\b(first|second|third|prior|previous|earlier|this) pass\b/i,
      );
      expect(text).not.toMatch(/^\s*- \*\*20\d\d-\d\d-\d\d:/m);
      expect(text).not.toMatch(/\(historical\b/i);
    });
  }

  it("test-readiness-plan.md has a single Coverage Gate reading", () => {
    const text = doc("test-readiness-plan.md");
    const gate = text.split("## Coverage Gate")[1]?.split(/^## /m)[0] ?? "";
    const verdicts = gate.match(/check-coverage-gate\.ts\n/g) ?? [];
    expect(verdicts.length).toBe(1);
  });
});

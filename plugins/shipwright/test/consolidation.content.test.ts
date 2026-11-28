/**
 * consolidation.md content tests — CVG-1.5
 *
 * Verifies docs/consolidation.md documents the consolidation-patrol system
 * end to end: what consolidation-scan and consolidation-fix do, the ledger
 * format (fingerprint, occurrence_count, consecutive_stable_runs, status),
 * the .claude/shipwright/consolidation-decisions.md registry format and how
 * to add/revise an entry, and the consolidation-patrol-maintenance cron
 * (schedule, disabled-by-default, how to enable it).
 *
 * Also verifies the root CLAUDE.md Reference section includes a one-line
 * entry pointing to docs/consolidation.md.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file
 * reads.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/test/ → repo root
const repoRoot = resolve(import.meta.dir, "..", "..", "..");

const consolidationDocPath = join(repoRoot, "docs", "consolidation.md");
const claudeMdPath = join(repoRoot, "CLAUDE.md");

function readConsolidationDoc(): string {
  return readFileSync(consolidationDocPath, "utf8");
}

function readClaude(): string {
  return readFileSync(claudeMdPath, "utf8");
}

// ── File exists ─────────────────────────────────────────────────────────────

describe("consolidation.md — file", () => {
  it("docs/consolidation.md exists", () => {
    expect(existsSync(consolidationDocPath)).toBe(true);
  });
});

// ── Skills documented ────────────────────────────────────────────────────────

describe("consolidation.md — skills", () => {
  it("mentions consolidation-scan skill", () => {
    expect(readConsolidationDoc()).toContain("consolidation-scan");
  });

  it("mentions consolidation-fix skill", () => {
    expect(readConsolidationDoc()).toContain("consolidation-fix");
  });

  it("documents what each skill does", () => {
    const doc = readConsolidationDoc();
    expect(doc.toLowerCase()).toMatch(/(report|survey)/);
  });
});

// ── Ledger format documented ─────────────────────────────────────────────────

describe("consolidation.md — ledger format", () => {
  const ledgerFields = [
    "fingerprint",
    "occurrence_count",
    "consecutive_stable_runs",
    "status",
    "ready_to_propose",
    "tracking",
  ];

  for (const field of ledgerFields) {
    it(`documents ledger field: ${field}`, () => {
      expect(readConsolidationDoc()).toContain(field);
    });
  }

  it("states the ledger lives in the task store as PatrolFinding rows", () => {
    const doc = readConsolidationDoc();
    expect(doc).toContain("PatrolFinding");
    expect(doc).toContain("task store");
  });

  it("no longer describes the agent-local ledger", () => {
    const doc = readConsolidationDoc();
    expect(doc).not.toContain("agent workspace state");
    expect(doc).not.toContain("git-ignored");
  });

  it("documents docs/patrols/consolidation.md as the readable file", () => {
    const doc = readConsolidationDoc();
    expect(doc).toContain("docs/patrols/consolidation.md");
    expect(doc).toContain("check-patrol-docs.ts");
    expect(doc).toContain("150");
  });

  it("documents the one-time legacy import via the cron-run recorder", () => {
    const doc = readConsolidationDoc();
    expect(doc).toContain("cron-run-recorder.ts");
    expect(doc).toContain("--legacy-shape consolidation-ledger");
  });

  it("documents the required --repo flag", () => {
    expect(readConsolidationDoc()).toContain("--repo");
  });

  it("explains the Rule of Three promotion criteria", () => {
    const doc = readConsolidationDoc().toLowerCase();
    expect(doc).toMatch(/(occurrence_count|occurrence count).*3/);
    expect(doc).toMatch(/(consecutive_stable_runs|consecutive stable runs).*2/);
  });
});

// ── Decisions registry documented ────────────────────────────────────────────

describe("consolidation.md — decisions registry", () => {
  const registryFields = [
    "**Pattern:**",
    "**Decision:**",
    "**Rationale:**",
    "**Revisit:**",
  ];

  for (const field of registryFields) {
    it(`documents registry field: ${field}`, () => {
      expect(readConsolidationDoc()).toContain(field);
    });
  }

  it("mentions .claude/shipwright/consolidation-decisions.md", () => {
    expect(readConsolidationDoc()).toContain(
      ".claude/shipwright/consolidation-decisions.md",
    );
  });

  it("explains how to add an entry", () => {
    expect(readConsolidationDoc().toLowerCase()).toMatch(
      /(add|create|write|entry)/,
    );
  });

  it("explains how to revise an entry", () => {
    expect(readConsolidationDoc().toLowerCase()).toMatch(/(revise|edit|update)/);
  });
});

// ── Cron documented ──────────────────────────────────────────────────────────

describe("consolidation.md — cron", () => {
  it("documents the consolidation-patrol system cron, one task per repo", () => {
    const doc = readConsolidationDoc();
    expect(doc).toContain("`consolidation-patrol`");
    expect(doc.toLowerCase()).toContain("system cron");
    expect(doc.toLowerCase()).toContain("one task per repo");
  });

  it("documents the cron schedule: 0 5 * * 1", () => {
    expect(readConsolidationDoc()).toContain("0 5 * * 1");
  });

  it("notes the cron is seeded disabled and how to enable it", () => {
    const lower = readConsolidationDoc().toLowerCase();
    expect(lower).toContain("disabled");
    expect(lower).toMatch(/(enable|toggle|opt-in)/);
  });

  it("no longer describes the agent-level cron or its preCheck", () => {
    const doc = readConsolidationDoc();
    expect(doc).not.toContain("consolidation-patrol-maintenance");
    expect(doc).not.toContain("check-consolidation-patrol");
    expect(doc).not.toContain("/admin/agents/{id}/crons");
  });
});

// ── Root CLAUDE.md Reference section updated ─────────────────────────────────

describe("root CLAUDE.md", () => {
  it("Reference section includes a consolidation.md entry", () => {
    const claude = readClaude();
    expect(claude).toContain("docs/consolidation.md");
  });

  it("consolidation.md entry is in the Reference section (after observability)", () => {
    const claude = readClaude();
    const refStart = claude.indexOf("## Reference");
    const consolidationLineIdx = claude.indexOf(
      "docs/consolidation.md",
      refStart,
    );
    const observabilityLineIdx = claude.indexOf("docs/observability.md", refStart);

    expect(refStart).toBeGreaterThanOrEqual(0);
    expect(consolidationLineIdx).toBeGreaterThanOrEqual(0);
    expect(observabilityLineIdx).toBeGreaterThanOrEqual(0);
    // consolidation.md line should come after observability.md line
    expect(consolidationLineIdx).toBeGreaterThan(observabilityLineIdx);
  });

  it("consolidation.md entry follows the one-line bolded-path-then-summary style", () => {
    const claude = readClaude();
    const consolidationLine = claude
      .split("\n")
      .find(
        (line) =>
          line.includes("docs/consolidation.md") &&
          line.includes("**docs/consolidation.md**"),
      );

    expect(consolidationLine).toBeDefined();
    expect(consolidationLine).toContain("—");
  });
});

// ── Skills: per-repo, store-backed ledger (PCR-3.2) ──────────────────────────

const skillsDir = join(repoRoot, "plugins", "shipwright", "skills");
const scanSkill = (): string =>
  readFileSync(join(skillsDir, "consolidation-scan", "SKILL.md"), "utf8");
const fixSkill = (): string =>
  readFileSync(join(skillsDir, "consolidation-fix", "SKILL.md"), "utf8");
const scanCommand = (): string =>
  readFileSync(
    join(repoRoot, "plugins", "shipwright", "commands", "consolidation-scan.md"),
    "utf8",
  );
const fixCommand = (): string =>
  readFileSync(
    join(repoRoot, "plugins", "shipwright", "commands", "consolidation-fix.md"),
    "utf8",
  );
const LEGACY = "state/consolidation-ledger.json";

describe("consolidation-scan — per-repo, store-backed (PCR-3.2)", () => {
  it("requires --repo and prints a usage error when it is missing", () => {
    const s = scanSkill();
    expect(s).toContain("--repo org/repo");
    expect(s).toMatch(/Usage: \/shipwright:consolidation-scan --repo org\/repo/);
    expect(s.toLowerCase()).toContain("--repo is required");
    expect(scanCommand()).toContain("--repo");
  });

  it("reads prior findings from the store and upserts after the scan", () => {
    const s = scanSkill();
    expect(s).toContain("PatrolFinding");
    expect(s).toContain("cron-run-recorder.ts");
    expect(s).toContain("prior");
    expect(s).toContain("record");
    expect(s).toContain("consolidation-patrol");
  });

  it("only mentions the legacy ledger path in the one-time import step", () => {
    const s = scanSkill();
    expect(s).toContain("--legacy-shape consolidation-ledger");
    // every mention of the legacy path sits inside the import step section
    const importStart = s.indexOf("## Step 2");
    const importEnd = s.indexOf("## Step 3");
    expect(importStart).toBeGreaterThan(-1);
    let idx = s.indexOf(LEGACY);
    while (idx !== -1) {
      expect(idx).toBeGreaterThan(importStart);
      expect(idx).toBeLessThan(importEnd);
      idx = s.indexOf(LEGACY, idx + 1);
    }
  });

  it("keeps the stabilization threshold unchanged", () => {
    const s = scanSkill();
    expect(s).toContain("occurrence_count >= 3");
    expect(s).toContain("consecutive_stable_runs >= 2");
  });

  it("writes docs/patrols/consolidation.md, validated, PR only on material change", () => {
    const s = scanSkill();
    expect(s).toContain("docs/patrols/consolidation.md");
    expect(s).toContain("check-patrol-docs.ts");
    expect(s).toContain("materiallyChanged");
    expect(s).toContain("150");
    expect(s.toLowerCase()).toContain("open patterns");
    expect(s).not.toContain("consolidation-report.md");
  });

  it("records exactly one run with metrics", () => {
    const s = scanSkill();
    expect(s.toLowerCase()).toContain("exactly one run");
    expect(s).toContain("metrics");
  });
});

describe("consolidation-fix — per-repo, three-way routing (PCR-3.2)", () => {
  it("requires --repo and prints a usage error when it is missing", () => {
    const s = fixSkill();
    expect(s).toContain("--repo org/repo");
    expect(s).toMatch(/Usage: \/shipwright:consolidation-fix --repo org\/repo/);
    expect(s.toLowerCase()).toContain("--repo is required");
    expect(fixCommand()).toContain("--repo");
  });

  it("reads ready_to_propose patterns from PatrolFinding, not the legacy ledger or a report file", () => {
    const s = fixSkill();
    expect(s).toContain("PatrolFinding");
    expect(s).toContain("/patrol-findings");
    expect(s).toContain("ready_to_propose");
    expect(s).not.toContain(LEGACY);
    expect(s).not.toContain("consolidation-report.md");
  });

  it("documents the three routes: auto, review, plan", () => {
    const s = fixSkill();
    expect(s).toContain("**auto**");
    expect(s).toContain("**review**");
    expect(s).toContain("**plan**");
    expect(s).toContain("needs-review:");
    expect(s).toContain('"kind": "prd"');
    expect(s).toContain("docs/task-store.md");
  });

  it("maps multi-PR strangler-fig plans to the plan route and single-PR fixes to auto or review", () => {
    const lower = fixSkill().toLowerCase();
    expect(lower).toMatch(/several prs|multi-pr|multiple prs/);
    expect(lower).toMatch(/single[- ]pr/);
  });

  it("emits hitl: true only on the plan route", () => {
    const s = fixSkill();
    const trues = s.match(/"hitl": true/g) ?? [];
    expect(trues.length).toBe(1);
    expect(s).toContain('"hitl": false');
    expect(s).not.toMatch(/"hitl": <true \| false/);
    // the sole hitl: true sits in the same task body as kind prd
    const at = s.indexOf('"hitl": true');
    expect(s.slice(Math.max(0, at - 400), at + 100)).toContain('"kind": "prd"');
  });

  it("counts auto, review and plan separately in run metrics and records one run", () => {
    const s = fixSkill();
    expect(s).toContain("cron-run-recorder.ts");
    expect(s).toMatch(/auto.*review.*plan/s);
    expect(s).toContain("originKind");
    expect(s).toContain('"cron"');
  });
});

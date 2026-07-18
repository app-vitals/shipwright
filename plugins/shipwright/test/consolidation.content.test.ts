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

  it("mentions state/consolidation-ledger.json", () => {
    expect(readConsolidationDoc()).toContain(
      "state/consolidation-ledger.json",
    );
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
  it("mentions consolidation-patrol-maintenance cron", () => {
    expect(readConsolidationDoc()).toContain("consolidation-patrol-maintenance");
  });

  it("documents the cron schedule: 0 5 * * 1", () => {
    expect(readConsolidationDoc()).toContain("0 5 * * 1");
  });

  it("notes the cron is disabled by default", () => {
    expect(readConsolidationDoc().toLowerCase()).toContain("disabled");
  });

  it("explains how to enable the cron", () => {
    expect(readConsolidationDoc().toLowerCase()).toMatch(/(enable|toggle|opt-in)/);
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

/**
 * consolidation-fix content tests — CVG-1.3
 *
 * Verifies plugins/shipwright/skills/consolidation-fix/SKILL.md and its thin
 * command wrapper (commands/consolidation-fix.md) exist and document the
 * required behavior:
 *   - Reads consolidation-report.md, acts only on ready_to_propose entries
 *     (never `tracking`)
 *   - Cross-checks .claude/shipwright/consolidation-decisions.md before queueing
 *   - Dedupes against pending/in-progress task-store tasks using the exact same
 *     query/filter mechanism entropy-fix already uses
 *   - Queued task titles carry a "Consolidation:" prefix so the dedup filter can
 *     match them
 *   - Queued task descriptions include a strangler-fig (build -> coexist ->
 *     eliminate) execution plan broken into small PR-sized steps
 *   - hitl classification is a per-finding judgment call, not a blanket value
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file
 * reads (mirrors consolidation-decisions.content.test.ts / entropy-fix's own
 * content coverage in plugin-absorption.content.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/test/ → plugins/shipwright/
const pluginRoot = resolve(import.meta.dir, "..");

function pluginPath(...parts: string[]): string {
  return join(pluginRoot, ...parts);
}

const skillPath = pluginPath("skills", "consolidation-fix", "SKILL.md");
const commandPath = pluginPath("commands", "consolidation-fix.md");

function readSkill(): string {
  return readFileSync(skillPath, "utf8");
}

// ── Files exist ──────────────────────────────────────────────────────────────

describe("consolidation-fix — files exist", () => {
  it("skills/consolidation-fix/SKILL.md exists", () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it("commands/consolidation-fix.md exists", () => {
    expect(existsSync(commandPath)).toBe(true);
  });
});

// ── Reads consolidation-report.md, only ready_to_propose entries ────────────

describe("consolidation-fix — reads consolidation-report.md, ready_to_propose only", () => {
  it("mentions reading consolidation-report.md", () => {
    expect(readSkill()).toContain("consolidation-report.md");
  });

  it("mentions acting on ready_to_propose entries", () => {
    expect(readSkill()).toContain("ready_to_propose");
  });

  it("explicitly distinguishes ready_to_propose from tracking entries", () => {
    expect(readSkill()).toContain("tracking");
  });
});

// ── Cross-checks consolidation-decisions.md before queueing ─────────────────

describe("consolidation-fix — cross-checks consolidation-decisions.md", () => {
  it("mentions .claude/shipwright/consolidation-decisions.md", () => {
    expect(readSkill()).toContain(".claude/shipwright/consolidation-decisions.md");
  });

  it("documents cross-checking it before queueing (not just reading it once)", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("cross-check");
  });

  it("mentions accepted debt / suppression as a reason to skip queueing", () => {
    const lower = readSkill().toLowerCase();
    expect(lower.includes("accepted as debt") || lower.includes("suppress")).toBe(true);
  });
});

// ── Dedup mechanism mirrors entropy-fix exactly ──────────────────────────────

describe("consolidation-fix — dedup mechanism mirrors entropy-fix", () => {
  it("documents the GET /tasks?status=pending query", () => {
    expect(readSkill()).toContain("/tasks?status=pending");
  });

  it("documents the GET /tasks?status=in_progress query", () => {
    expect(readSkill()).toContain("status=in_progress");
  });

  it('documents the source == "shipwright" filter', () => {
    expect(readSkill()).toContain('source == "shipwright"');
  });

  it("documents a title-prefix match as the alternate filter branch", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("title-prefix");
  });

  it("does not introduce a new task-store schema field", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("no new task-store schema");
  });
});

// ── "Consolidation:" title prefix ────────────────────────────────────────────

describe("consolidation-fix — queued task titles use a 'Consolidation:' prefix", () => {
  it('documents "Consolidation:" as the task title prefix', () => {
    expect(readSkill()).toContain("Consolidation:");
  });
});

// ── Strangler-fig execution plan ─────────────────────────────────────────────

describe("consolidation-fix — strangler-fig execution plan", () => {
  it('mentions "strangler-fig" by name', () => {
    expect(readSkill().toLowerCase()).toContain("strangler-fig");
  });

  it("documents building the canonical path as a step", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("canonical");
  });

  it("documents a coexist phase where old and new call sites both pass tests", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("coexist");
  });

  it("documents eliminating old call sites as a final phase", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("eliminate");
  });

  it("documents breaking the migration into small, separate PRs (not one sweeping diff)", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("small");
    expect(lower.includes("separate pr") || lower.includes("pr-sized")).toBe(true);
  });
});

// ── hitl classification is per-finding judgment ──────────────────────────────

describe("consolidation-fix — per-finding hitl classification", () => {
  it('contains a "hitl" field in the task JSON section', () => {
    expect(readSkill()).toContain('"hitl"');
  });

  it("documents the single-clear-canonical-shape / existing-precedent path to hitl: false", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("existing precedent");
  });

  it("documents multiple-plausible-shapes / crosses-service-boundary / >~5 call sites path to hitl: true", () => {
    const lower = readSkill().toLowerCase();
    expect(lower.includes("multiple plausible")).toBe(true);
    expect(lower.includes("service") || lower.includes("repo boundar")).toBe(true);
    expect(lower).toMatch(/five call sites|~5 call sites|5 call sites/);
  });

  it("does not impose a blanket true/false — documents this is a per-finding judgment call", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("judgment");
  });

  it("does not add a numeric backstop beyond the ~5 call site heuristic", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("no numeric backstop");
  });
});

// ── Constraints: queue-only, no PR creation, no code changes ────────────────

describe("consolidation-fix — constraints", () => {
  it("documents that this skill queues tasks only (no PR creation)", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("no pr creation");
  });

  it("documents that it makes no direct code changes", () => {
    const lower = readSkill().toLowerCase();
    expect(lower.includes("no code changes")).toBe(true);
  });

  it("documents that it does not re-run consolidation-scan itself", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("consolidation-scan");
    expect(lower).toContain("does not re-run");
  });
});

// ── Command wrapper ──────────────────────────────────────────────────────────

describe("consolidation-fix — command wrapper", () => {
  function readCommand(): string {
    return readFileSync(commandPath, "utf8");
  }

  it("frontmatter names the consolidation-fix skill", () => {
    expect(readCommand()).toContain("consolidation-fix");
  });

  it("body invokes the consolidation-fix skill", () => {
    const lower = readCommand().toLowerCase();
    expect(lower).toContain("invoke");
    expect(lower).toContain("consolidation-fix");
  });
});

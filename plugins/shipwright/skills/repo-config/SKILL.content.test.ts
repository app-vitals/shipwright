/**
 * repo-config content tests — coverage-check 3-stage branch-protection
 * pairing lifecycle (RAT-1.1).
 *
 * The existing "pairing rule" section documents a 2-stage pattern (CI job
 * lands -> dependent task enables it as required) for general workflow
 * tasks (test.yml, canary, deploy). The coverage-required-check needs a
 * third stage because raising the floor straight to a hard 90% gate would
 * instantly break every repo currently below it:
 *
 *   1. coverage CI job lands
 *   2. "coverage must not decrease" required check enabled immediately
 *      (paired task, same mechanism as the existing 2-stage pattern)
 *   3. hard >=90% required check, auto-emitted by test-roadmap once it
 *      confirms coverage_gate.line_coverage_pct >= 90 on a re-run
 *
 * A repo already >=90% at onboarding time skips stage 2 entirely and goes
 * straight to stage 3 — no wasted never-decrease-only intermediate stage.
 *
 * These tests assert the new section exists alongside (not replacing) the
 * original 2-stage table, and that its prose covers the 3-stage sequence,
 * the never-decrease-immediately concept, test-roadmap's auto-promotion
 * role, and the >=90%-skip-straight-to-hard-gate onboarding rule.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

let content: string;

beforeAll(() => {
  content = existsSync(SKILL_MD_PATH)
    ? readFileSync(SKILL_MD_PATH, "utf-8")
    : "";
});

describe("SKILL.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("SKILL.md — frontmatter", () => {
  it("has frontmatter with name: repo-config", () => {
    expect(content).toContain("name: repo-config");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — existing 2-stage pairing table stays intact", () => {
  it("still has the original pairing-rule section header", () => {
    expect(content).toContain("## The pairing rule (Phase 4 — test-roadmap)");
  });

  it("still documents the original workflow -> branch-protection table", () => {
    expect(content).toContain(
      "| Workflow task | Paired branch-protection task |",
    );
    expect(content).toContain("Create / update `test.yml` with required jobs");
    expect(content).toContain("Add canary workflow");
    expect(content).toContain("Add deploy workflow");
  });

  it("still documents the depends_on sequencing rationale", () => {
    expect(content).toContain("`depends_on`");
    expect(content).toMatch(/chicken-and-egg/i);
  });
});

describe("SKILL.md — coverage-check 3-stage lifecycle section", () => {
  it("has a new section header for the coverage-check pairing lifecycle", () => {
    expect(content).toMatch(/## Coverage-check pairing \(3-stage lifecycle\)/);
  });

  it("places the new section after the existing pairing rule and before the closing checklist", () => {
    const pairingIdx = content.indexOf(
      "## The pairing rule (Phase 4 — test-roadmap)",
    );
    const coverageIdx = content.indexOf(
      "## Coverage-check pairing (3-stage lifecycle)",
    );
    const closingIdx = content.indexOf(
      "## The closing checklist (Phase 5 — test-fix)",
    );
    expect(pairingIdx).toBeGreaterThan(-1);
    expect(coverageIdx).toBeGreaterThan(pairingIdx);
    expect(closingIdx).toBeGreaterThan(coverageIdx);
  });

  it("frames the section as an extension of, not a replacement for, the general 2-stage pattern", () => {
    const idx = content.indexOf(
      "## Coverage-check pairing (3-stage lifecycle)",
    );
    const section = content.slice(idx, idx + 2500);
    expect(section).toMatch(/extends?/i);
    expect(section).toMatch(/2-stage/);
  });

  it("documents all three stages: job lands, never-decrease required, hard-90%-required", () => {
    const idx = content.indexOf(
      "## Coverage-check pairing (3-stage lifecycle)",
    );
    const section = content.slice(idx, idx + 2500);
    expect(section).toMatch(/coverage CI job lands/i);
    expect(section).toMatch(/never-decrease/i);
    expect(section).toMatch(
      /hard-90%-required|hard.*90%.*required|hard ≥?>=?\s*90%/i,
    );
  });

  it("states the never-decrease check is required immediately, mirroring the existing pairing pattern", () => {
    const idx = content.indexOf(
      "## Coverage-check pairing (3-stage lifecycle)",
    );
    const section = content.slice(idx, idx + 2500);
    expect(section).toMatch(/immediately/i);
  });

  it("names test-roadmap as the component that auto-emits the promotion task on gap closure", () => {
    const idx = content.indexOf(
      "## Coverage-check pairing (3-stage lifecycle)",
    );
    const section = content.slice(idx, idx + 2500);
    expect(section).toContain("test-roadmap");
    expect(section).toMatch(/auto(?:matic(?:ally)?|-emit|matically emits?)/i);
  });

  it("references the coverage_gate.line_coverage_pct >= 90 detection condition", () => {
    const idx = content.indexOf(
      "## Coverage-check pairing (3-stage lifecycle)",
    );
    const section = content.slice(idx, idx + 2500);
    expect(section).toContain("line_coverage_pct");
    expect(section).toMatch(/>=\s*90|≥\s*90/);
  });

  it("states promotion happens without manual intervention", () => {
    const idx = content.indexOf(
      "## Coverage-check pairing (3-stage lifecycle)",
    );
    const section = content.slice(idx, idx + 2500);
    expect(section).toMatch(
      /no manual (step|intervention)|without manual intervention/i,
    );
  });

  it("documents the >=90%-at-onboarding skip rule directly to the hard gate", () => {
    const idx = content.indexOf(
      "## Coverage-check pairing (3-stage lifecycle)",
    );
    const section = content.slice(idx, idx + 2500);
    const mentionsSkip = /skip/i.test(section);
    const mentionsOnboarding = /onboard/i.test(section);
    const mentionsDirectlyToHardGate =
      /directly|straight/i.test(section) &&
      /hard gate|hard.*90%/i.test(section);
    expect(mentionsSkip).toBe(true);
    expect(mentionsOnboarding).toBe(true);
    expect(mentionsDirectlyToHardGate).toBe(true);
  });

  it("clarifies the never-decrease stage is unnecessary when already at or above 90%", () => {
    const idx = content.indexOf(
      "## Coverage-check pairing (3-stage lifecycle)",
    );
    const section = content.slice(idx, idx + 2500);
    expect(section).toMatch(/unnecessar(?:y|ily)/i);
  });
});

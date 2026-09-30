import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PRD_MD_PATH = join(import.meta.dir, "prd.md");

let content: string;

beforeAll(() => {
  content = readFileSync(PRD_MD_PATH, "utf-8");
});

function extractPhase0ResolutionSection(md: string): string {
  const sectionIdx = md.indexOf(
    "### Resolve the configured prd subagent (PRM-1.2)",
  );
  const step2Idx = md.indexOf("2. **Detect toolchain**");
  expect(sectionIdx).toBeGreaterThan(-1);
  expect(step2Idx).toBeGreaterThan(sectionIdx);
  return md.slice(sectionIdx, step2Idx);
}

function extractDispatchSection(md: string): string {
  const sectionIdx = md.indexOf("## Configured Methodology Dispatch (PRM-1.2)");
  const phase5Idx = md.indexOf("## Phase 5: Summary and Next Steps");
  expect(sectionIdx).toBeGreaterThan(-1);
  expect(phase5Idx).toBeGreaterThan(sectionIdx);
  return md.slice(sectionIdx, phase5Idx);
}

describe("prd.md — Phase 0 resolves the configured prd-phase subagent (PRM-1.2)", () => {
  it("places the resolution subsection after step 1 (folder creation) and before step 2 (toolchain detection)", () => {
    const step1Idx = content.indexOf("1. **Create the planning folder**");
    const resolveIdx = content.indexOf(
      "### Resolve the configured prd subagent (PRM-1.2)",
    );
    const step2Idx = content.indexOf("2. **Detect toolchain**");
    expect(step1Idx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(step1Idx);
    expect(step2Idx).toBeGreaterThan(resolveIdx);
  });

  it("fetches phaseMethodology.prd from GET /agents/{id}/config, same endpoint/auth as review.md, patch.md, and plan-session.md's own phase resolutions", () => {
    const section = extractPhase0ResolutionSection(content);
    expect(section).toContain(
      'curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY"',
    );
    expect(section).toContain(
      "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config",
    );
    expect(section).toContain(".phaseMethodology.prd");
  });

  it("PRD_SUBAGENT_TYPE defaults to empty (not a fabricated built-in name) when phaseMethodology.prd is absent or null", () => {
    const section = extractPhase0ResolutionSection(content);
    expect(section).toContain("PRD_SUBAGENT_TYPE=$(curl");
    expect(section).toContain(".phaseMethodology.prd // empty");
  });

  it("documents there is no built-in subagent_type fallback name for prd, unlike review.md's shipwright:code-reviewer", () => {
    const section = extractPhase0ResolutionSection(content);
    expect(section).toContain("no built-in `subagent_type` fallback name");
    expect(section.toLowerCase()).toContain(
      "not itself a dispatchable subagent",
    );
  });

  it("documents this lookup as fail-soft/best-effort, never a hard stop", () => {
    const section = extractPhase0ResolutionSection(content);
    const lower = section.toLowerCase();
    expect(lower).toMatch(/fail-soft/);
    expect(lower).toContain("never a hard stop");
  });

  it("states that an empty PRD_SUBAGENT_TYPE means step 2 through Phase 4 run unchanged (today's behavior)", () => {
    const section = extractPhase0ResolutionSection(content);
    expect(section.toLowerCase()).toContain("run unchanged");
    expect(section.toLowerCase()).toContain("exactly as they do today");
  });

  it("states that a non-empty PRD_SUBAGENT_TYPE still runs step 2b (repo detection) before jumping to the dispatch section", () => {
    const section = extractPhase0ResolutionSection(content);
    expect(section).toContain("step 2b");
    expect(section).toContain("Configured Methodology Dispatch (PRM-1.2)");
  });
});

describe("prd.md — no config set behaves identically to today (acceptance criterion 1)", () => {
  it("keeps the full, unmodified Phase 1 through Phase 4 built-in flow present verbatim", () => {
    expect(content).toContain("## Phase 1: Interactive Discovery");
    expect(content).toContain("## Phase 2: Research Enrichment");
    expect(content).toContain(
      "## Phase 2b: Complexity Review (PO Decision Gate)",
    );
    expect(content).toContain("## Phase 3: Draft PRODUCT-SPEC.md");
    expect(content).toContain("## Phase 4: User Review and Finalize");
    expect(content).toContain(
      "### Q1 — Session Name (skip if $ARGUMENTS is already descriptive)",
    );
    expect(content).toContain("### Q9 — Success Criteria");
  });

  it("keeps Phase 0's toolchain detection, doc reading, and research steps unchanged", () => {
    expect(content).toContain(
      "2. **Detect toolchain** by scanning the project root in this order:",
    );
    expect(content).toContain("3. **Read project documentation**");
    expect(content).toContain("4. **Research existing context**");
  });
});

describe("prd.md — Configured Methodology Dispatch section (PRM-1.2)", () => {
  it("is placed after Phase 4 and before Phase 5", () => {
    const phase4Idx = content.indexOf("## Phase 4: User Review and Finalize");
    const dispatchIdx = content.indexOf(
      "## Configured Methodology Dispatch (PRM-1.2)",
    );
    const phase5Idx = content.indexOf("## Phase 5: Summary and Next Steps");
    expect(phase4Idx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(phase4Idx);
    expect(phase5Idx).toBeGreaterThan(dispatchIdx);
  });

  it("is skipped entirely when PRD_SUBAGENT_TYPE is empty", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain(
      "Skip this entire section when `PRD_SUBAGENT_TYPE` is empty",
    );
  });

  it("documents the contract-defined inputs: session folder name and live human interaction, no pre-assembled payload", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("references/methodology-contracts/prd.md");
    expect(section).toContain("PRM-1.1");
    expect(section).toContain("$ARGUMENTS");
    expect(section.toLowerCase()).toContain("no pre-assembled");
  });

  it("dispatches via the Agent tool with subagent_type: PRD_SUBAGENT_TYPE and run_in_background: false", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("subagent_type: PRD_SUBAGENT_TYPE");
    expect(section).toContain("run_in_background: false");
  });

  it("points the dispatched subagent at the contract and the product-spec template", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("references/methodology-contracts/prd.md");
    expect(section).toContain("references/product-spec-template.md");
  });

  it("instructs the subagent to write output at planning/$ARGUMENTS/PRODUCT-SPEC.md", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("planning/$ARGUMENTS/PRODUCT-SPEC.md");
  });

  it("states this command does not relay questions/answers -- the subagent conducts its own live turn-by-turn session", () => {
    const section = extractDispatchSection(content);
    expect(section.toLowerCase()).toContain("does not relay questions");
  });
});

describe("prd.md — Structural Validation of the dispatched subagent's output (PRM-1.2)", () => {
  it("checks the file exists and is non-empty", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("### Structural Validation");
    expect(section.toLowerCase()).toContain("exists and is non-empty");
  });

  it("checks for every required top-level section heading from the contract", () => {
    const section = extractDispatchSection(content);
    for (const heading of [
      "Overview",
      "Problem Statement",
      "Users & Context",
      "Features",
      "Technical Constraints",
      "Scope",
      "Priorities & Sequence",
      "Testing Strategy",
      "Resolved Decisions",
      "Success Criteria",
    ]) {
      expect(section).toContain(heading);
    }
  });

  it("checks for no unresolved TBD markers, per the contract's quality bar", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("TBD");
  });

  it("clarifies structural validation is not a re-grading of content quality/probing depth", () => {
    const section = extractDispatchSection(content);
    expect(section.toLowerCase()).toContain(
      "not a re-grading of content quality",
    );
  });
});

describe("prd.md — Malformed or Failed Response handling falls back to the built-in flow (PRM-1.2)", () => {
  it("retries once with the same PRD_SUBAGENT_TYPE and the same prompt on dispatch failure or Structural Validation failure", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("### Malformed or Failed Response (PRM-1.2)");
    expect(section).toContain("retry once with the same `PRD_SUBAGENT_TYPE`");
  });

  it("falls back to running the built-in flow inline when the retry also fails, not to abandoning the session", () => {
    const section = extractDispatchSection(content);
    expect(section.toLowerCase()).toMatch(
      /fall back to\s+running the built-in flow inline/,
    );
  });

  it("contrasts this with plan-session.md's PSM-1.2, which abandons instead of falling back", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("plan-session.md");
    expect(section).toContain("PSM-1.2");
    expect(section.toLowerCase()).toContain("abandons");
  });

  it("prints a one-line note when the fallback fires", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("falling back to the");
    expect(section).toContain("built-in PRD flow");
  });

  it("states Phase 5 always runs against a real, structurally valid spec regardless of which path produced it", () => {
    const section = extractDispatchSection(content);
    expect(section.toLowerCase()).toMatch(
      /phase 5 always\s+runs against a real, structurally valid spec/,
    );
  });
});

describe("prd.md — Phase 5 is path-agnostic (PRM-1.2)", () => {
  it("notes Phase 5 runs identically whether the built-in flow or the configured dispatch produced the spec", () => {
    const phase5Idx = content.indexOf("## Phase 5: Summary and Next Steps");
    const printIdx = content.indexOf("Print:", phase5Idx);
    expect(phase5Idx).toBeGreaterThan(-1);
    expect(printIdx).toBeGreaterThan(phase5Idx);
    const section = content.slice(phase5Idx, printIdx);
    expect(section).toContain("PRM-1.2");
    expect(section.toLowerCase()).toContain("path-agnostic");
  });

  it("instructs deriving the summary counts from the written PRODUCT-SPEC.md on the dispatch path, since no in-session tally exists there", () => {
    const phase5Idx = content.indexOf("## Phase 5: Summary and Next Steps");
    const printIdx = content.indexOf("Print:", phase5Idx);
    const section = content.slice(phase5Idx, printIdx);
    expect(section.toLowerCase()).toContain(
      "no such tally exists in this thread",
    );
    expect(section).toContain("derive every count directly from the written");
  });
});

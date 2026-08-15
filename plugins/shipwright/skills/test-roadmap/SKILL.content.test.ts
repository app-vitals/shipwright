import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeCoverageGate } from "../../../../scripts/check-coverage-gate";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");
const TEMPLATE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "assets",
  "templates",
  "test-readiness-plan.md.tmpl",
);

let content: string;
let templateContent: string;

beforeAll(() => {
  if (existsSync(SKILL_MD_PATH)) {
    content = readFileSync(SKILL_MD_PATH, "utf-8");
  } else {
    content = "";
  }
  templateContent = existsSync(TEMPLATE_PATH)
    ? readFileSync(TEMPLATE_PATH, "utf-8")
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
  it("has frontmatter with name: test-roadmap", () => {
    expect(content).toContain("name: test-roadmap");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — E2E classification guardrail", () => {
  it("mentions the E2E classification guardrail in the Process section", () => {
    expect(content).toContain("E2E classification guardrail");
  });

  it("references test-system.md's Classifying a new test section", () => {
    expect(content).toContain("test-system.md");
    expect(content).toContain("Classifying a new test");
  });

  it("states that tasks with layer: e2e must be verified against the classification rule", () => {
    const hasE2eCheck =
      content.includes("layer: e2e") &&
      (content.includes("verify") ||
        content.includes("Verify") ||
        content.includes("check"));
    expect(hasE2eCheck).toBe(true);
  });

  it("mentions that e2e tasks must exercise a real browser", () => {
    expect(content).toContain("multi-step browser flow");
  });

  it("requires downgrading non-browser flows to integration or smoke", () => {
    const hasDowngrade =
      (content.includes("downgrade") ||
        content.includes("Downgrade") ||
        content.includes("downgraded")) &&
      (content.includes("integration") || content.includes("smoke"));
    expect(hasDowngrade).toBe(true);
  });

  it("mentions explaining the downgrade reason in a note", () => {
    const hasNote =
      content.includes("note") ||
      content.includes("Note") ||
      content.includes("explain") ||
      content.includes("Explain");
    expect(hasNote).toBe(true);
  });
});

describe("SKILL.md — Speed delta leads with the aggregate-vs-budget number", () => {
  it("has a Speed delta bullet in section 3 (The gap)", () => {
    expect(content).toMatch(/\*\*Speed delta\*\*/);
  });

  it("leads with aggregate-vs-budget rather than per-layer p95 alone", () => {
    const speedDeltaIdx = content.indexOf("**Speed delta**");
    expect(speedDeltaIdx).toBeGreaterThan(-1);
    const bulletEnd = content.indexOf("\n", speedDeltaIdx + 400);
    const bullet = content.slice(
      speedDeltaIdx,
      bulletEnd === -1 ? content.length : bulletEnd,
    );
    expect(bullet).toMatch(/aggregate/i);
    expect(bullet).toMatch(/budget/i);
  });

  it("includes per-layer p95 only when Tier 2 was actually triggered", () => {
    const speedDeltaIdx = content.indexOf("**Speed delta**");
    const bulletEnd = content.indexOf("\n\n", speedDeltaIdx);
    const bullet = content.slice(
      speedDeltaIdx,
      bulletEnd === -1 ? content.length : bulletEnd,
    );
    expect(bullet).toMatch(/Tier 2|Tier-2/);
    expect(bullet).toMatch(/triggered/i);
  });
});

describe("SKILL.md — Mandatory M1 task rescoped to the Tier-1-breach gate", () => {
  it("has a Mandatory M1 task bullet about carried-forward measurement-only items", () => {
    const hasBullet =
      /Mandatory M1 task/i.test(content) &&
      /carried forward/i.test(content) &&
      /measurement-only/i.test(content);
    expect(hasBullet).toBe(true);
  });

  it("gates the mandatory M1 escalation on an actual Tier-1 budget breach via speed-budgets' escalation formula", () => {
    const bulletIdx = content.indexOf(
      "Mandatory M1 task — carried-forward measurement-only items",
    );
    expect(bulletIdx).toBeGreaterThan(-1);
    const section = content.slice(bulletIdx, bulletIdx + 800);
    expect(section).toMatch(/Tier[\s-]?1/i);
    expect(section).toMatch(/budget breach/i);
    expect(section).toContain("speed-budgets");
    expect(section).toMatch(/escalation formula/i);
  });

  it("does not gate mandatory M1 escalation on a bare 3-or-more-cycles count", () => {
    const bulletIdx = content.indexOf(
      "Mandatory M1 task — carried-forward measurement-only items",
    );
    const section = content.slice(bulletIdx, bulletIdx + 800);
    const hasBareCycleCountGate =
      /\b3\b[^.]*consecutive|\bconsecutive\b[^.]*\b3\b/i.test(section);
    expect(hasBareCycleCountGate).toBe(false);
  });
});

describe("SKILL.md — Output structure mentions the Coverage Gate block", () => {
  it("describes a Coverage Gate block ahead of the six numbered sections", () => {
    const outputIdx = content.indexOf("## Output structure");
    expect(outputIdx).toBeGreaterThan(-1);
    const section = content.slice(outputIdx, outputIdx + 700);
    expect(section).toContain("## Coverage Gate");
    expect(section).toContain("check-coverage-gate.ts");
  });
});

describe("SKILL.md — coverage_gate Process step invokes the CLI script", () => {
  function coverageGateStepSection(): string {
    const idx = content.indexOf(
      "Compute the coverage_gate block by invoking",
    );
    const nextStepIdx = content.indexOf(
      '9. Load `${CLAUDE_PLUGIN_ROOT}/assets/templates/test-readiness-plan.md.tmpl`',
    );
    expect(idx).toBeGreaterThan(-1);
    expect(nextStepIdx).toBeGreaterThan(idx);
    return content.slice(idx, nextStepIdx);
  }

  it("has a numbered Process step invoking scripts/check-coverage-gate.ts", () => {
    const section = coverageGateStepSection();
    expect(section).toContain("scripts/check-coverage-gate.ts");
  });

  it("states the script computes verdict itself — the agent does not hand-compute it", () => {
    const section = coverageGateStepSection();
    expect(section).toMatch(/never\s+hand-compute the verdict/i);
    expect(section).toMatch(/does not compose\s+"READY"\/"BLOCKED"/i);
  });

  it("mirrors test-migration Step 4c's sourcing mechanism for featurePct/linePct", () => {
    const section = coverageGateStepSection();
    expect(section).toContain("Step 4c");
    expect(section).toContain("test-migration/SKILL.md");
    expect(section).toMatch(/mirrors that step's\s+mechanism exactly/i);
  });

  it("sources linePct from the most recent green CI run's Test step Lines: line", () => {
    const section = coverageGateStepSection();
    expect(section).toContain("linePct");
    expect(section).toMatch(/`Test` step/);
    expect(section).toContain("Lines:");
  });

  it("sources featurePct from test-inventory.md's feature_coverage_pct", () => {
    const section = coverageGateStepSection();
    expect(section).toContain("featurePct");
    expect(section).toContain("feature_coverage_pct");
    expect(section).toContain("test-inventory.md");
  });

  it("states never to guess a missing coverage input", () => {
    const section = coverageGateStepSection();
    expect(section).toMatch(/never guess/i);
  });

  it("documents rendering the verdict verbatim, not paraphrased", () => {
    const section = coverageGateStepSection();
    expect(section).toMatch(/verbatim/i);
    expect(section).toMatch(/do not paraphrase/i);
  });
});

describe("SKILL.md — refuses to write test-readiness-plan.md on script failure", () => {
  function coverageGateStepSection(): string {
    const idx = content.indexOf(
      "Compute the coverage_gate block by invoking",
    );
    const nextStepIdx = content.indexOf(
      '9. Load `${CLAUDE_PLUGIN_ROOT}/assets/templates/test-readiness-plan.md.tmpl`',
    );
    expect(idx).toBeGreaterThan(-1);
    expect(nextStepIdx).toBeGreaterThan(idx);
    return content.slice(idx, nextStepIdx);
  }

  it("has an explicit abort instruction naming test-readiness-plan.md", () => {
    const section = coverageGateStepSection();
    expect(section).toMatch(/Abort if the script call fails/i);
    expect(section).toContain("test-readiness-plan.md");
  });

  it("covers a nonzero exit code as a failure trigger", () => {
    const section = coverageGateStepSection();
    expect(section).toMatch(/exits nonzero/i);
  });

  it("covers malformed / non-JSON stdout as a failure trigger", () => {
    const section = coverageGateStepSection();
    expect(section).toMatch(/not valid JSON/i);
  });

  it("covers a missing/inconsistent field as a failure trigger", () => {
    const section = coverageGateStepSection();
    expect(section).toMatch(/missing\/null/i);
    expect(section).toMatch(/inconsistent/i);
  });

  it("mirrors the existing 'Abort if any missing' failure-mode language used elsewhere in the pipeline", () => {
    const section = coverageGateStepSection();
    expect(section).toMatch(/mirrors\s+Process step 1's\s+"Abort if any missing"/i);
  });
});

describe("SKILL.md — template placeholders wired from the script output", () => {
  it("lists all seven Coverage Gate placeholders in the render step", () => {
    const renderIdx = content.indexOf(
      "Load `${CLAUDE_PLUGIN_ROOT}/assets/templates/test-readiness-plan.md.tmpl`",
    );
    expect(renderIdx).toBeGreaterThan(-1);
    const section = content.slice(renderIdx, renderIdx + 800);
    for (const placeholder of [
      "{{FEATURE_COVERAGE_PCT}}",
      "{{FEATURE_COVERAGE_SOURCE}}",
      "{{LINE_COVERAGE_PCT}}",
      "{{LINE_COVERAGE_SOURCE}}",
      "{{COVERAGE_VERDICT}}",
      "{{FEATURE_TARGET}}",
      "{{LINE_TARGET}}",
    ]) {
      expect(section).toContain(placeholder);
    }
  });
});

describe("SKILL.md — feature-coverage gaps sequenced ahead of line-coverage filler", () => {
  function step5Section(): string {
    const idx = content.indexOf(
      "5. Generate the task list by walking the migration buckets",
    );
    const nextStepIdx = content.indexOf(
      "6. **Apply the pairing rule**",
    );
    expect(idx).toBeGreaterThan(-1);
    expect(nextStepIdx).toBeGreaterThan(idx);
    return content.slice(idx, nextStepIdx);
  }

  it("states that within a milestone, feature-coverage-closing tasks are sequenced ahead of line-coverage filler tasks", () => {
    const section = step5Section();
    expect(section).toMatch(/feature-coverage/i);
    expect(section).toMatch(/ahead of/i);
    expect(section).toMatch(/line-coverage/i);
    expect(section).toMatch(/filler/i);
  });

  it("scopes the sequencing rule to when both gap types coexist in the same milestone", () => {
    const section = step5Section();
    expect(section).toMatch(/same milestone/i);
    expect(section).toMatch(/both/i);
  });

  it("reinforces the sequencing rule in Failure modes to avoid", () => {
    const failureModesIdx = content.indexOf("## Failure modes to avoid");
    expect(failureModesIdx).toBeGreaterThan(-1);
    const section = content.slice(failureModesIdx);
    expect(section).toMatch(/line-coverage filler task ahead of a feature-coverage-closing task/i);
  });
});

describe("test-readiness-plan.md.tmpl — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(templateContent.length).toBeGreaterThan(200);
  });
});

describe("test-readiness-plan.md.tmpl — Coverage Gate section", () => {
  it("has a Coverage Gate section header before section 1", () => {
    const headerIdx = templateContent.indexOf("## Coverage Gate");
    const section1Idx = templateContent.indexOf("## 1. Where we are now");
    expect(headerIdx).toBeGreaterThan(-1);
    expect(section1Idx).toBeGreaterThan(-1);
    expect(headerIdx).toBeLessThan(section1Idx);
  });

  it("has placeholders for all six coverage_gate fields plus both targets", () => {
    for (const placeholder of [
      "{{FEATURE_COVERAGE_PCT}}",
      "{{FEATURE_COVERAGE_SOURCE}}",
      "{{LINE_COVERAGE_PCT}}",
      "{{LINE_COVERAGE_SOURCE}}",
      "{{COVERAGE_VERDICT}}",
      "{{FEATURE_TARGET}}",
      "{{LINE_TARGET}}",
    ]) {
      expect(templateContent).toContain(placeholder);
    }
  });

  it("references check-coverage-gate.ts as the source of the rendered verdict", () => {
    const headerIdx = templateContent.indexOf("## Coverage Gate");
    const section = templateContent.slice(headerIdx, headerIdx + 600);
    expect(section).toContain("check-coverage-gate.ts");
  });
});

describe("test-readiness-plan.md.tmpl — template substitution fixture (CGT-1.2 output wiring)", () => {
  it("fills all seven Coverage Gate placeholders from a sample computeCoverageGate() output", () => {
    const gate = computeCoverageGate({
      featurePct: 92,
      featureSource: "docs/test-readiness/test-inventory.md",
      linePct: 95,
      lineSource: "CI run https://example.invalid/run/1 @ abc1234",
    });

    const headerIdx = templateContent.indexOf("## Coverage Gate");
    const section1Idx = templateContent.indexOf("## 1. Where we are now");
    const coverageGateBlock = templateContent.slice(headerIdx, section1Idx);

    const filled = coverageGateBlock
      .replaceAll("{{FEATURE_COVERAGE_PCT}}", String(gate.feature_coverage_pct))
      .replaceAll(
        "{{FEATURE_COVERAGE_SOURCE}}",
        gate.feature_coverage_source,
      )
      .replaceAll("{{LINE_COVERAGE_PCT}}", String(gate.line_coverage_pct))
      .replaceAll("{{LINE_COVERAGE_SOURCE}}", gate.line_coverage_source)
      .replaceAll("{{COVERAGE_VERDICT}}", gate.verdict)
      .replaceAll("{{FEATURE_TARGET}}", String(gate.targets.feature))
      .replaceAll("{{LINE_TARGET}}", String(gate.targets.line));

    expect(filled).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(filled).toContain("92% (target 90%)");
    expect(filled).toContain("95% (target 90%)");
    expect(filled).toContain("docs/test-readiness/test-inventory.md");
    expect(filled).toContain("CI run https://example.invalid/run/1 @ abc1234");
    expect(filled).toContain("READY");
  });

  it("renders a BLOCKED verdict verbatim (not paraphrased) when a gate fails", () => {
    const gate = computeCoverageGate({
      featurePct: 70,
      featureSource: "docs/test-readiness/test-inventory.md",
      linePct: 95,
      lineSource: "CI run https://example.invalid/run/2 @ def5678",
    });

    const headerIdx = templateContent.indexOf("## Coverage Gate");
    const section1Idx = templateContent.indexOf("## 1. Where we are now");
    const coverageGateBlock = templateContent.slice(headerIdx, section1Idx);

    const filled = coverageGateBlock.replaceAll(
      "{{COVERAGE_VERDICT}}",
      gate.verdict,
    );

    expect(gate.verdict).toContain("BLOCKED");
    expect(filled).toContain(gate.verdict);
  });
});

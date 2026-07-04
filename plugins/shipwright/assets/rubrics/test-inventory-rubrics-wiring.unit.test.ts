/**
 * test-inventory rubrics wiring tests — PRN-2.4
 *
 * Verifies code-classifier.md and layer-criteria.md each reference the shared
 * references/principles.md file as the source of truth for test-layer
 * definitions (testing-domain entries) and the two data_layer_* architecture
 * entries — net-new wiring so the test-inventory rubrics stop duplicating
 * layer definitions inline and instead point at principles.md.
 *
 * Also verifies test-inventory/SKILL.md documents the convention that a
 * target repo's CLAUDE.md should declare its own concrete layer structure,
 * mirroring the existing "## Testing" section pattern that feeds
 * testReadinessContext into code-reviewer.md, kept accurate via the existing
 * docs-refresher/research-docs mechanism.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file
 * reads (mirrors principles-content.unit.test.ts / principles-wiring.unit.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/assets/rubrics/ → plugins/shipwright/
const pluginRoot = resolve(import.meta.dir, "..", "..");

function pluginPath(...parts: string[]): string {
  return join(pluginRoot, ...parts);
}

const codeClassifierPath = pluginPath("assets", "rubrics", "code-classifier.md");
const layerCriteriaPath = pluginPath("assets", "rubrics", "layer-criteria.md");
const testInventorySkillPath = pluginPath("skills", "test-inventory", "SKILL.md");

function readCodeClassifier(): string {
  return readFileSync(codeClassifierPath, "utf8");
}

function readLayerCriteria(): string {
  return readFileSync(layerCriteriaPath, "utf8");
}

function readTestInventorySkill(): string {
  return readFileSync(testInventorySkillPath, "utf8");
}

describe("test-inventory rubrics wiring — files exist", () => {
  it("assets/rubrics/code-classifier.md exists", () => {
    expect(existsSync(codeClassifierPath)).toBe(true);
  });

  it("assets/rubrics/layer-criteria.md exists", () => {
    expect(existsSync(layerCriteriaPath)).toBe(true);
  });

  it("skills/test-inventory/SKILL.md exists", () => {
    expect(existsSync(testInventorySkillPath)).toBe(true);
  });
});

describe("code-classifier.md — references principles.md", () => {
  it("mentions references/principles.md", () => {
    expect(readCodeClassifier()).toContain("references/principles.md");
  });
});

describe("layer-criteria.md — references principles.md", () => {
  it("mentions references/principles.md", () => {
    expect(readLayerCriteria()).toContain("references/principles.md");
  });

  it("references principles.md near the four-layer definitions (## The four layers)", () => {
    const content = readLayerCriteria();
    const stepIndex = content.indexOf("## The four layers");
    const nextStepIndex = content.indexOf("## The canonical-layer rule");
    expect(stepIndex).toBeGreaterThan(-1);
    expect(nextStepIndex).toBeGreaterThan(stepIndex);
    const section = content.slice(stepIndex, nextStepIndex);
    expect(section).toContain("references/principles.md");
  });
});

describe("test-inventory/SKILL.md — documents the CLAUDE.md layer-declaration convention", () => {
  it("mentions CLAUDE.md and layer structure together", () => {
    const content = readTestInventorySkill();
    expect(content).toContain("CLAUDE.md");
    expect(content.toLowerCase()).toContain("layer structure");
  });

  it("documents that the convention is kept accurate via the docs-refresher/research-docs mechanism", () => {
    const content = readTestInventorySkill();
    expect(content).toContain("docs-refresher");
  });
});

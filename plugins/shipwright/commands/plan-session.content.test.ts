import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLAN_SESSION_MD_PATH = join(import.meta.dir, "plan-session.md");

let content: string;

beforeAll(() => {
  content = readFileSync(PLAN_SESSION_MD_PATH, "utf-8");
});

function extractStep5_5Section(md: string): string {
  const match = md.match(/## Step 5\.5: HITL Detection[\s\S]*?(?=\n## Step 6: Write to Queue)/);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function extractStep6bSection(md: string): string {
  const match = md.match(/\*\*Step 6b — Write tasks to the store:\*\*[\s\S]*$/);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("plan-session.md — Step 5.5 is a 2-way HITL classification (RHA-1.2)", () => {
  it("explicitly names the Type A classification", () => {
    const section = extractStep5_5Section(content);
    expect(section).toContain("Type A");
  });

  it("defines Type A as no real code/acceptance-criteria diff, human executes commands directly", () => {
    const section = extractStep5_5Section(content);
    const typeAIdx = section.indexOf("Type A");
    expect(typeAIdx).toBeGreaterThan(-1);
    const typeASection = section.slice(typeAIdx);
    const lower = typeASection.toLowerCase();
    expect(lower).toContain("no real code");
    expect(lower).toMatch(/acceptance.criteria diff/);
    expect(lower).toContain("human executes");
  });

  it("Type A sets hitl:true and injects a Human steps section", () => {
    const section = extractStep5_5Section(content);
    expect(section).toContain("hitl: true");
    expect(section).toContain("## Human steps");
  });

  it("documents the neither case as unchanged: hitl:false, no special handling", () => {
    const section = extractStep5_5Section(content);
    const lower = section.toLowerCase();
    expect(lower).toContain("neither");
    expect(section).toContain("hitl: false");
  });

  it("How to Flag a Matched Task section covers Type A flagging instructions", () => {
    const section = extractStep5_5Section(content);
    const howToFlagIdx = section.indexOf("### How to Flag a Matched Task");
    expect(howToFlagIdx).toBeGreaterThan(-1);
    const howToFlagSection = section.slice(howToFlagIdx);
    expect(howToFlagSection).toContain("Type A");
    expect(howToFlagSection).toContain("hitl: true");
  });

  it("keeps the existing Keyword Heuristics and Judgment Step subsections as Type A's detection mechanism", () => {
    const section = extractStep5_5Section(content);
    expect(section).toContain("### Keyword Heuristics");
    expect(section).toContain("### Judgment Step");
    const keywordIdx = section.indexOf("### Keyword Heuristics");
    const judgmentIdx = section.indexOf("### Judgment Step");
    expect(judgmentIdx).toBeGreaterThan(keywordIdx);
  });

  it("removes all Type B / requiresHumanApproval / Approval-marker language from Step 5.5", () => {
    const section = extractStep5_5Section(content);
    expect(section).not.toContain("Type B");
    expect(section).not.toContain("requiresHumanApproval");
    expect(section).not.toContain("⚠ Approval");
  });
});

describe("plan-session.md — task table legend no longer references Approval / requiresHumanApproval (RHA-1.2)", () => {
  it("the HITL column legend documents ⚠ HITL for Type A only, not ⚠ Approval", () => {
    const hitlLegendMatch = content.match(/\*\*HITL\*\*:[\s\S]*?see Step 5\.5[\s\S]*?omit otherwise/);
    expect(hitlLegendMatch).not.toBeNull();
    const legend = hitlLegendMatch?.[0] ?? "";
    expect(legend).toContain("⚠ HITL");
    expect(legend).toContain("Type A");
    expect(legend).not.toContain("⚠ Approval");
    expect(legend).not.toContain("Type B");
  });
});

describe("plan-session.md — Step 6b template omits requiresHumanApproval (RHA-1.2)", () => {
  it("the JSON task template code block includes hitl but not requiresHumanApproval", () => {
    const section = extractStep6bSection(content);
    const codeBlockMatch = section.match(/```json[\s\S]*?```/);
    expect(codeBlockMatch).not.toBeNull();
    const codeBlock = codeBlockMatch?.[0] ?? "";
    expect(codeBlock).toContain('"hitl": false');
    expect(codeBlock).not.toContain("requiresHumanApproval");
  });

  it("prose still instructs setting hitl:true for Type A tasks, with no requiresHumanApproval / Type B instruction", () => {
    const section = extractStep6bSection(content);
    expect(section).toContain('Set `"hitl": true`');
    expect(section).toContain("Step 5.5");
    expect(section).not.toContain("requiresHumanApproval");
    expect(section).not.toContain("Type B");
  });
});

describe("plan-session.md — repo auto-detect preserves org/repo format (PRF-1.1)", () => {
  function extractArgsAndAutoDetectSection(md: string): string {
    const match = md.match(/^---[\s\S]*?Wait for user confirmation before continuing to Step 1\./);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  it("the repo arg description example is org/repo format, not a bare repo name", () => {
    const section = extractArgsAndAutoDetectSection(content);
    const argDescMatch = section.match(/- name: repo\n\s*description: (.+)/);
    expect(argDescMatch).not.toBeNull();
    const argDesc = argDescMatch?.[1] ?? "";
    expect(argDesc).toMatch(/e\.g\.,\s*[\w.-]+\/[\w.-]+/);
    expect(argDesc).not.toMatch(/e\.g\.,\s*shipwright\)/);
  });

  it("does not instruct stripping to the bare repo name in auto-detect", () => {
    const section = extractArgsAndAutoDetectSection(content);
    expect(section.toLowerCase()).not.toContain("bare repo name");
  });

  it("documents preserving the full owner/repo value from git remote parsing", () => {
    const section = extractArgsAndAutoDetectSection(content);
    const lower = section.toLowerCase();
    expect(lower).toMatch(/preserve|do not strip|full owner\/repo/);
  });

  it("derives a repo-slug value for local path use", () => {
    const section = extractArgsAndAutoDetectSection(content);
    expect(section).toContain("repo-slug");
  });

  it("uses {repo-slug} for local filesystem paths, not {repo}", () => {
    const section = extractArgsAndAutoDetectSection(content);
    expect(section).toContain("${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo-slug}");
    expect(section).not.toContain("~/src/{repo}/");
  });

  it("Step 1's CLAUDE.md fallback read path uses {repo-slug}", () => {
    expect(content).toContain(
      "otherwise read from `${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo-slug}/`",
    );
  });

  it("Step 6b task JSON template still writes the full org/repo value into repo", () => {
    const section = extractStep6bSection(content);
    const codeBlockMatch = section.match(/```json[\s\S]*?```/);
    expect(codeBlockMatch).not.toBeNull();
    const codeBlock = codeBlockMatch?.[0] ?? "";
    expect(codeBlock).toContain('"repo": "{repo}"');
  });
});

describe("plan-session.md — Step 5 principles override check + security domain (PCO-1.1)", () => {
  function extractStep5Section(md: string): string {
    const match = md.match(/## Step 5: Task Breakdown[\s\S]*?(?=\n### Complexity and Model Scoring)/);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  it("Step 5 preamble checks .claude/shipwright/principles.md before falling back", () => {
    const section = extractStep5Section(content);
    expect(section).toContain(".claude/shipwright/principles.md");
  });

  it("Step 5 preamble mentions fallback to references/principles.md", () => {
    const section = extractStep5Section(content);
    expect(section).toContain("references/principles.md");
  });

  it("Step 5 preamble describes checking/loading project override before falling back", () => {
    const section = extractStep5Section(content);
    const lower = section.toLowerCase();
    expect(lower).toMatch(/check.*project|project.*override|override.*check/);
  });

  it("Step 5 preamble cites security as one of the domains alongside architecture and testing", () => {
    const section = extractStep5Section(content);
    expect(section).toContain("security");
    expect(section).toContain("architecture");
    expect(section).toContain("testing");
  });
});

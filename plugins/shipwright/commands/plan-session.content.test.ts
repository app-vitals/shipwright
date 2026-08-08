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

describe("plan-session.md — Step 5.5 introduces 3-way HITL classification (HSR-2.2)", () => {
  it("explicitly names Type A and Type B classifications", () => {
    const section = extractStep5_5Section(content);
    expect(section).toContain("Type A");
    expect(section).toContain("Type B");
  });

  it("defines Type A as no real code/acceptance-criteria diff, human executes commands directly", () => {
    const section = extractStep5_5Section(content);
    const typeAIdx = section.indexOf("Type A");
    const typeBIdx = section.indexOf("Type B");
    expect(typeAIdx).toBeGreaterThan(-1);
    expect(typeBIdx).toBeGreaterThan(typeAIdx);
    const typeASection = section.slice(typeAIdx, typeBIdx);
    const lower = typeASection.toLowerCase();
    expect(lower).toContain("no real code");
    expect(lower).toMatch(/acceptance.criteria diff/);
    expect(lower).toContain("human executes");
  });

  it("defines Type B as real code + acceptance criteria, but the human step is review/approve before merge", () => {
    const section = extractStep5_5Section(content);
    const typeBIdx = section.indexOf("Type B");
    expect(typeBIdx).toBeGreaterThan(-1);
    const typeBSection = section.slice(typeBIdx);
    const lower = typeBSection.toLowerCase();
    expect(lower).toContain("real code");
    expect(lower).toContain("acceptance criteria");
    expect(lower).toContain("review");
    expect(lower).toContain("approve");
    expect(lower).toContain("before merge");
  });

  it("Type A behavior is unchanged: still hitl:true plus Human steps injection", () => {
    const section = extractStep5_5Section(content);
    const typeAIdx = section.indexOf("Type A");
    const typeBIdx = section.indexOf("Type B");
    const typeASection = section.slice(typeAIdx, typeBIdx);
    expect(typeASection).toContain("hitl: true");
    expect(typeASection).toContain("## Human steps");
    expect(typeASection.toLowerCase()).toContain("unchanged");
  });

  it("Type B sets requiresHumanApproval:true instead of hitl:true, and does NOT inject Human steps as a task replacement", () => {
    const section = extractStep5_5Section(content);
    const howToFlagIdx = section.indexOf("### How to Flag a Matched Task");
    const typeBIdx = section.indexOf("Type B", howToFlagIdx);
    const typeBSection = section.slice(typeBIdx);
    expect(typeBSection).toContain("requiresHumanApproval: true");
    // Type B's instructions explicitly call out *not* setting hitl:true — the negative
    // instruction itself is expected to name the field, so assert on the "do not set hitl"
    // phrasing rather than a bare absence of the substring.
    expect(typeBSection).toMatch(/do\s+\*\*not\*\*\s+set\s+`hitl: true`|do not set hitl: true/);
    const lower = typeBSection.toLowerCase();
    expect(lower).toContain("do not");
    expect(lower).toContain("## human steps".toLowerCase());
  });

  it("Type B tasks still ship through dev-task normally, not replaced by manual execution", () => {
    const section = extractStep5_5Section(content);
    const typeBIdx = section.indexOf("Type B");
    const typeBSection = section.slice(typeBIdx);
    const lower = typeBSection.toLowerCase();
    expect(lower).toContain("dev-task");
    expect(lower).toMatch(/ships? (through|via) dev-task normally|still ships? through dev-task/);
  });

  it("documents Type B tasks are NOT excluded from the dev-task ready set, since ready.ts never reads requiresHumanApproval", () => {
    const section = extractStep5_5Section(content);
    const typeBIdx = section.indexOf("Type B");
    const typeBSection = section.slice(typeBIdx);
    expect(typeBSection).toContain("ready.ts");
    expect(typeBSection).toContain("requiresHumanApproval");
    const lower = typeBSection.toLowerCase();
    const hasReadySetLanguage =
      lower.includes("ready set") || lower.includes("ready-filter") || lower.includes("dispatchable");
    expect(hasReadySetLanguage).toBe(true);
  });

  it("documents the neither case ('Type C') as unchanged: hitl:false, no special handling", () => {
    const section = extractStep5_5Section(content);
    const lower = section.toLowerCase();
    expect(lower).toContain("neither");
    expect(section).toContain("hitl: false");
  });

  it("How to Flag a Matched Task section covers both Type A and Type B flagging instructions distinctly", () => {
    const section = extractStep5_5Section(content);
    const howToFlagIdx = section.indexOf("### How to Flag a Matched Task");
    expect(howToFlagIdx).toBeGreaterThan(-1);
    const howToFlagSection = section.slice(howToFlagIdx);
    expect(howToFlagSection).toContain("Type A");
    expect(howToFlagSection).toContain("Type B");
    expect(howToFlagSection).toContain("hitl: true");
    expect(howToFlagSection).toContain("requiresHumanApproval: true");
  });

  it("keeps the existing Keyword Heuristics and Judgment Step subsections as Type A's detection mechanism", () => {
    const section = extractStep5_5Section(content);
    expect(section).toContain("### Keyword Heuristics");
    expect(section).toContain("### Judgment Step");
    const keywordIdx = section.indexOf("### Keyword Heuristics");
    const judgmentIdx = section.indexOf("### Judgment Step");
    expect(judgmentIdx).toBeGreaterThan(keywordIdx);
  });
});

describe("plan-session.md — Step 6b template includes requiresHumanApproval (HSR-2.2)", () => {
  it("the JSON task template code block includes a requiresHumanApproval field alongside hitl", () => {
    const section = extractStep6bSection(content);
    const codeBlockMatch = section.match(/```json[\s\S]*?```/);
    expect(codeBlockMatch).not.toBeNull();
    const codeBlock = codeBlockMatch?.[0] ?? "";
    expect(codeBlock).toContain('"hitl": false');
    expect(codeBlock).toContain('"requiresHumanApproval": false');
  });

  it("prose instructs setting requiresHumanApproval:true for Type B tasks, parallel to the hitl:true instruction for Type A", () => {
    const section = extractStep6bSection(content);
    expect(section).toContain('Set `"hitl": true`');
    expect(section).toContain("Step 5.5");
    expect(section).toContain('Set `"requiresHumanApproval": true`');
    expect(section).toContain("Type B");
  });

  it("the requiresHumanApproval instruction clarifies Human steps is not injected for Type B (unlike Type A)", () => {
    const section = extractStep6bSection(content);
    const reqIdx = section.indexOf('Set `"requiresHumanApproval": true`');
    expect(reqIdx).toBeGreaterThan(-1);
    const nearby = section.slice(reqIdx, reqIdx + 400);
    const lower = nearby.toLowerCase();
    expect(lower).toContain("not");
    expect(lower).toContain("human steps");
  });
});

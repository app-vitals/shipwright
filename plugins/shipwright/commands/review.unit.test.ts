import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REVIEW_MD_PATH = join(import.meta.dir, "review.md");

let content: string;

beforeAll(() => {
  content = readFileSync(REVIEW_MD_PATH, "utf-8");
});

describe("review.md — TRR-1.2 test-readiness context", () => {
  it("Step 5.7 references test-system.md as the source for test-readiness context (AC1)", () => {
    // The gather step must name the file it reads for test-readiness context
    const hasTestSystemMd = content.includes("test-system.md");
    expect(hasTestSystemMd).toBe(true);
  });

  it("Step 6 mentions 'Testing changes' classification", () => {
    // Step 6 classify-changes step must include a Testing changes bullet
    const hasTestingChanges = content.includes("Testing changes");
    expect(hasTestingChanges).toBe(true);
  });

  it("Step 7 mentions testReadinessContext as a field passed to the subagent", () => {
    // Step 7 subagent dispatch must reference testReadinessContext as a named field
    const hasTestReadinessContext = content.includes("testReadinessContext");
    expect(hasTestReadinessContext).toBe(true);
  });
});

describe("review.md — CPF-2.2 verdict phrase requirement", () => {
  let step10Section: string;

  beforeAll(() => {
    const startIdx = content.indexOf("## Step 10: Build Review JSON");
    const endIdx = content.indexOf("## Step 11: Post or Stage");
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    step10Section = content.slice(startIdx, endIdx);
  });

  it("Step 10 requires the literal phrase 'Verdict: APPROVE' in the posted body", () => {
    expect(step10Section.includes("Verdict: APPROVE")).toBe(true);
  });

  it("Step 10 requires the literal phrase 'Verdict: COMMENT' in the posted body", () => {
    expect(step10Section.includes("Verdict: COMMENT")).toBe(true);
  });

  it("Step 10 ties the phrase requirement to check-patch.ts's isSelfCleanApprove matching", () => {
    expect(step10Section.includes("isSelfCleanApprove")).toBe(true);
    expect(step10Section.includes("check-patch.ts")).toBe(true);
  });

  it("Step 10's JSON template models the required phrase in the body placeholder", () => {
    // The body field example itself should demonstrate the literal phrase,
    // not just describe the requirement in prose.
    const jsonBlockMatch = step10Section.match(/```json([\s\S]*?)```/);
    expect(jsonBlockMatch).not.toBeNull();
    const jsonBlock = jsonBlockMatch?.[1] ?? "";
    expect(
      jsonBlock.includes("Verdict: APPROVE") ||
        jsonBlock.includes("Verdict: COMMENT"),
    ).toBe(true);
  });

  it("the Slack message template's Verdict line renders literal 'Verdict: APPROVE' / 'Verdict: COMMENT' text", () => {
    const slackVerdictLine = content.includes("*Verdict:* {APPROVE|COMMENT}");
    expect(slackVerdictLine).toBe(true);
  });
});

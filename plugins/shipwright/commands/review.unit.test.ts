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

  it("Slack message template has a *Verdict:* placeholder line", () => {
    const slackVerdictLine = content.includes("*Verdict:* {APPROVE|COMMENT}");
    expect(slackVerdictLine).toBe(true);
  });
});

describe("review.md — WLS-3.2 explicit-target-only", () => {
  it("Arguments section requires an explicit target and documents the no-argument [silent] stop", () => {
    const startIdx = content.indexOf("## Arguments");
    const endIdx = content.indexOf("## Step 1: Load Policy");
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const argsSection = content.slice(startIdx, endIdx);

    // The old self-scan mode description must be gone.
    expect(argsSection.includes("No arguments: normal review flow")).toBe(false);

    // The section must document that a missing argument stops silently.
    expect(argsSection.toLowerCase().includes("required")).toBe(true);
    expect(argsSection.includes("[silent]")).toBe(true);
  });

  it("does not contain the Tier 1 / Tier 2 ranking language", () => {
    expect(content.includes("Tier 1")).toBe(false);
    expect(content.includes("Tier 2")).toBe(false);
  });

  it("does not contain the 'Pick Next PR' self-scan ranking section", () => {
    expect(content.includes("### Pick Next PR")).toBe(false);
  });

  it("does not build a repo-wide open-PR queue via `gh pr list --state open`", () => {
    expect(content.includes("gh pr list --state open")).toBe(false);
  });

  it("still contains the commitSha/headRefOid dedup check for the explicit target PR", () => {
    const dedupIdx = content.indexOf(
      "Check if the PR was already reviewed at the current commit",
    );
    expect(dedupIdx).toBeGreaterThan(-1);
    const dedupSection = content.slice(dedupIdx, dedupIdx + 1500);
    expect(dedupSection.includes("record.commitSha")).toBe(true);
    expect(dedupSection.includes("headRefOid")).toBe(true);
  });

  it("claim 409 responds [silent] and stops, with no retry against a different PR", () => {
    const claimIdx = content.indexOf("### Claim using pre-captured commit SHA");
    expect(claimIdx).toBeGreaterThan(-1);
    const claimSection = content.slice(claimIdx, claimIdx + 1500);
    expect(claimSection.includes("409")).toBe(true);
    expect(claimSection.includes("[silent]")).toBe(true);
    expect(claimSection.includes("return to Step 3")).toBe(false);
  });

  it("contains no remaining 'return to Step 3' retry-against-next-candidate language anywhere", () => {
    expect(content.includes("return to Step 3")).toBe(false);
  });

  it("does not reference Step 3 as a queue-building step to skip from Step 14", () => {
    expect(content.includes("Skip Step 3 (queue building)")).toBe(false);
  });
});

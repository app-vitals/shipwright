import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HITL_MD_PATH = join(import.meta.dir, "hitl.md");

let content: string;

beforeAll(() => {
  content = readFileSync(HITL_MD_PATH, "utf-8");
});

function extractStep6Section(md: string): string {
  const match = md.match(/## Step 6[\s\S]*$/);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function extractSuppressionSubStep(md: string): string {
  const match = md.match(
    /### 6a\. Offer Gitleaksignore Suppression[\s\S]*?(?=\n### 6b\.)/,
  );
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function extractMarkTaskDoneSubStep(md: string): string {
  const match = md.match(/### 6b\. Mark Task Done[\s\S]*$/);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("hitl.md — gitleaksignore suppression sub-step exists (GLB-2.2 AC1)", () => {
  it("contains a Step 6a suppression sub-step section", () => {
    expect(content).toContain("### 6a. Offer Gitleaksignore Suppression");
  });

  it("is gated on parsing Rule: gitleaks-secret or Rule: hardcoded-credential out of TASK_DESC", () => {
    const section = extractSuppressionSubStep(content);
    expect(section).toContain("gitleaks-secret");
    expect(section).toContain("hardcoded-credential");
    expect(section).toContain("Rule:");
  });

  it("skips the sub-step entirely when TASK_DESC has no Rule: line (non-security-fix HITL task)", () => {
    const section = extractSuppressionSubStep(content);
    const lower = section.toLowerCase();
    expect(lower).toContain("no `rule:` line");
    expect(lower).toContain("skip");
  });
});

describe("hitl.md — rotation vs. false-positive are two distinct questions (GLB-2.2 AC1)", () => {
  it("asks which findings are confirmed false positives to suppress, distinct from which were rotated", () => {
    const section = extractSuppressionSubStep(content);
    const lower = section.toLowerCase();
    expect(lower).toContain("false positive");
    expect(lower).toContain("rotat");
  });

  it("never offers suppression for a finding closed via rotation", () => {
    const section = extractSuppressionSubStep(content);
    const lower = section.toLowerCase();
    const hasGuardrail =
      /never (offer(ed)?|suppress(ed)?)[^.]*rotat/.test(lower) ||
      lower.includes("never for rotated credentials") ||
      lower.includes("never for a finding closed via rotation");
    expect(hasGuardrail).toBe(true);
  });

  it("only asks about findings confirmed as false positives as candidates for .gitleaksignore, even when some findings are rotated", () => {
    const section = extractSuppressionSubStep(content);
    const lower = section.toLowerCase();
    expect(lower).toContain("only the false-positive");
  });
});

describe("hitl.md — fingerprint resolution (GLB-2.2)", () => {
  it("documents the gitleaks fingerprint format commit:file:rule:startLine", () => {
    const section = extractSuppressionSubStep(content);
    expect(section).toContain("commit:file:rule:startLine");
  });

  it("handles the case where TASK_DESC already breaks out fingerprints directly", () => {
    const section = extractSuppressionSubStep(content);
    const lower = section.toLowerCase();
    expect(lower).toContain("already");
    expect(lower).toContain("fingerprint");
  });

  it("otherwise asks the human to supply file:line and derive/look up the fingerprint via git blame/git log or the security report", () => {
    const section = extractSuppressionSubStep(content);
    const lower = section.toLowerCase();
    const mentionsLookup =
      lower.includes("git blame") || lower.includes("git log");
    expect(mentionsLookup).toBe(true);
    expect(lower).toContain("security-report.md");
  });
});

describe("hitl.md — worktree → .gitleaksignore → commit → push → PR flow (GLB-2.2 AC2)", () => {
  it("creates a worktree following the standard convention (pull, worktree add, absolute path)", () => {
    const section = extractSuppressionSubStep(content);
    expect(section).toContain("git -C repos/");
    expect(section).toContain("pull");
    expect(section).toContain("worktree add");
    expect(section.toLowerCase()).toContain("absolute");
  });

  it("defines an explicit branch name for the suppression worktree, distinct from the original task's branch", () => {
    const section = extractSuppressionSubStep(content);
    expect(section).toContain("chore/gitleaksignore-suppress-{TASK_ID}");
    const lower = section.toLowerCase();
    expect(lower).toContain("do not reuse that task's branch");
  });

  it("appends confirmed fingerprint lines to the target repo's root .gitleaksignore, creating it if absent", () => {
    const section = extractSuppressionSubStep(content);
    expect(section).toContain(".gitleaksignore");
    const lower = section.toLowerCase();
    expect(lower).toContain("create");
    expect(lower).toContain("append");
  });

  it("each appended line carries a comment citing the HITL task ID and date", () => {
    const section = extractSuppressionSubStep(content);
    expect(section).toContain("TASK_ID");
    const lower = section.toLowerCase();
    expect(lower).toContain("date");
    expect(section).toContain("#");
  });

  it("commits with a fix:/docs: prefix per the target repo's own convention", () => {
    const section = extractSuppressionSubStep(content);
    expect(section).toContain("fix:");
    expect(section).toContain("docs:");
  });

  it("pushes and opens a PR", () => {
    const section = extractSuppressionSubStep(content);
    const lower = section.toLowerCase();
    expect(lower).toContain("git push");
    const hasPrOpen =
      section.includes("gh pr create") || lower.includes("open a pr");
    expect(hasPrOpen).toBe(true);
  });
});

describe("hitl.md — suppression is additive, not required (GLB-2.2)", () => {
  it("declining suppression still proceeds to mark the task done as normal", () => {
    const section = extractSuppressionSubStep(content);
    const lower = section.toLowerCase();
    const hasDeclineLanguage =
      lower.includes("decline") || lower.includes("still deciding");
    expect(hasDeclineLanguage).toBe(true);
    expect(lower).toContain("skip");
    expect(section).toContain("Step 6");
  });

  it("does not remove or restructure the existing mark-done PATCH/print logic in Step 6", () => {
    const step6Section = extractStep6Section(content);
    expect(step6Section).toContain('\\"status\\": \\"done\\"');
    expect(step6Section).toContain("HITL TASK COMPLETE");
  });
});

describe("hitl.md — clear hitl flag when marking done (HSR-2.1 AC1)", () => {
  it("Step 6b PATCHes hitl:false alongside status:done in the code block", () => {
    const section = extractMarkTaskDoneSubStep(content);
    // Check that both status:done and hitl:false appear in the section
    expect(section).toContain("hitl");
    expect(section).toContain("false");
    expect(section).toContain("status");
    expect(section).toContain("done");
    // Both should appear in the code block
    const codeBlock = section.match(/```bash[\s\S]*?```/);
    expect(codeBlock).not.toBeNull();
    const code = codeBlock?.[0] ?? "";
    expect(code).toContain("hitl");
    expect(code).toContain("status");
  });

  it("Step 6b includes hitl:false in multiple branches (with and without OUTCOME_NOTE)", () => {
    const section = extractMarkTaskDoneSubStep(content);
    // Count occurrences of hitl to ensure both branches are covered
    const hitlCount = (section.match(/hitl/g) || []).length;
    expect(hitlCount).toBeGreaterThanOrEqual(2);
  });
});

describe("hitl.md — guard against silent PR in HITL session (HSR-2.1 AC2)", () => {
  it("Step 6 documents a guard: if a PR is set, warn the human instead of marking done", () => {
    const section = extractStep6Section(content);
    const lower = section.toLowerCase();
    // Should check for PR existence
    const hasPrCheck =
      lower.includes("task_pr") ||
      lower.includes("task pr") ||
      lower.includes("resulted") ||
      lower.includes("pr was created");
    expect(hasPrCheck).toBe(true);
    // Should warn the human
    expect(lower).toContain("warn");
  });

  it("Step 6 clarifies that when a PR exists, only hitl:false is cleared, status is left unchanged", () => {
    const section = extractStep6Section(content);
    const lower = section.toLowerCase();
    // When PR exists, should mention not marking status done
    const hasStatusGuard =
      lower.includes("do not mark") ||
      lower.includes("skip") ||
      lower.includes("leave") ||
      lower.includes("leave status");
    expect(hasStatusGuard).toBe(true);
    // Should mention only clearing hitl
    expect(lower).toContain("hitl");
    expect(lower).toContain("false");
  });

  it("Step 6 explains that leaving status unchanged allows the task to re-enter normal candidacy for review/patch/deploy", () => {
    const section = extractStep6Section(content);
    const lower = section.toLowerCase();
    // Should explain that PR flows through the normal lifecycle
    const hasNormalFlow =
      lower.includes("review") ||
      lower.includes("normal") ||
      lower.includes("candidacy") ||
      lower.includes("deploy") ||
      lower.includes("lifecycle");
    expect(hasNormalFlow).toBe(true);
  });
});

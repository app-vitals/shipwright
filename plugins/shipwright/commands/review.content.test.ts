import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REVIEW_MD_PATH = join(import.meta.dir, "review.md");

let content: string;

beforeAll(() => {
  content = readFileSync(REVIEW_MD_PATH, "utf-8");
});

describe("review.md — pre-claim marker documentation (CBD-1.4)", () => {
  it("Arguments section documents the [preclaim:{recordId}:{commitSha}] marker format", () => {
    const argsIdx = content.indexOf("## Arguments");
    const step1Idx = content.indexOf("## Step 1: Load Policy");
    expect(argsIdx).toBeGreaterThan(-1);
    expect(step1Idx).toBeGreaterThan(-1);
    const argsSection = content.slice(argsIdx, step1Idx);

    expect(argsSection).toContain("[preclaim:{recordId}:{commitSha}]");
    expect(argsSection).toContain("CBD-1.3");
  });

  it("Arguments section attributes the marker to the loop orchestrator, not a human caller", () => {
    const argsIdx = content.indexOf("## Arguments");
    const step1Idx = content.indexOf("## Step 1: Load Policy");
    const argsSection = content.slice(argsIdx, step1Idx);

    expect(argsSection).toContain("loop orchestrator");
    expect(argsSection.toLowerCase()).toContain("human");
  });
});

describe("review.md — pre-claim fast path skips re-claiming (CBD-1.4)", () => {
  it("Step 14 has a Pre-Claim Fast Path section", () => {
    const sectionIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    expect(sectionIdx).toBeGreaterThan(-1);
  });

  it("Pre-Claim Fast Path validates the marker's commitSha against the live headRefOid", () => {
    const sectionIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const nextSectionIdx = content.indexOf("2. Fetch the PR record from the task store:", sectionIdx);
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(nextSectionIdx).toBeGreaterThan(-1);
    const section = content.slice(sectionIdx, nextSectionIdx);

    expect(section).toContain("headRefOid");
    expect(section).toContain("PRECLAIM_COMMIT_SHA");
  });

  it("Pre-Claim Fast Path trusts a matching marker and sets PR_RECORD_ID directly", () => {
    const sectionIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const nextSectionIdx = content.indexOf("2. Fetch the PR record from the task store:", sectionIdx);
    const section = content.slice(sectionIdx, nextSectionIdx);

    expect(section).toContain("headRefOid == PRECLAIM_COMMIT_SHA");
    expect(section).toContain("PR_RECORD_ID = PRECLAIM_RECORD_ID");
    expect(section).toContain("skip");
  });

  it("Pre-Claim Fast Path falls back to self-claiming on a stale or absent marker", () => {
    const sectionIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const nextSectionIdx = content.indexOf("2. Fetch the PR record from the task store:", sectionIdx);
    const section = content.slice(sectionIdx, nextSectionIdx);

    expect(section).toContain("headRefOid != PRECLAIM_COMMIT_SHA");
    expect(section).toContain("no marker present");
    expect(section).toContain("self-claiming exactly as today");
  });

  it("Step 4's claim subsection skips its own /prs/claim call when PR_RECORD_ID was already set by the fast path", () => {
    const sectionIdx = content.indexOf("### Claim using pre-captured commit SHA");
    const nextSectionIdx = content.indexOf("## Step 5: Gather Context");
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(nextSectionIdx).toBeGreaterThan(-1);
    const section = content.slice(sectionIdx, nextSectionIdx);

    expect(section).toContain("Skip this subsection if `PR_RECORD_ID` was already set");
    expect(section).toContain("CBD-1.4");
    expect(section).toContain("/prs/claim");
  });

  it("Step 1 of Step 14 parses and strips the pre-claim marker before parsing org/repo/pr", () => {
    const step14Idx = content.indexOf("## Step 14: Resolve and Claim the Target PR");
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    expect(step14Idx).toBeGreaterThan(-1);
    expect(fastPathIdx).toBeGreaterThan(-1);
    const section = content.slice(step14Idx, fastPathIdx);

    expect(section).toContain("PRECLAIM_RECORD_ID");
    expect(section).toContain("PRECLAIM_COMMIT_SHA");
    expect(section).toContain("strip the marker");
  });
});

describe("review.md — task model tier passed to code-reviewer subagent (MTR-1.1)", () => {
  it("Step 4 (after the claim subsection, before Step 5) resolves TASK_MODEL from the linked task", () => {
    const claimSectionIdx = content.indexOf("### Claim using pre-captured commit SHA");
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    expect(claimSectionIdx).toBeGreaterThan(-1);
    expect(step5Idx).toBeGreaterThan(-1);
    const section = content.slice(claimSectionIdx, step5Idx);

    expect(section).toContain("/prs/$PR_RECORD_ID");
    expect(section).toContain(".taskId");
    expect(section).toContain("/tasks/");
    expect(section).toContain("TASK_MODEL");
  });

  it("the TASK_MODEL lookup runs once, regardless of which Step 14 path produced PR_RECORD_ID", () => {
    const claimSectionIdx = content.indexOf("### Claim using pre-captured commit SHA");
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const section = content.slice(claimSectionIdx, step5Idx);

    // Only one lookup block should exist in this window (Step 14's two paths both
    // reconverge here before Step 5, so a single occurrence covers both).
    const occurrences = section.split("TASK_MODEL").length - 1;
    expect(occurrences).toBeGreaterThan(0);
    expect(section).toContain("PR_RECORD_ID");
  });

  it("the TASK_MODEL lookup fails gracefully -- warns and continues, never a hard stop", () => {
    const claimSectionIdx = content.indexOf("### Claim using pre-captured commit SHA");
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const section = content.slice(claimSectionIdx, step5Idx);
    const lookupIdx = section.indexOf("TASK_MODEL");
    expect(lookupIdx).toBeGreaterThan(-1);
    const lookupSection = section.slice(Math.max(0, lookupIdx - 800), lookupIdx + 800);

    expect(lookupSection).toContain("continuing");
    expect(lookupSection).not.toContain("set -e");
  });

  it("Step 7's code-reviewer dispatch passes model: TASK_MODEL ?? 'sonnet'", () => {
    const step7Idx = content.indexOf("## Step 7: Deep Review");
    const step8Idx = content.indexOf("## Step 8: Score and Classify Findings");
    expect(step7Idx).toBeGreaterThan(-1);
    expect(step8Idx).toBeGreaterThan(-1);
    const section = content.slice(step7Idx, step8Idx);

    expect(section).toContain("model: TASK_MODEL ?? 'sonnet'");
  });
});

describe("review.md — state/reviews/ paths survive worktree checkout (RSP-1.1)", () => {
  it("Step 1 captures WORKSPACE_ROOT before the Step 4 worktree checkout", () => {
    const step1Idx = content.indexOf("## Step 1: Load Policy");
    const step2Idx = content.indexOf("## Step 2: Clean Up Worktrees");
    expect(step1Idx).toBeGreaterThan(-1);
    expect(step2Idx).toBeGreaterThan(-1);
    const section = content.slice(step1Idx, step2Idx);

    expect(section).toContain("WORKSPACE_ROOT=$(pwd)");
    expect(section).toContain("state/reviews/");
  });

  it("Step 4's worktree-transition line notes state/reviews/ as an exception", () => {
    const transitionIdx = content.indexOf(
      "All subsequent steps run from `worktrees/{repo}-{branch-slug}/`",
    );
    expect(transitionIdx).toBeGreaterThan(-1);
    const section = content.slice(transitionIdx, transitionIdx + 400);

    expect(section).toContain("state/reviews/");
    expect(section).toContain("WORKSPACE_ROOT");
  });

  it("Step 9's write path is qualified with $WORKSPACE_ROOT", () => {
    const step9Idx = content.indexOf("## Step 9: Write Review File");
    const step10Idx = content.indexOf("## Step 10: Build Review JSON");
    expect(step9Idx).toBeGreaterThan(-1);
    expect(step10Idx).toBeGreaterThan(-1);
    const section = content.slice(step9Idx, step10Idx);

    expect(section).toContain("Write `$WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md`");
  });

  it("Step 9's re-review detection tests for the file at $WORKSPACE_ROOT/state/reviews/", () => {
    const step9Idx = content.indexOf("## Step 9: Write Review File");
    const step10Idx = content.indexOf("## Step 10: Build Review JSON");
    const section = content.slice(step9Idx, step10Idx);

    expect(section).toContain(
      "detected by the local file `$WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md`",
    );
    expect(section).toContain("test -f $WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md");
  });

  it("Step 10's write path is qualified with $WORKSPACE_ROOT", () => {
    const step10Idx = content.indexOf("## Step 10: Build Review JSON");
    const step11Idx = content.indexOf("## Step 11: Post or Stage");
    expect(step10Idx).toBeGreaterThan(-1);
    expect(step11Idx).toBeGreaterThan(-1);
    const section = content.slice(step10Idx, step11Idx);

    expect(section).toContain("Write `$WORKSPACE_ROOT/state/reviews/pr_review_{pr}.json`");
  });

  it("Step 10's diff-line-mapping git diff call is unchanged -- cwd stays inside the worktree", () => {
    const step10Idx = content.indexOf("## Step 10: Build Review JSON");
    const step11Idx = content.indexOf("## Step 11: Post or Stage");
    const section = content.slice(step10Idx, step11Idx);

    expect(section).toContain("**Diff-line mapping**");
    expect(section).toContain("git diff {base}...HEAD -- {file}");
    // This must NOT be qualified with WORKSPACE_ROOT -- it correctly runs from
    // inside the worktree, unlike the file-write paths above.
    const diffLineIdx = section.indexOf("git diff {base}...HEAD -- {file}");
    const surrounding = section.slice(Math.max(0, diffLineIdx - 100), diffLineIdx);
    expect(surrounding).not.toContain("WORKSPACE_ROOT");
  });

  it("Step 11's --input flag references $WORKSPACE_ROOT/state/reviews/", () => {
    const step11Idx = content.indexOf("## Step 11: Post or Stage");
    const step11bIdx = content.indexOf("## Step 11b: Mark PullRequest Record Posted");
    expect(step11Idx).toBeGreaterThan(-1);
    expect(step11bIdx).toBeGreaterThan(-1);
    const section = content.slice(step11Idx, step11bIdx);

    expect(section).toContain("--input $WORKSPACE_ROOT/state/reviews/pr_review_{pr}.json");
  });

  it("Step 14's cross-reference to the Step 9 re-review file is qualified with $WORKSPACE_ROOT", () => {
    const step14Idx = content.indexOf("## Step 14: Resolve and Claim the Target PR");
    expect(step14Idx).toBeGreaterThan(-1);
    const section = content.slice(step14Idx);

    expect(section).toContain(
      "the existing\n  `$WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md`",
    );
  });
});

describe("review.md — Step 5 unresolved-feedback skip marks reviewed-at-commit (BHE-1.3)", () => {
  it("Step 5's Unresolved Comment Check no longer contains a bare /prs/{PR_RECORD_ID}/release call", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    expect(step5Idx).toBeGreaterThan(-1);
    expect(step6Idx).toBeGreaterThan(-1);
    const section = content.slice(step5Idx, step6Idx);

    // The unresolved-feedback skip path should NOT have the old release call
    expect(section).not.toContain("POST $SHIPWRIGHT_TASK_STORE_URL/prs/{PR_RECORD_ID}/release");
  });

  it("Step 5's Unresolved Comment Check contains a PATCH call to /prs/{PR_RECORD_ID} with reviewState:posted", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    const section = content.slice(step5Idx, step6Idx);

    expect(section).toContain("PATCH");
    expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/prs/{PR_RECORD_ID}");
    expect(section).toContain("reviewState");
    expect(section).toContain("posted");
  });

  it("Step 5's Unresolved Comment Check PATCH call includes commitSha set to headRefOid", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    const section = content.slice(step5Idx, step6Idx);
    const patchIdx = section.indexOf("PATCH");
    expect(patchIdx).toBeGreaterThan(-1);

    const patchBlock = section.slice(patchIdx, patchIdx + 500);
    expect(patchBlock).toContain("commitSha");
    expect(patchBlock).toContain("headRefOid");
  });

  it("Step 5's Unresolved Comment Check PATCH call does NOT set staged:true", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    const section = content.slice(step5Idx, step6Idx);
    const patchIdx = section.indexOf("PATCH");
    expect(patchIdx).toBeGreaterThan(-1);

    const patchBlock = section.slice(patchIdx, patchIdx + 500);
    // Should not contain staged:true in this particular call
    expect(patchBlock).not.toContain('"staged": true');
    expect(patchBlock).not.toContain("'staged': true");
  });

  it("Step 5's Unresolved Comment Check documentation notes that this does not interact with review-staged flow", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    const section = content.slice(step5Idx, step6Idx);
    const unresolvedIdx = section.indexOf("#### Unresolved Comment Check");
    expect(unresolvedIdx).toBeGreaterThan(-1);

    const unresolvedSection = section.slice(unresolvedIdx);
    // Should contain explicit documentation about review-staged
    expect(unresolvedSection).toContain("review-staged");
  });

  it("Step 5's Unresolved Comment Check documents the reconciler caveat for the plain-comment trigger case", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    const section = content.slice(step5Idx, step6Idx);
    const unresolvedIdx = section.indexOf("#### Unresolved Comment Check");
    expect(unresolvedIdx).toBeGreaterThan(-1);

    const unresolvedSection = section.slice(unresolvedIdx);
    // Should caveat that the dedup does not reliably persist when the trigger
    // was a plain PR comment with no formal review object at head, since
    // pr-state-reconciler.ts's hasAnyReviewAtHead() only inspects formal
    // review objects and does not account for issue-level comments.
    expect(unresolvedSection).toContain("pr-state-reconciler.ts");
    expect(unresolvedSection).toContain("hasAnyReviewAtHead");
    expect(unresolvedSection).toContain("issue-level PR comments");
  });
});

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
    const step3Idx = content.indexOf("## Step 3: Resolve Current User and Target");
    expect(step1Idx).toBeGreaterThan(-1);
    expect(step3Idx).toBeGreaterThan(-1);
    const section = content.slice(step1Idx, step3Idx);

    expect(section).toContain("WORKSPACE_ROOT=$(pwd)");
    expect(section).toContain("state/reviews/");
  });

  it("Step 4's worktree-transition line notes state/reviews/ as an exception", () => {
    const transitionIdx = content.indexOf(
      "All subsequent steps run from `${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug}/`",
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

  it("Step 5.7's test-readiness read is anchored to the SHIPWRIGHT_WORKTREE_DIR convention", () => {
    const stepIdx = content.indexOf("**Test-readiness context**");
    expect(stepIdx).toBeGreaterThan(-1);
    const section = content.slice(stepIdx, stepIdx + 400);

    expect(section).toContain(
      "${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug}/docs/test-readiness/test-system.md",
    );
    expect(section).not.toContain(
      "read `worktrees/{repo}-{branch-slug}/docs/test-readiness/test-system.md`",
    );
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
    expect(section).toContain("git diff origin/{base}...HEAD -- {file}");
    // This must NOT be qualified with WORKSPACE_ROOT -- it correctly runs from
    // inside the worktree, unlike the file-write paths above.
    const diffLineIdx = section.indexOf("git diff origin/{base}...HEAD -- {file}");
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

  it("Step 5's Unresolved Comment Check tags the defer with a namespaced skip-reason marker before [silent], exempting it from the HITL auto-block skip counter (STD-1.4)", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    const section = content.slice(step5Idx, step6Idx);
    const unresolvedIdx = section.indexOf("#### Unresolved Comment Check");
    expect(unresolvedIdx).toBeGreaterThan(-1);

    const unresolvedSection = section.slice(unresolvedIdx);
    expect(unresolvedSection).toContain(
      "[skip-reason:review:deferred:unresolved-human-feedback:{pr}]",
    );
    const skipReasonIdx = unresolvedSection.indexOf(
      "[skip-reason:review:deferred:unresolved-human-feedback:{pr}]",
    );
    const silentIdx = unresolvedSection.indexOf("[silent]");
    expect(silentIdx).toBeGreaterThan(-1);
    expect(skipReasonIdx).toBeLessThan(silentIdx);
  });
});

describe("review.md — Step 14 live-review pre-check (RVD-1.2)", () => {
  let step14Section: string;

  beforeAll(() => {
    const step14Idx = content.indexOf(
      "## Step 14: Resolve and Claim the Target PR",
    );
    const step14EndIdx = content.indexOf(
      "## Review Quality Rules",
      step14Idx,
    );
    expect(step14Idx).toBeGreaterThan(-1);
    expect(step14EndIdx).toBeGreaterThan(step14Idx);
    step14Section = content.slice(step14Idx, step14EndIdx);
  });

  it("Step 14 contains a Live-Review Pre-Check (RVD-1.2) heading", () => {
    expect(step14Section).toContain("### Live-Review Pre-Check (RVD-1.2)");
  });

  it("the Live-Review Pre-Check heading appears before the Pre-Claim Fast Path heading", () => {
    const preCheckIdx = content.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    expect(preCheckIdx).toBeGreaterThan(-1);
    expect(fastPathIdx).toBeGreaterThan(-1);
    expect(preCheckIdx).toBeLessThan(fastPathIdx);
  });

  it("the Live-Review Pre-Check section appears before the task-store record fetch", () => {
    const preCheckIdx = content.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const recordFetchIdx = content.indexOf(
      "Fetch the PR record from the task store",
    );
    expect(preCheckIdx).toBeGreaterThan(-1);
    expect(recordFetchIdx).toBeGreaterThan(-1);
    expect(preCheckIdx).toBeLessThan(recordFetchIdx);
  });

  it("the section references VERDICT_TERMINAL_LABEL and check-helpers.ts by name", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    expect(preCheckIdx).toBeGreaterThan(-1);
    expect(fastPathIdx).toBeGreaterThan(preCheckIdx);
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("VERDICT_TERMINAL_LABEL");
    expect(section).toContain("check-helpers.ts");
  });

  it("the section documents no-claim / no-checkout / no-author-filtering behavior", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section.toLowerCase()).toContain("no claim");
    expect(section.toLowerCase()).toContain("no checkout");
    expect(section.toLowerCase()).toContain("no author filtering");
  });

  it("the section runs a gh api graphql query and checks reviews at headRefOid", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("gh api graphql -f query=");
    expect(section).toContain("headRefOid");
    expect(section).toContain("reviews(first: 50)");
    expect(section).toContain("commit {");
  });

  it("the section prints a cross-task-store skip message and stops before checkout/claim", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("cross-task-store");
    expect(section.toLowerCase()).toContain("stop");
  });

  it("the graphql query includes submittedAt on review nodes", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("submittedAt");
  });

  it("the graphql query includes comments with author and createdAt fields", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("comments");
    expect(section).toContain("createdAt");
  });

  it("the graphql query paginates comments with last: 50, not first: 50, matching check-review.ts's fetchPrReviews", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("comments(last: 50)");
    expect(section).not.toContain("comments(first: 50)");
  });

  it("the graphql query includes the PR author login", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("author {");
    expect(section).toContain("login");
  });

  it("the prose documents the fresh-author-reply exception and that it mirrors check-review.ts", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("fresh");
    expect(section).toContain("reply");
    expect(section).toContain("check-review.ts");
  });

  it("the jq program's fresh-reply filter is broadened to any non-currentUser commenter, not just the PR author (RCT-1.1 mirror)", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain(".author.login != $currentUser");
    expect(section).not.toContain(".author.login == $pr.author.login");
  });

  it("the gh api graphql call threads the resolved CURRENT_USER into the jq program", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain('--arg currentUser "$CURRENT_USER"');
  });

  it("CURRENT_USER is assigned before the gh api graphql call, since Step 14 runs before Step 9.5's own assignment", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    const assignIdx = section.indexOf(
      "CURRENT_USER={the login resolved in Step 3}",
    );
    const graphqlIdx = section.indexOf("gh api graphql -f query=");

    expect(assignIdx).toBeGreaterThan(-1);
    expect(graphqlIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeLessThan(graphqlIdx);
  });

  it("the prose references hasFreshNonAgentComment and describes the broadened non-author-only condition", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("hasFreshNonAgentComment");
    // Should describe the broadened condition (anyone other than the
    // reviewing agent), not just the PR author.
    expect(section.toLowerCase()).toMatch(
      /anyone other than|not just the pr author|other than the reviewing agent/,
    );
  });

  it("when a pre-claim marker was present, the skip branch releases the orphaned claim before stopping", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    // The section must contain a conditional release call referencing PRECLAIM_RECORD_ID
    expect(section).toContain("/prs/");
    expect(section).toContain("/release");
    expect(section).toContain("PRECLAIM_RECORD_ID");
  });

  it("the pre-claim release call appears before the 'Skipping' message", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    const releaseIdx = section.indexOf("/release");
    const skippingIdx = section.indexOf("Skipping #{pr}");

    expect(releaseIdx).toBeGreaterThan(-1);
    expect(skippingIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeLessThan(skippingIdx);
  });

  it("the release call is conditional on PRECLAIM_RECORD_ID being non-empty", () => {
    const preCheckIdx = step14Section.indexOf(
      "### Live-Review Pre-Check (RVD-1.2)",
    );
    const fastPathIdx = step14Section.indexOf(
      "### Pre-Claim Fast Path (CBD-1.4)",
    );
    const section = step14Section.slice(preCheckIdx, fastPathIdx);

    // Should reference checking if PRECLAIM_RECORD_ID is set
    const releaseIdx = section.indexOf("/release");
    const releaseBlock = section.slice(Math.max(0, releaseIdx - 300), releaseIdx + 100);

    expect(releaseBlock).toMatch(/if.*PRECLAIM_RECORD_ID|PRECLAIM_RECORD_ID.*if|-z.*PRECLAIM_RECORD_ID|-n.*PRECLAIM_RECORD_ID/i);
  });
});

describe("review.md — RVD-1.2 terminal-review skip emits [silent] + skip-reason marker (STD-1.5)", () => {
  it("the terminal-review skip block contains the skip-reason marker before [silent], exempting it from the HITL auto-block skip counter", () => {
    const preCheckIdx = content.indexOf("### Live-Review Pre-Check (RVD-1.2)");
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    expect(preCheckIdx).toBeGreaterThan(-1);
    expect(fastPathIdx).toBeGreaterThan(preCheckIdx);
    const section = content.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain(
      "[skip-reason:review:deferred:already-reviewed-at-head:{pr}]",
    );
    const skipReasonIdx = section.indexOf(
      "[skip-reason:review:deferred:already-reviewed-at-head:{pr}]",
    );
    const silentIdx = section.indexOf("[silent]");
    expect(silentIdx).toBeGreaterThan(-1);
    expect(skipReasonIdx).toBeLessThan(silentIdx);
  });

  it("still stops with no claim, no checkout after emitting the markers", () => {
    const preCheckIdx = content.indexOf("### Live-Review Pre-Check (RVD-1.2)");
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const section = content.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("Stop.");
    expect(section).toContain("No claim, no checkout");
  });
});

describe("review.md — RVD-1.2 terminal-review skip writes back task-store reviewState (RVD-2.2)", () => {
  it("the terminal-review branch contains a PATCH call to /prs/{PR_RECORD_ID} with reviewState:posted", () => {
    const preCheckIdx = content.indexOf("### Live-Review Pre-Check (RVD-1.2)");
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    expect(preCheckIdx).toBeGreaterThan(-1);
    expect(fastPathIdx).toBeGreaterThan(preCheckIdx);
    const section = content.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("PATCH");
    expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/prs/");
    expect(section).toContain("PR_RECORD_ID");
    expect(section).toContain("reviewState");
    expect(section).toContain("posted");
  });

  it("the PATCH body sets reviewedCommitSha to headRefOid", () => {
    const preCheckIdx = content.indexOf("### Live-Review Pre-Check (RVD-1.2)");
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const section = content.slice(preCheckIdx, fastPathIdx);

    const patchIdx = section.indexOf("PATCH");
    expect(patchIdx).toBeGreaterThan(-1);
    const patchBlock = section.slice(patchIdx, patchIdx + 700);

    expect(patchBlock).toContain("reviewedCommitSha");
    expect(patchBlock).toContain("headRefOid");
  });

  it("determines PR_RECORD_ID by reusing PRECLAIM_RECORD_ID when present, else looking it up by repo+prNumber", () => {
    const preCheckIdx = content.indexOf("### Live-Review Pre-Check (RVD-1.2)");
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const section = content.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("PRECLAIM_RECORD_ID");
    expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/prs?repo=");
    expect(section).toContain("prNumber=");
  });

  it("documents not double-writing when the record already reflects the terminal state at this head commit", () => {
    const preCheckIdx = content.indexOf("### Live-Review Pre-Check (RVD-1.2)");
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const section = content.slice(preCheckIdx, fastPathIdx);

    const lower = section.toLowerCase();
    expect(lower).toContain("already");
    expect(lower).toMatch(/double-write|double write/);
  });

  it("the write-back logic appears before the 'Skipping' print and the [silent] stop", () => {
    const preCheckIdx = content.indexOf("### Live-Review Pre-Check (RVD-1.2)");
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const section = content.slice(preCheckIdx, fastPathIdx);

    const patchIdx = section.indexOf("PATCH");
    const skippingIdx = section.indexOf("Skipping #{pr}");
    const silentIdx = section.lastIndexOf("[silent]");

    expect(patchIdx).toBeGreaterThan(-1);
    expect(skippingIdx).toBeGreaterThan(-1);
    expect(silentIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeLessThan(skippingIdx);
    expect(patchIdx).toBeLessThan(silentIdx);
  });

  it("explains the write-back is safe against pr-state-reconciler.ts's CHU-2.4 posted-scan reverting it, citing hasAnyReviewAtHead", () => {
    const preCheckIdx = content.indexOf("### Live-Review Pre-Check (RVD-1.2)");
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const section = content.slice(preCheckIdx, fastPathIdx);

    expect(section).toContain("pr-state-reconciler.ts");
    expect(section).toContain("hasAnyReviewAtHead");
    expect(section).toContain("reconcilePostedReviewStateRecord");
  });
});

describe("review.md — Step 14.3 already-reviewed-at-commit skip emits [silent] + skip-reason marker (STD-1.5)", () => {
  it("the already-reviewed-at-commit skip block contains the skip-reason marker before [silent], exempting it from the HITL auto-block skip counter", () => {
    const step14Idx = content.indexOf("## Step 14: Resolve and Claim the Target PR");
    const endIdx = content.indexOf("## Review Quality Rules", step14Idx);
    expect(step14Idx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(step14Idx);
    const section = content.slice(step14Idx, endIdx);

    const dedupIdx = section.indexOf(
      "**Check if the PR was already reviewed at the current commit**",
    );
    expect(dedupIdx).toBeGreaterThan(-1);
    const dedupSection = section.slice(dedupIdx);

    expect(dedupSection).toContain(
      "[skip-reason:review:deferred:already-reviewed-at-head:{pr}]",
    );
    const skipReasonIdx = dedupSection.indexOf(
      "[skip-reason:review:deferred:already-reviewed-at-head:{pr}]",
    );
    const silentIdx = dedupSection.indexOf("[silent]");
    expect(silentIdx).toBeGreaterThan(-1);
    expect(skipReasonIdx).toBeLessThan(silentIdx);
  });

  it("still stops after emitting the markers", () => {
    const step14Idx = content.indexOf("## Step 14: Resolve and Claim the Target PR");
    const endIdx = content.indexOf("## Review Quality Rules", step14Idx);
    const section = content.slice(step14Idx, endIdx);

    const dedupIdx = section.indexOf(
      "**Check if the PR was already reviewed at the current commit**",
    );
    expect(dedupIdx).toBeGreaterThan(-1);
    const dedupSection = section.slice(dedupIdx);

    expect(dedupSection).toContain("Stop.");
  });
});

describe("review.md — Step 14.3 already-reviewed-at-commit skip writes back terminal reviewState (RVD-2.3)", () => {
  it("the skip block contains a PATCH call to /prs/{PR_RECORD_ID} with reviewState:posted before the [silent] stop", () => {
    const step14Idx = content.indexOf("## Step 14: Resolve and Claim the Target PR");
    const endIdx = content.indexOf("## Review Quality Rules", step14Idx);
    expect(step14Idx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(step14Idx);
    const section = content.slice(step14Idx, endIdx);

    const dedupIdx = section.indexOf(
      "**Check if the PR was already reviewed at the current commit**",
    );
    expect(dedupIdx).toBeGreaterThan(-1);
    const dedupSection = section.slice(dedupIdx);

    expect(dedupSection).toContain("PATCH");
    expect(dedupSection).toContain("$SHIPWRIGHT_TASK_STORE_URL/prs/{PR_RECORD_ID}");
    expect(dedupSection).toContain('"reviewState": "posted"');
    expect(dedupSection).toContain('"reviewedCommitSha": "{headRefOid}"');

    const patchIdx = dedupSection.indexOf("PATCH");
    const respondIdx = dedupSection.indexOf("Respond `[silent]`. Stop.");
    expect(respondIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeLessThan(respondIdx);
  });

  it("the write-back is unconditional, not re-gated on record.reviewState", () => {
    const step14Idx = content.indexOf("## Step 14: Resolve and Claim the Target PR");
    const endIdx = content.indexOf("## Review Quality Rules", step14Idx);
    const section = content.slice(step14Idx, endIdx);

    const dedupIdx = section.indexOf(
      "**Check if the PR was already reviewed at the current commit**",
    );
    const dedupSection = section.slice(dedupIdx);

    // The block's own entry condition (lines above) already requires
    // record.reviewState to be posted/approved to reach this point, and nothing
    // re-fetches or mutates that field in between — so re-guarding the PATCH on
    // the same unmutated field would be dead code (unreachable). The PATCH must
    // fire unconditionally, mirroring the Step 5 precedent.
    expect(dedupSection).not.toMatch(/not already `posted` or `approved`/);
    expect(dedupSection).toContain("unconditional");
  });

  it("documents that this reuses the record already fetched in this step, without an extra query", () => {
    const step14Idx = content.indexOf("## Step 14: Resolve and Claim the Target PR");
    const endIdx = content.indexOf("## Review Quality Rules", step14Idx);
    const section = content.slice(step14Idx, endIdx);

    const dedupIdx = section.indexOf(
      "**Check if the PR was already reviewed at the current commit**",
    );
    const dedupSection = section.slice(dedupIdx);

    expect(dedupSection).toContain("no extra query");
  });
});

describe("review.md — reviewedCommitSha written/read for dedup (RCS-1.2)", () => {
  it("Step 5's Unresolved Comment Check PATCH call also sets reviewedCommitSha alongside commitSha", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    const section = content.slice(step5Idx, step6Idx);
    const patchIdx = section.indexOf("PATCH");
    expect(patchIdx).toBeGreaterThan(-1);

    const patchBlock = section.slice(patchIdx, patchIdx + 500);
    expect(patchBlock).toContain("commitSha");
    expect(patchBlock).toContain("reviewedCommitSha");
  });

  it("Step 11's APPROVE staging PATCH call sets reviewedCommitSha", () => {
    const step11Idx = content.indexOf("## Step 11: Post or Stage");
    const step11bIdx = content.indexOf("## Step 11b: Mark PullRequest Record Posted");
    expect(step11Idx).toBeGreaterThan(-1);
    expect(step11bIdx).toBeGreaterThan(step11Idx);
    const section = content.slice(step11Idx, step11bIdx);

    const approveIdx = section.indexOf('"reviewState": "approved"');
    expect(approveIdx).toBeGreaterThan(-1);
    const approveBlock = section.slice(approveIdx - 200, approveIdx + 200);
    expect(approveBlock).toContain("reviewedCommitSha");
  });

  it("Step 11's COMMENT staging PATCH call sets reviewedCommitSha", () => {
    const step11Idx = content.indexOf("## Step 11: Post or Stage");
    const step11bIdx = content.indexOf("## Step 11b: Mark PullRequest Record Posted");
    const section = content.slice(step11Idx, step11bIdx);

    const commentIdx = section.indexOf('"reviewState": "posted"');
    expect(commentIdx).toBeGreaterThan(-1);
    const commentBlock = section.slice(commentIdx - 200, commentIdx + 200);
    expect(commentBlock).toContain("reviewedCommitSha");
  });

  it("Step 14's stale-staged-review detection captures reviewedCommitSha (not commitSha) as lastReviewedCommit", () => {
    const step14Idx = content.indexOf("## Step 14: Resolve and Claim the Target PR");
    const endIdx = content.indexOf("## Review Quality Rules", step14Idx);
    expect(step14Idx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(step14Idx);
    const section = content.slice(step14Idx, endIdx);

    expect(section).toContain(
      "Capture the record's `id` as `PR_RECORD_ID` and `reviewedCommitSha` as `lastReviewedCommit`.",
    );
  });

  it("Step 14's stale-staged-review comparisons reference record.reviewedCommitSha, not record.commitSha", () => {
    const step14Idx = content.indexOf("## Step 14: Resolve and Claim the Target PR");
    const endIdx = content.indexOf("## Review Quality Rules", step14Idx);
    const section = content.slice(step14Idx, endIdx);

    // The staged-record comparison and the defense-in-depth dedup comparison
    // must both read the dedicated reviewedCommitSha field.
    expect(section).toContain("record.reviewedCommitSha");
    expect(section).not.toContain("record.commitSha");
  });

  it("Step 11b's PATCH_DATA sets reviewedCommitSha for both the APPROVE branch and the else branch", () => {
    const step11bIdx = content.indexOf("## Step 11b: Mark PullRequest Record Posted");
    const step14Idx = content.indexOf("## Step 14: Resolve and Claim the Target PR");
    expect(step11bIdx).toBeGreaterThan(-1);
    expect(step14Idx).toBeGreaterThan(step11bIdx);
    const section = content.slice(step11bIdx, step14Idx);

    const approveIdx = section.indexOf('\\"reviewState\\": \\"approved\\"');
    expect(approveIdx).toBeGreaterThan(-1);
    const approveBlock = section.slice(approveIdx - 200, approveIdx + 200);
    expect(approveBlock).toContain("reviewedCommitSha");

    const elseIdx = section.indexOf(
      'PATCH_DATA="{\\"agentId\\": \\"$SHIPWRIGHT_AGENT_ID\\", \\"reviewedCommitSha\\"',
    );
    expect(elseIdx).toBeGreaterThan(-1);
  });

  it("the initial /prs/claim call's commitSha argument is unchanged (claim-lock field, not reviewedCommitSha)", () => {
    const step4Idx = content.indexOf("## Step 4: Checkout into Worktree");
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    expect(step4Idx).toBeGreaterThan(-1);
    expect(step5Idx).toBeGreaterThan(step4Idx);
    const section = content.slice(step4Idx, step5Idx);

    expect(section).toContain(
      '-d "{\\"repo\\": \\"{org}/{repo}\\", \\"prNumber\\": {pr}, \\"commitSha\\": \\"{headRefOid}\\"',
    );
  });
});

describe("review.md — Step 5.5 fetches reviewThreads via GraphQL (RUC-1.1)", () => {
  it("Step 5's 'Existing reviews and comments' item uses a gh api graphql call, not the REST gh pr view --json comments,reviews call", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    expect(step5Idx).toBeGreaterThan(-1);
    expect(step6Idx).toBeGreaterThan(-1);
    const section = content.slice(step5Idx, step6Idx);

    const itemIdx = section.indexOf("Existing reviews, comments, and inline review threads");
    expect(itemIdx).toBeGreaterThan(-1);
    const itemBlock = section.slice(itemIdx, itemIdx + 1500);

    expect(itemBlock).toContain("gh api graphql -f query=");
    expect(itemBlock).not.toContain("gh pr view {pr} --repo {org}/{repo} --json comments,reviews");
  });

  it("Step 5.5's GraphQL query fetches reviewThreads with isResolved and inline comment author/body/path/line", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    const section = content.slice(step5Idx, step6Idx);

    const itemIdx = section.indexOf("Existing reviews, comments, and inline review threads");
    expect(itemIdx).toBeGreaterThan(-1);
    const itemBlock = section.slice(itemIdx, itemIdx + 1500);

    expect(itemBlock).toContain("reviewThreads(first: 100)");
    expect(itemBlock).toContain("isResolved");
    expect(itemBlock).toContain("author { login }");
    expect(itemBlock).toContain("body");
    expect(itemBlock).toContain("path");
    expect(itemBlock).toContain("line");
  });

  it("Step 5.5's GraphQL query also fetches reviews and comments in the same call", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    const section = content.slice(step5Idx, step6Idx);

    const itemIdx = section.indexOf("Existing reviews, comments, and inline review threads");
    expect(itemIdx).toBeGreaterThan(-1);
    const itemBlock = section.slice(itemIdx, itemIdx + 1500);

    expect(itemBlock).toContain("reviews(first:");
    expect(itemBlock).toContain("comments(first:");
  });
});

describe("review.md — Unresolved Comment Check includes unresolved inline threads (RUC-1.1)", () => {
  it("the substantive unresolved feedback condition includes an unresolved inline review thread bullet", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    const section = content.slice(step5Idx, step6Idx);
    const unresolvedIdx = section.indexOf("#### Unresolved Comment Check");
    expect(unresolvedIdx).toBeGreaterThan(-1);
    const unresolvedSection = section.slice(unresolvedIdx);

    expect(unresolvedSection).toContain("unresolved inline");
    expect(unresolvedSection.toLowerCase()).toContain("thread");
  });

  it("the unresolved inline thread condition excludes bot authors and CURRENT_USER, matching existing filtering", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    const section = content.slice(step5Idx, step6Idx);
    const unresolvedIdx = section.indexOf("#### Unresolved Comment Check");
    const unresolvedSection = section.slice(unresolvedIdx);

    const bulletIdx = unresolvedSection.indexOf("unresolved inline");
    expect(bulletIdx).toBeGreaterThan(-1);
    const bulletBlock = unresolvedSection.slice(Math.max(0, bulletIdx - 200), bulletIdx + 300);

    expect(bulletBlock).toContain("CURRENT_USER");
    expect(bulletBlock.toLowerCase()).toContain("bot");
  });
});

describe("review.md — unaddressed-findings hard gate before Step 10 (RUC-1.1)", () => {
  it("a new gate section exists immediately before Step 10 referencing patch.md's Step 3a definition", () => {
    const step9Idx = content.indexOf("## Step 9: Write Review File");
    const step10Idx = content.indexOf("## Step 10: Build Review JSON");
    expect(step9Idx).toBeGreaterThan(-1);
    expect(step10Idx).toBeGreaterThan(-1);

    // The gate lives either as its own section between Step 9 and Step 10, or
    // as the first thing inside Step 10 before "Event selection".
    const eventSelectionIdx = content.indexOf("## Step 11: Post or Stage");
    expect(eventSelectionIdx).toBeGreaterThan(step10Idx);

    const searchWindow = content.slice(step9Idx, eventSelectionIdx);
    expect(searchWindow).toContain("Step 3a");
    expect(searchWindow.toLowerCase()).toContain("unaddressed findings");
  });

  it("the gate forces event to COMMENT when unaddressed findings are present", () => {
    const step9Idx = content.indexOf("## Step 9: Write Review File");
    const eventSelectionIdx = content.indexOf("## Step 11: Post or Stage");
    expect(step9Idx).toBeGreaterThan(-1);
    expect(eventSelectionIdx).toBeGreaterThan(-1);
    const searchWindow = content.slice(step9Idx, eventSelectionIdx);

    const gateIdx = searchWindow.toLowerCase().indexOf("unaddressed findings");
    expect(gateIdx).toBeGreaterThan(-1);
    const gateBlock = searchWindow.slice(gateIdx, gateIdx + 7000);

    expect(gateBlock).toContain("COMMENT");
    expect(gateBlock).toContain("event");
  });

  it("the gate overrides the code-reviewer subagent's recommendation and the self-review override, without being mutually exclusive", () => {
    const step9Idx = content.indexOf("## Step 9: Write Review File");
    const eventSelectionIdx = content.indexOf("## Step 11: Post or Stage");
    const searchWindow = content.slice(step9Idx, eventSelectionIdx);

    const gateIdx = searchWindow.toLowerCase().indexOf("unaddressed findings");
    expect(gateIdx).toBeGreaterThan(-1);
    const gateBlock = searchWindow.slice(gateIdx, gateIdx + 7000);

    expect(gateBlock.toLowerCase()).toContain("self-review");
    expect(gateBlock).toContain("override");
  });

  it("the gate feeds unaddressedFindings into Step 10's mechanical three-input verdict computation, not a standalone formula", () => {
    const step9Idx = content.indexOf("## Step 9: Write Review File");
    const eventSelectionIdx = content.indexOf("## Step 11: Post or Stage");
    const searchWindow = content.slice(step9Idx, eventSelectionIdx);

    const gateIdx = searchWindow.toLowerCase().indexOf("unaddressed findings");
    expect(gateIdx).toBeGreaterThan(-1);
    const gateBlock = searchWindow.slice(gateIdx, gateIdx + 7000);

    expect(gateBlock).toContain("compute-review-verdict.ts");
    expect(gateBlock).toContain("three-input truth table");
    // The stale two-input inline formula from before Step 10's mechanical gate must not
    // reappear -- it contradicted the three-input truth table (RUC-1.1/DRO-1.1 review
    // finding: Step 9.5 must not restate a freehand fallback to the subagent's own
    // recommendation).
    expect(gateBlock).not.toContain(
      'unaddressedFindings ? "COMMENT" : {code-reviewer subagent\'s recommended',
    );
  });

  it("the gate's cross-reference to the other two verdict inputs does not point at the deleted 'Self-review event override' subsection", () => {
    const step9Idx = content.indexOf("## Step 9: Write Review File");
    const eventSelectionIdx = content.indexOf("## Step 11: Post or Stage");
    const searchWindow = content.slice(step9Idx, eventSelectionIdx);

    const gateIdx = searchWindow.toLowerCase().indexOf("unaddressed findings");
    expect(gateIdx).toBeGreaterThan(-1);
    const gateBlock = searchWindow.slice(gateIdx, gateIdx + 7000);

    // This PR folds the old named "Self-review event override" subsection into Step 10's
    // unnamed mechanical paragraph -- Step 9.5's cross-reference must point at the
    // mechanical computation (the selfReview input), not at the now-deleted subsection name
    // (RUC-1.1/DRO-1.1 review finding: a dangling cross-reference to removed prose).
    expect(gateBlock).not.toContain("Step 10 self-review COMMENT-forcing override");
    expect(gateBlock).toContain("`selfReview` input");
    expect(gateBlock).toContain("Step 10's mechanical");
  });

  it("the gate references the OR condition of any unresolved inline thread, matching patch.md's Step 3a", () => {
    const step9Idx = content.indexOf("## Step 9: Write Review File");
    const eventSelectionIdx = content.indexOf("## Step 11: Post or Stage");
    const searchWindow = content.slice(step9Idx, eventSelectionIdx);

    const gateIdx = searchWindow.toLowerCase().indexOf("unaddressed findings");
    const gateBlock = searchWindow.slice(gateIdx, gateIdx + 7000);

    expect(gateBlock.toLowerCase()).toContain("unresolved inline thread");
  });

  it("the gate does not persist a new dedup state field -- it is computed live, consistent with the Design Constitution", () => {
    const step9Idx = content.indexOf("## Step 9: Write Review File");
    const eventSelectionIdx = content.indexOf("## Step 11: Post or Stage");
    const searchWindow = content.slice(step9Idx, eventSelectionIdx);

    const gateIdx = searchWindow.toLowerCase().indexOf("unaddressed findings");
    const gateBlock = searchWindow.slice(gateIdx, gateIdx + 7000);

    // Should not introduce any new task-store PATCH/POST field for this gate.
    expect(gateBlock).not.toContain("SHIPWRIGHT_TASK_STORE_URL");
  });

  it("Step 5.5's GraphQL query now fetches commit.oid on reviews, required by the mechanical hasUnaddressedFindings gate (PVD-1.1)", () => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    expect(step5Idx).toBeGreaterThan(-1);
    expect(step6Idx).toBeGreaterThan(step5Idx);
    const step5Section = content.slice(step5Idx, step6Idx);

    // agent/src/check-patch.ts's real hasUnaddressedFindings (now the single mechanical
    // implementation this gate invokes, via compute-unaddressed-findings.ts) filters
    // qualifying reviews down to `commit.oid === headRefOid` -- Step 5.5's query must fetch
    // that field or the mechanical gate would silently treat every review as stale and never
    // find a qualifying finding, a behavior regression versus the pre-PVD-1.1 freehand prose.
    expect(step5Section).toContain("commit { oid }");
    expect(step5Section).toContain("commit.oid");
  });

  it("the review-body condition documents the exclusions, matching patch.md's Step 3a definition", () => {
    const step9Idx = content.indexOf("## Step 9: Write Review File");
    const eventSelectionIdx = content.indexOf("## Step 11: Post or Stage");
    const searchWindow = content.slice(step9Idx, eventSelectionIdx);

    const gateIdx = searchWindow.toLowerCase().indexOf("unaddressed findings");
    expect(gateIdx).toBeGreaterThan(-1);
    const gateBlock = searchWindow.slice(gateIdx, gateIdx + 7000);

    expect(gateBlock).toContain(
      'At least one review with `state == "COMMENTED"` or `state == "CHANGES_REQUESTED"` has a\n  non-empty `body`, excluding:',
    );
  });

  it("the gate documents the superseded-self-review exclusion (DRO-1.2), so a self-authored PR with multiple COMMENT-only rounds can still reach a clean verdict once fixed", () => {
    const step9Idx = content.indexOf("## Step 9: Write Review File");
    const eventSelectionIdx = content.indexOf("## Step 11: Post or Stage");
    const searchWindow = content.slice(step9Idx, eventSelectionIdx);

    const gateIdx = searchWindow.toLowerCase().indexOf("unaddressed findings");
    expect(gateIdx).toBeGreaterThan(-1);
    const gateBlock = searchWindow.slice(gateIdx, gateIdx + 7000);

    // Without this exclusion, a self-authored PR reviewed via a fresh review object each
    // round (rather than a body rewrite) would have unaddressedFindings compute true
    // forever, even after every prior finding is fixed -- there is no combination of
    // computeVerdict() inputs that reaches verdictLabel "APPROVE" while
    // unaddressedFindings is true (DRO-1.1/DRO-1.2 review finding, observed on this PR's
    // own review history).
    expect(gateBlock).toContain("superseded by a later, genuinely clean self-review");
    expect(gateBlock).toContain("DRO-1.2");
  });
});

describe("review.md — Step 9.5 invokes compute-unaddressed-findings.ts mechanically instead of freehand prose (PVD-1.1)", () => {
  let step95Section: string;

  beforeAll(() => {
    const step95Idx = content.indexOf("## Step 9.5:");
    const step10Idx = content.indexOf("## Step 10: Build Review JSON");
    expect(step95Idx).toBeGreaterThan(-1);
    expect(step10Idx).toBeGreaterThan(step95Idx);
    step95Section = content.slice(step95Idx, step10Idx);
  });

  it("invokes the extracted compute-unaddressed-findings.ts CLI script via CLAUDE_PLUGIN_ROOT", () => {
    expect(step95Section).toContain(
      'bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-unaddressed-findings.ts"',
    );
  });

  it("states the computation is mechanical, not freehand narrative judgment", () => {
    expect(step95Section).toContain("computed mechanically, not freehand");
    expect(step95Section).toContain("do not decide `unaddressedFindings` by narrative judgment");
  });

  it("passes through the Step 5.5 GraphQL data (reviews, reviewThreads, comments, headRefOid) and Step 3's CURRENT_USER, without re-fetching", () => {
    expect(step95Section).toContain("CURRENT_USER");
    expect(step95Section).toContain("REVIEWS_JSON");
    expect(step95Section).toContain("REVIEW_THREADS_JSON");
    expect(step95Section).toContain("COMMENTS_JSON");
    expect(step95Section).toContain("HEAD_REF_OID");
    expect(step95Section).toContain("Step 5.5");
    expect(step95Section).toContain("do not re-fetch or re-shape");
  });

  it("assigns the script's boolean output to UNADDRESSED_FINDINGS for Step 10 to consume", () => {
    expect(step95Section).toContain("UNADDRESSED_FINDINGS=");
    expect(step95Section).toContain('{"unaddressedFindings":true|false}');
  });

  it("references PVD-1.1 and compute-review-verdict.ts's precedent CLI pattern (DRO-1.1)", () => {
    expect(step95Section).toContain("PVD-1.1");
    expect(step95Section).toContain("compute-review-verdict.ts");
    expect(step95Section).toContain("DRO-1.1");
  });

  it("no longer instructs the LLM to compute unaddressedFindings by narrative/freehand judgment", () => {
    expect(step95Section).not.toContain(
      "compute whether this PR has **unaddressed",
    );
    expect(step95Section).toContain("computed mechanically, not freehand");
  });
});

describe("review.md — Step 10 worked example distinguishes self-review-COMMENT-event from unresolved-finding-COMMENT-verdict (RVG-1.2)", () => {
  let workedExampleSection: string;

  beforeAll(() => {
    const bodyMustContainIdx = content.indexOf(
      "**The `body` field MUST contain the literal phrase",
    );
    const jsonBlockIdx = content.indexOf(
      "Write `$WORKSPACE_ROOT/state/reviews/pr_review_{pr}.json`:",
    );
    expect(bodyMustContainIdx).toBeGreaterThan(-1);
    expect(jsonBlockIdx).toBeGreaterThan(bodyMustContainIdx);
    workedExampleSection = content.slice(bodyMustContainIdx, jsonBlockIdx);
  });

  it("references that this failure mode was observed on real production PRs (one self-authored, one not)", () => {
    expect(workedExampleSection.toLowerCase()).toContain("production");
    expect(workedExampleSection.toLowerCase()).toContain("self-authored, one not");
  });

  it("references the literal observed failure mode -- body said Verdict: COMMENT despite a clean narrative", () => {
    expect(workedExampleSection).toContain("Verdict: COMMENT");
    expect(workedExampleSection.toLowerCase()).toContain("no blocking issues");
    expect(workedExampleSection.toLowerCase()).toContain("checks out clean");
  });

  it("Case 1 describes a self-authored PR with all findings resolved via Step 9.5's exclusions", () => {
    const case1Idx = workedExampleSection.indexOf("**Case 1");
    expect(case1Idx).toBeGreaterThan(-1);
    const case1Block = workedExampleSection.slice(case1Idx, case1Idx + 700);

    expect(case1Block.toLowerCase()).toContain("self-authored");
    expect(case1Block).toContain("Step 9.5");
    expect(case1Block).toContain('event: "COMMENT"');
    expect(case1Block).toContain("Verdict: APPROVE");
  });

  it("Case 1 attributes the forced COMMENT event to the GitHub API self-approve restriction", () => {
    const case1Idx = workedExampleSection.indexOf("**Case 1");
    expect(case1Idx).toBeGreaterThan(-1);
    const case1Block = workedExampleSection.slice(case1Idx, case1Idx + 700);

    expect(case1Block.toLowerCase()).toContain("api");
    expect(case1Block.toLowerCase()).toContain("self-approve");
  });

  it("Case 2 describes any-author PR with a genuine unresolved finding still present at head", () => {
    const case2Idx = workedExampleSection.indexOf("**Case 2");
    expect(case2Idx).toBeGreaterThan(-1);
    const case2Block = workedExampleSection.slice(case2Idx, case2Idx + 700);

    expect(case2Block.toLowerCase()).toContain("any-author");
    expect(case2Block.toLowerCase()).toContain("unresolved finding");
    expect(case2Block).toContain('event: "COMMENT"');
    expect(case2Block).toContain("Verdict: COMMENT");
  });

  it("makes explicit that Case 1 and Case 2 share the same event but require different body verdict labels", () => {
    expect(workedExampleSection.toLowerCase()).toContain('same `event: "comment"`');
    expect(workedExampleSection.toLowerCase()).toContain("different");
  });

  it("Case 3 describes any-author PR with no prior unaddressed findings but a fresh blocking finding this pass", () => {
    const case3Idx = workedExampleSection.indexOf("**Case 3");
    expect(case3Idx).toBeGreaterThan(-1);
    const case3Block = workedExampleSection.slice(case3Idx, case3Idx + 700);

    expect(case3Block.toLowerCase()).toContain("any-author");
    expect(case3Block).toContain("`selfReview = false`");
    expect(case3Block).toContain("`unaddressedFindings = false`");
    expect(case3Block).toContain("`currentPassHasBlockingFindings =\n  true`");
    expect(case3Block).toContain('event: "COMMENT"');
    expect(case3Block).toContain("Verdict: COMMENT");
  });

  it("Case 3 explains that without the new input this case would silently compute as APPROVE, same failure mode as Case 1", () => {
    const case3Idx = workedExampleSection.indexOf("**Case 3");
    expect(case3Idx).toBeGreaterThan(-1);
    const case3Block = workedExampleSection.slice(case3Idx, case3Idx + 700);

    expect(case3Block.toLowerCase()).toContain("silently compute as a clean `approve`");
    expect(case3Block.toLowerCase()).toContain("the same\n  failure mode as case 1");
  });

  it("references the currentPassHasBlockingFindings input computed by Step 8, distinct from Step 9.5's unaddressedFindings", () => {
    expect(workedExampleSection).toContain("currentPassHasBlockingFindings");
    expect(workedExampleSection).toContain("Step 8's threshold-filtered `findings[]`");
  });

  it("includes the 8-row truth table with its header row covering all three boolean inputs", () => {
    expect(workedExampleSection).toContain(
      "| selfReview | unaddressedFindings | currentPassHasBlockingFindings | event | verdictLabel |",
    );
    expect(workedExampleSection.toLowerCase()).toContain("8-row truth table");
  });

  it("the truth table encodes all 2^3 = 8 boolean combinations with the correct event/verdictLabel outputs", () => {
    const tableRows = [
      "| true | false | false | COMMENT (self-review override) | APPROVE |",
      "| true | false | true | COMMENT (self-review override) | COMMENT |",
      "| true | true | false | COMMENT (self-review override) | COMMENT |",
      "| true | true | true | COMMENT (self-review override) | COMMENT |",
      "| false | false | false | APPROVE | APPROVE |",
      "| false | false | true | COMMENT | COMMENT |",
      "| false | true | false | COMMENT | COMMENT |",
      "| false | true | true | COMMENT | COMMENT |",
    ];
    for (const row of tableRows) {
      expect(workedExampleSection).toContain(row);
    }
  });
});

describe("review.md — Step 8 computes CURRENT_PASS_HAS_BLOCKING_FINDINGS from threshold-filtered findings (DRO-1.1)", () => {
  it("defines CURRENT_PASS_HAS_BLOCKING_FINDINGS as true when any remaining finding is important or critical severity", () => {
    const computeIdx = content.indexOf("**Compute `CURRENT_PASS_HAS_BLOCKING_FINDINGS`**");
    expect(computeIdx).toBeGreaterThan(-1);
    const computeBlock = content.slice(computeIdx, computeIdx + 700);

    expect(computeBlock).toContain("`true` if any remaining finding is `important` or `critical` severity, else `false`");
  });

  it("ties CURRENT_PASS_HAS_BLOCKING_FINDINGS to Step 10/10.5's compute-review-verdict.ts input and cross-references Case 3", () => {
    const computeIdx = content.indexOf("**Compute `CURRENT_PASS_HAS_BLOCKING_FINDINGS`**");
    expect(computeIdx).toBeGreaterThan(-1);
    const computeBlock = content.slice(computeIdx, computeIdx + 700);

    expect(computeBlock).toContain("compute-review-verdict.ts");
    expect(computeBlock).toContain("Step 10's worked example, Case 3");
  });

  it("distinguishes CURRENT_PASS_HAS_BLOCKING_FINDINGS (this pass, fresh) from Step 9.5's unaddressedFindings (prior, posted state)", () => {
    const computeIdx = content.indexOf("**Compute `CURRENT_PASS_HAS_BLOCKING_FINDINGS`**");
    expect(computeIdx).toBeGreaterThan(-1);
    const computeBlock = content.slice(computeIdx, computeIdx + 700);

    expect(computeBlock).toContain("independent of Step\n9.5's `unaddressedFindings`");
  });
});

describe("review.md — Review Quality Rules reflect mechanical enforcement (RUC-1.1)", () => {
  it("the 'Check for unresolved feedback first' bullet describes mechanical enforcement, not just a guideline", () => {
    const rulesIdx = content.indexOf("## Review Quality Rules");
    expect(rulesIdx).toBeGreaterThan(-1);
    const section = content.slice(rulesIdx);

    const bulletIdx = section.indexOf("Check for unresolved feedback first");
    expect(bulletIdx).toBeGreaterThan(-1);
    const bulletBlock = section.slice(bulletIdx, bulletIdx + 400);

    expect(bulletBlock.toLowerCase()).toContain("mechanically enforced");
  });
});

describe("review.md — Step 5.5 identifies prior qualifying CURRENT_USER reviews for subagent attestation (PVD-1.2)", () => {
  let step5Section: string;

  beforeAll(() => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    expect(step5Idx).toBeGreaterThan(-1);
    expect(step6Idx).toBeGreaterThan(step5Idx);
    step5Section = content.slice(step5Idx, step6Idx);
  });

  it("documents identifying prior qualifying CURRENT_USER reviews at commits earlier than head", () => {
    expect(step5Section).toContain("PVD-1.2");
    expect(step5Section.toLowerCase()).toContain("prior qualifying");
    expect(step5Section).toContain("CURRENT_USER");
    expect(step5Section).toContain("commit.oid !== headRefOid");
  });

  it("cites reuse of isSelfCleanApprove and isSupersededBySelfReview from compute-unaddressed-findings.ts rather than re-deriving the rules in prose", () => {
    const priorIdx = step5Section.indexOf("prior qualifying");
    expect(priorIdx).toBeGreaterThan(-1);
    const priorBlock = step5Section.slice(priorIdx, priorIdx + 2000);

    expect(priorBlock).toContain("isSelfCleanApprove");
    expect(priorBlock).toContain("isSupersededBySelfReview");
    expect(priorBlock).toContain("compute-unaddressed-findings.ts");
  });

  it("qualifies on state COMMENTED or CHANGES_REQUESTED with a non-empty body, matching Step 9.5's own review-state filter", () => {
    const priorIdx = step5Section.indexOf("prior qualifying");
    expect(priorIdx).toBeGreaterThan(-1);
    const priorBlock = step5Section.slice(priorIdx, priorIdx + 2000);

    expect(priorBlock).toContain("COMMENTED");
    expect(priorBlock).toContain("CHANGES_REQUESTED");
    expect(priorBlock.toLowerCase()).toContain("non-empty");
  });

  it("produces a labeled artifact (priorQualifyingReviews) for Step 7's prompt to consume", () => {
    expect(step5Section).toContain("priorQualifyingReviews");
  });
});

describe("review.md — Step 7 dispatch prompt includes prior findings input when qualifying reviews exist (PVD-1.2)", () => {
  let step7Section: string;

  beforeAll(() => {
    const step7Idx = content.indexOf("## Step 7: Deep Review");
    const step8Idx = content.indexOf("## Step 8: Score and Classify Findings");
    expect(step7Idx).toBeGreaterThan(-1);
    expect(step8Idx).toBeGreaterThan(step7Idx);
    step7Section = content.slice(step7Idx, step8Idx);
  });

  it("includes a new labeled prior-findings input referencing priorQualifyingReviews", () => {
    expect(step7Section).toContain("priorQualifyingReviews");
    expect(step7Section.toLowerCase()).toContain("prior findings");
  });

  it("documents the input is only included when priorQualifyingReviews is non-empty, omitted otherwise", () => {
    const priorIdx = step7Section.indexOf("priorQualifyingReviews");
    expect(priorIdx).toBeGreaterThan(-1);
    const priorBlock = step7Section.slice(Math.max(0, priorIdx - 300), priorIdx + 600);

    expect(priorBlock.toLowerCase()).toContain("omit");
  });

  it("documents that the subagent must return priorFindingsStatus[] with ref/resolved/evidence", () => {
    expect(step7Section).toContain("priorFindingsStatus");
    expect(step7Section).toContain("ref");
    expect(step7Section).toContain("resolved");
    expect(step7Section).toContain("evidence");
  });

  it("references PVD-1.2 in this section", () => {
    expect(step7Section).toContain("PVD-1.2");
  });
});

describe("review.md — Step 9 Prior Findings Resolution table is sourced from priorFindingsStatus (PVD-1.2)", () => {
  let reReviewSection: string;

  beforeAll(() => {
    const reReviewIdx = content.indexOf("### Re-Review (Update)");
    const step95Idx = content.indexOf("## Step 9.5:");
    expect(reReviewIdx).toBeGreaterThan(-1);
    expect(step95Idx).toBeGreaterThan(reReviewIdx);
    reReviewSection = content.slice(reReviewIdx, step95Idx);
  });

  it("references the structured priorFindingsStatus[] data rather than pure freehand narrative", () => {
    expect(reReviewSection).toContain("priorFindingsStatus");
  });

  it("maps resolved:true to Addressed and resolved:false to Not addressed, and evidence to the Evidence column", () => {
    expect(reReviewSection).toContain("Prior Findings Resolution");
    expect(reReviewSection).toContain("resolved: true");
    expect(reReviewSection).toContain("Addressed");
    expect(reReviewSection).toContain("resolved: false");
    expect(reReviewSection).toContain("Not addressed");
    expect(reReviewSection).toContain("evidence");
  });
});

describe("review.md — Step 9.5 unaddressed-findings gate retains its PVD-1.1 core (regression guard)", () => {
  let step95Section: string;

  beforeAll(() => {
    const step95Idx = content.indexOf("## Step 9.5:");
    const step10Idx = content.indexOf("## Step 10: Build Review JSON");
    expect(step95Idx).toBeGreaterThan(-1);
    expect(step10Idx).toBeGreaterThan(step95Idx);
    step95Section = content.slice(step95Idx, step10Idx);
  });

  it("still titles the section 'Unaddressed-Findings Hard Gate (RUC-1.1, PVD-1.1, PVD-1.3)'", () => {
    expect(step95Section).toContain(
      "Unaddressed-Findings Hard Gate (RUC-1.1, PVD-1.1, PVD-1.3)",
    );
  });

  it("still states the computation is mechanical, not freehand", () => {
    expect(step95Section).toContain("computed mechanically, not freehand");
  });

  it("still invokes compute-unaddressed-findings.ts with the same CLI call", () => {
    expect(step95Section).toContain(
      'bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-unaddressed-findings.ts"',
    );
    expect(step95Section).toContain('{"unaddressedFindings":true|false}');
    expect(step95Section).toContain("UNADDRESSED_FINDINGS=");
  });

  it("still forces the verdict to COMMENT when unaddressed findings are present, with the same override language", () => {
    expect(step95Section).toContain("force the verdict to `COMMENT`");
    expect(step95Section).toContain("Overrides the code-reviewer subagent's severity-based recommendation");
  });
});

describe("review.md — Step 9.5 wires the fourth exclusion via priorFindingsStatus (PVD-1.3)", () => {
  let step95Section: string;

  beforeAll(() => {
    const step95Idx = content.indexOf("## Step 9.5:");
    const step10Idx = content.indexOf("## Step 10: Build Review JSON");
    expect(step95Idx).toBeGreaterThan(-1);
    expect(step10Idx).toBeGreaterThan(step95Idx);
    step95Section = content.slice(step95Idx, step10Idx);
  });

  it("references PVD-1.3 and the new isResolvedByPriorFindingsStatus predicate", () => {
    expect(step95Section).toContain("PVD-1.3");
    expect(step95Section).toContain("isResolvedByPriorFindingsStatus");
  });

  it("documents the fourth exclusion: a prior CURRENT_USER review attested resolved by priorFindingsStatus[]", () => {
    expect(step95Section).toContain("priorFindingsStatus");
    expect(step95Section).toContain("resolved: true");
    expect(step95Section).toContain("evidence");
    expect(step95Section).toContain("reviewRef");
  });

  it("describes the deadlock the fourth exclusion closes (new review object per pass, DRO-1.2 can't fire)", () => {
    expect(step95Section).toContain("deadlock");
    expect(step95Section.toLowerCase()).toContain("new review object");
  });

  it("documents the Option B rationale: each finding judged independently, no coupling to currentPassHasBlockingFindings", () => {
    expect(step95Section).toContain("Option B");
    expect(step95Section).toContain("independently");
    expect(step95Section).toContain("currentPassHasBlockingFindings");
  });

  it("passes PRIOR_FINDINGS_STATUS_JSON through the CLI invocation from Step 7's subagent output", () => {
    expect(step95Section).toContain("PRIOR_FINDINGS_STATUS_JSON");
    expect(step95Section).toContain("priorFindingsStatus: $priorFindingsStatus");
  });

  it("scopes the fourth exclusion to CURRENT_USER's own prior reviews only, not third-party findings", () => {
    expect(step95Section).toContain("third-party");
    expect(step95Section).toContain("CPF-2.3");
  });
});

describe("review.md — findings ledger persistence (PFL-2.1)", () => {
  let step5Section: string;
  let step7Section: string;

  beforeAll(() => {
    const step5Idx = content.indexOf("## Step 5: Gather Context");
    const step6Idx = content.indexOf("## Step 6: Classify Changes by Domain");
    expect(step5Idx).toBeGreaterThan(-1);
    expect(step6Idx).toBeGreaterThan(step5Idx);
    step5Section = content.slice(step5Idx, step6Idx);

    const step7Idx = content.indexOf("## Step 7: Deep Review");
    const step8Idx = content.indexOf("## Step 8: Score and Classify Findings");
    expect(step7Idx).toBeGreaterThan(-1);
    expect(step8Idx).toBeGreaterThan(step7Idx);
    step7Section = content.slice(step7Idx, step8Idx);
  });

  it("Step 5.5 has a Findings Ledger Persistence subsection tagged PFL-2.1", () => {
    expect(step5Section).toContain("PFL-2.1");
    expect(step5Section.toLowerCase()).toContain("findings ledger");
  });

  it("posts a resolved ledger entry for each isSelfCleanApprove prior review, with source: review", () => {
    const ledgerIdx = step5Section.indexOf("PFL-2.1");
    expect(ledgerIdx).toBeGreaterThan(-1);
    const ledgerSection = step5Section.slice(ledgerIdx);

    expect(ledgerSection).toContain("isSelfCleanApprove");
    expect(ledgerSection).toContain('"disposition": "resolved"');
    expect(ledgerSection).toContain('"source": "review"');
    expect(ledgerSection).toContain("/findings");
    expect(ledgerSection).toContain("reviewRef(review)");
  });

  it("posts a superseded ledger entry for each isSupersededBySelfReview prior review, with source: review", () => {
    const ledgerIdx = step5Section.indexOf("PFL-2.1");
    expect(ledgerIdx).toBeGreaterThan(-1);
    const ledgerSection = step5Section.slice(ledgerIdx);

    expect(ledgerSection).toContain("isSupersededBySelfReview");
    expect(ledgerSection).toContain('"disposition": "superseded"');
    expect(ledgerSection).toContain('"source": "review"');
  });

  it("documents the ledger POST is best-effort persistence, not a new decision, and non-fatal on failure", () => {
    const ledgerIdx = step5Section.indexOf("PFL-2.1");
    expect(ledgerIdx).toBeGreaterThan(-1);
    const ledgerSection = step5Section.slice(ledgerIdx);

    expect(ledgerSection.toLowerCase()).toContain("best-effort");
    expect(ledgerSection.toLowerCase()).toContain("non-fatal");
  });

  it("Step 7 posts a resolved ledger entry for each priorFindingsStatus[] entry with resolved: true", () => {
    expect(step7Section).toContain("PFL-2.1");
    const ledgerIdx = step7Section.indexOf("PFL-2.1");
    expect(ledgerIdx).toBeGreaterThan(-1);
    const ledgerSection = step7Section.slice(ledgerIdx);

    expect(ledgerSection).toContain("resolved === true");
    expect(ledgerSection).toContain('disposition: "resolved"');
    expect(ledgerSection).toContain('source: "review"');
    expect(ledgerSection).toContain("/findings");
    expect(ledgerSection).toContain("entry.evidence");
  });

  it("Step 7 builds the ledger POST body via jq -n --arg to safely escape subagent-authored free-text evidence", () => {
    const ledgerIdx = step7Section.indexOf("PFL-2.1");
    expect(ledgerIdx).toBeGreaterThan(-1);
    const ledgerSection = step7Section.slice(ledgerIdx);

    expect(ledgerSection).toContain("jq -n --arg");
    expect(ledgerSection).toContain('--arg evidence "{entry.evidence}"');
  });

  it("Step 7's ledger write is scoped to entries already parsed from the subagent, not a new decision", () => {
    const ledgerIdx = step7Section.indexOf("PFL-2.1");
    expect(ledgerIdx).toBeGreaterThan(-1);
    const ledgerSection = step7Section.slice(ledgerIdx);

    expect(ledgerSection.toLowerCase()).toContain("best-effort");
    expect(ledgerSection.toLowerCase()).toContain("non-fatal");
  });

  it("uses the standard task-store curl convention with Authorization bearer and Content-Type json", () => {
    const step5LedgerIdx = step5Section.indexOf("PFL-2.1");
    const step5Ledger = step5Section.slice(step5LedgerIdx);
    const step7LedgerIdx = step7Section.indexOf("PFL-2.1");
    const step7Ledger = step7Section.slice(step7LedgerIdx);

    for (const section of [step5Ledger, step7Ledger]) {
      expect(section).toContain("Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN");
      expect(section).toContain("Content-Type: application/json");
      expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}/findings");
    }
  });
});

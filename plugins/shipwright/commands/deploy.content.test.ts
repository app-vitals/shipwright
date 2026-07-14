import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEPLOY_MD_PATH = join(import.meta.dir, "deploy.md");

let content: string;

beforeAll(() => {
  content = readFileSync(DEPLOY_MD_PATH, "utf-8");
});

describe("deploy.md — own-PRs-only check (AC1 & AC2)", () => {
  it("contains own GH login check (AGENT_LOGIN or 'own GH login')", () => {
    const hasAgentLogin = content.includes("AGENT_LOGIN");
    const hasOwnGhLogin = content.includes("own GH login");
    expect(hasAgentLogin || hasOwnGhLogin).toBe(true);
  });

  it("contains PR_AUTHOR check to identify who authored the PR", () => {
    expect(content).toContain("PR_AUTHOR");
  });

  it("states that PRs authored by others are skipped silently", () => {
    const hasSkipSilently =
      content.includes("skip it silently") || content.includes("skip silently");
    expect(hasSkipSilently).toBe(true);
  });
});

describe("deploy.md — no-pipeline detection (AC3 & AC4)", () => {
  it("polls for Deploy workflow for up to 5 minutes after merge", () => {
    // Must mention 5 minutes in the context of no-pipeline detection
    const has5MinPoll =
      content.includes("5 minutes") || content.includes("5-minute");
    expect(has5MinPoll).toBe(true);
  });

  it("prints 'No Deploy workflow' message when no pipeline fires", () => {
    expect(content).toContain("No Deploy workflow");
  });

  it("marks task deployed and exits cleanly when no pipeline fires", () => {
    const hasNoPipelineExit =
      content.includes("no_pipeline") ||
      content.includes("no pipeline") ||
      content.includes("no deploy pipeline");
    expect(hasNoPipelineExit).toBe(true);
  });
});

describe("deploy.md — full 30-minute watch (AC5)", () => {
  it("still runs the full 30-minute pipeline watch when Deploy workflow IS detected", () => {
    const has30Min =
      content.includes("30-minute") ||
      content.includes("30 minutes") ||
      content.includes("Budget: 30 minutes");
    expect(has30Min).toBe(true);
  });
});

describe("deploy.md — PR upsert on merge (PRI-2.4)", () => {
  it("contains POST /prs/claim to create or claim PR record", () => {
    const hasClaimCall =
      content.includes("/prs/claim") || content.includes("prs/claim");
    expect(hasClaimCall).toBe(true);
  });

  it("passes repo, prNumber, and commitSha (SQUASH_SHA) to POST /prs/claim", () => {
    const hasRepo =
      (content.includes('"repo"') || content.includes("repo")) &&
      content.includes("{org}/{repo}");
    const hasPrNumber =
      (content.includes('"prNumber"') || content.includes("prNumber")) &&
      (content.includes("{pr}") || content.includes("prNumber"));
    const hasCommitSha =
      (content.includes('"commitSha"') || content.includes("commitSha")) &&
      content.includes("SQUASH_SHA");
    expect(hasRepo && hasPrNumber && hasCommitSha).toBe(true);
  });

  it("contains PATCH /prs/:id with state=merged to mark PR as merged", () => {
    const hasPatchCall = content.includes("/prs/");
    const hasStateMerged =
      content.includes("state") &&
      (content.includes("merged") || content.includes('merged"'));
    expect(hasPatchCall && hasStateMerged).toBe(true);
  });

  it("includes mergedAt timestamp in PATCH request", () => {
    const hasMergedAt =
      content.includes('"mergedAt"') ||
      content.includes("mergedAt") ||
      content.includes("mergedAt:");
    expect(hasMergedAt).toBe(true);
  });

  it("includes reviewState=approved in PATCH request", () => {
    const hasReviewState =
      content.includes("reviewState") && content.includes("approved");
    expect(hasReviewState).toBe(true);
  });

  it("warns and continues if PR upsert fails", () => {
    const hasWarning =
      content.includes("⚠") ||
      content.includes("warn") ||
      content.includes("Failed to upsert");
    expect(hasWarning).toBe(true);
  });

  it("extracts PR_RECORD_ID from POST /prs/claim response", () => {
    const hasPrRecordId =
      content.includes("PR_RECORD_ID") || content.includes("pr_record_id");
    expect(hasPrRecordId).toBe(true);
  });
});

describe("deploy.md — self-approve bold-markdown strip (PCK-1.4)", () => {
  it("Step 3a's AGENT_LOGIN self-approval check strips leading ** before the comparison", () => {
    const step3aMatch = content.match(
      /### 3a\. Verify PR Approval[\s\S]*?(?=### 3b)/,
    );
    expect(step3aMatch).not.toBeNull();
    const step3aSection = step3aMatch?.[0] ?? "";
    expect(step3aSection).toContain('sub("^\\\\*+";"")');
    expect(step3aSection.toLowerCase()).toContain("strip");
  });

  it("Step 3a's prose describes stripping leading bold markers before startsWith(\"APPROVE\")", () => {
    const step3aMatch = content.match(
      /### 3a\. Verify PR Approval[\s\S]*?(?=### 3b)/,
    );
    const step3aSection = step3aMatch?.[0] ?? "";
    expect(step3aSection).toContain('startsWith("APPROVE")');
  });
});

describe("deploy.md — scan mode removed (WLS-3.4)", () => {
  it("does not contain a Step 1 Scan Mode section", () => {
    expect(content).not.toContain("Scan Mode");
    expect(content).not.toContain("## Step 1");
  });

  it("does not reference CANDIDATE_LIST or scan-mode candidate fallback", () => {
    expect(content).not.toContain("CANDIDATE_LIST");
    expect(content.toLowerCase()).not.toContain("scan mode");
  });

  it("states $ARGUMENTS is required and no-argument invocation responds [silent]", () => {
    const argsMatch = content.match(/## Arguments[\s\S]*?(?=---)/);
    expect(argsMatch).not.toBeNull();
    const argsSection = argsMatch?.[0] ?? "";
    expect(argsSection).toContain("required");
    expect(argsSection).toContain("[silent]");
  });
});

describe("deploy.md — pre-merge PR claim lock (CLM-2.2)", () => {
  it("claims the PR record (phase: deploy) before the gh pr merge call", () => {
    // The pre-merge claim must appear BEFORE the merge command in Step 4.
    // Format-independent: matches the claim call site and the merge command
    // literally, rather than a bash-escaped JSON body fragment that would
    // break silently if the claim body's quoting style changed.
    const claimIdx = content.indexOf("/prs/claim");
    const mergeIdx = content.indexOf("gh pr merge {pr}");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeLessThan(mergeIdx);
  });

  it("skips the merge and does not call gh pr merge when the claim returns 409", () => {
    const hasConflictHandling =
      content.includes("PR_CLAIM") &&
      (content.includes('"409"') || content.includes("409"));
    const hasSkipLanguage =
      content.includes("do NOT merge") || content.includes("skipping");
    expect(hasConflictHandling).toBe(true);
    expect(hasSkipLanguage).toBe(true);
  });

  it("post-merge upsert reuses PR_RECORD_ID from the pre-merge claim (plain PATCH, no redundant claim)", () => {
    // The post-merge section should PATCH the already-claimed record rather than
    // issuing a second POST /prs/claim call.
    const postMergeSectionIdx = content.indexOf("Update PullRequest Record (post-merge)");
    expect(postMergeSectionIdx).toBeGreaterThan(-1);
    const postMergeSection = content.slice(postMergeSectionIdx, postMergeSectionIdx + 1500);
    expect(postMergeSection.includes("/prs/claim")).toBe(false);
    expect(postMergeSection.includes("/prs/$PR_RECORD_ID")).toBe(true);
  });

  it("releases the pre-merge claim if the merge does not complete within 60 seconds", () => {
    // A stuck/timed-out merge must not leave the phase: "deploy" claim dangling —
    // otherwise a retry within the claim TTL hits a spurious 409.
    const timeoutIdx = content.indexOf("did not complete within 60 seconds");
    expect(timeoutIdx).toBeGreaterThan(-1);
    const beforeTimeout = content.slice(0, timeoutIdx);
    const releaseIdx = beforeTimeout.lastIndexOf("/prs/$PR_RECORD_ID/release");
    expect(releaseIdx).toBeGreaterThan(-1);
    // The release call must come after the pre-merge claim and before the timeout message
    const claimIdx = content.indexOf("/prs/claim");
    expect(releaseIdx).toBeGreaterThan(claimIdx);
  });
});

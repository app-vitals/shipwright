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

describe("deploy.md — pre-merge PR claim lock (CLM-2.2)", () => {
  it("claims the PR record (phase: deploy) before the gh pr merge call", () => {
    // The pre-merge claim must appear BEFORE the merge command in Step 4
    const claimIdx = content.indexOf('\\"phase\\": \\"deploy\\"');
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

  it("on 409 in scan mode, moves to the next candidate; ends the run if none remain", () => {
    expect(content).toContain("CANDIDATE_LIST");
    expect(content).toContain("next candidate");
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
});

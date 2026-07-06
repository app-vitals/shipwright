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
  it("Step 1a's jq check strips leading ** before startswith(\"APPROVE\")", () => {
    // Must apply a jq sub() (or equivalent) that strips leading markdown bold
    // markers from the review body before the startswith("APPROVE") check —
    // mirroring check-deploy.ts's hasSelfApproveReview strip.
    const step1aMatch = content.match(
      /1a\. Find Qualifying PRs[\s\S]*?(?=###|## Step 2)/,
    );
    expect(step1aMatch).not.toBeNull();
    const step1aSection = step1aMatch?.[0] ?? "";
    expect(step1aSection).toContain('sub("^\\\\*+";"")');
    expect(step1aSection).toContain('startswith("APPROVE")');
  });

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

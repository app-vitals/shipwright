import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MERGE_MD_PATH = join(import.meta.dir, "merge.md");

let content: string;

beforeAll(() => {
  content = readFileSync(MERGE_MD_PATH, "utf-8");
});

describe("merge.md — frontmatter", () => {
  it("has a description and argument-hint in frontmatter", () => {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = frontmatterMatch?.[1] ?? "";
    expect(frontmatter).toContain("description:");
    expect(frontmatter).toContain("argument-hint:");
    expect(frontmatter).toContain("[org/repo#number | number]");
  });

  it("title is '# Merge'", () => {
    expect(content).toContain("# Merge");
  });

  it("scopes the command to merge-only — no canary/promote", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("canary");
    expect(lower).toContain("promote");
    // The intro should explicitly state it does NOT run those stages.
    expect(content).toMatch(/does not run|not run|no canary|does NOT run/i);
  });

  it("runs autonomously without pausing for user input unless pre-flight fails", () => {
    expect(content).toContain(
      "This command runs autonomously. Do not pause for user input unless pre-flight fails.",
    );
  });

  it("documents task store setup blurb", () => {
    expect(content).toContain("SHIPWRIGHT_TASK_STORE_URL");
    expect(content).toContain("SHIPWRIGHT_TASK_STORE_TOKEN");
    expect(content).toContain("/shipwright:task-store");
  });
});

describe("merge.md — Arguments section (AC1)", () => {
  function extractArgsSection(md: string): string {
    const match = md.match(/## Arguments[\s\S]*?(?=\n---)/);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  it("requires $ARGUMENTS and documents org/repo#number and bare number forms", () => {
    const section = extractArgsSection(content);
    expect(section).toContain("$ARGUMENTS");
    expect(section).toContain("org/repo#number");
    expect(section).toContain("number");
    expect(section).toContain("required");
  });

  it("infers org/repo from agent config for bare numbers, defaulting to app-vitals/shipwright", () => {
    const section = extractArgsSection(content);
    expect(section).toContain("SHIPWRIGHT_AGENT_API_KEY");
    expect(section).toContain("SHIPWRIGHT_AGENT_ID");
    expect(section).toContain("app-vitals/shipwright");
  });

  it("responds [silent] and stops with no arguments", () => {
    const section = extractArgsSection(content);
    expect(section).toContain("[silent]");
  });

  it("does NOT document a [preclaim:...] marker — merge has no candidate-provider wiring", () => {
    expect(content).not.toContain("[preclaim:{recordId}:{commitSha}]");
    expect(content).not.toContain("PRECLAIM_RECORD_ID");
    expect(content).not.toContain("formatPreClaimMarker");
  });
});

describe("merge.md — Step 1: Resolve Target PR (own-PRs-only + bundle gate)", () => {
  it("looks up the task via /tasks?pr={pr}", () => {
    expect(content).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks?pr=");
  });

  it("falls back to merge-only mode language when no task is found", () => {
    expect(content.toLowerCase()).toContain("merge-only mode");
  });

  it("contains own GH login check (AGENT_LOGIN) and PR_AUTHOR comparison", () => {
    expect(content).toContain("AGENT_LOGIN");
    expect(content).toContain("PR_AUTHOR");
    const hasSkipSilently =
      content.includes("skip it silently") || content.includes("skip silently");
    expect(hasSkipSilently).toBe(true);
  });

  it("prints a MERGE: header, not DEPLOY:", () => {
    expect(content).toContain("MERGE: PR #{pr}");
    expect(content).not.toContain("DEPLOY: PR #{pr}");
  });

  it("has a Bundle Completeness Gate section with merge-scoped skip-reason marker", () => {
    const match = content.match(
      /### 1b\. Bundle Completeness Gate[\s\S]*?(?=\n---|\n## )/,
    );
    expect(match).not.toBeNull();
    const section = match?.[0] ?? "";
    expect(section).toContain("[silent]");
    expect(section).toContain("[skip-reason:merge:bundle-incomplete:{HEAD_BRANCH}]");
    expect(section).toContain("pending");
    expect(section).toContain("in_progress");
    expect(section).toContain("blocked");
  });
});

describe("merge.md — Step 2: Pre-flight Checks", () => {
  function extractStep2Section(md: string): string {
    const match = md.match(
      /## Step 2: Pre-flight Checks[\s\S]*?(?=\n## Step 3)/,
    );
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  it("verifies PR approval via GitHub reviewDecision or clean self-review APPROVE body", () => {
    const section = extractStep2Section(content);
    expect(section).toContain("reviewDecision");
    expect(section).toContain("APPROVED");
    expect(section).toContain("allow_self_review");
    expect(section).toContain("agent-policy.md");
    expect(section).toContain('startsWith("APPROVE")');
    expect(section).toContain("Verdict: APPROVE".toLowerCase() === "verdict: approve" ? "verdict" : "verdict");
  });

  it("strips leading bold markdown markers before comparing the self-review body", () => {
    const section = extractStep2Section(content);
    expect(section).toContain('sub("^\\\\*+";"")');
  });

  it("verifies CI is green on the PR head commit", () => {
    const section = extractStep2Section(content);
    expect(section).toContain("headRefOid");
    expect(section).toContain('.name == "CI"');
    expect(section).toContain('conclusion == "success"');
  });

  it("has a pre-flight summary subsection", () => {
    const section = extractStep2Section(content);
    expect(section).toContain("Pre-flight");
    expect(section).toContain("Pre-flight passed");
  });

  it("fails with a clear message when the PR is not approved", () => {
    const section = extractStep2Section(content);
    expect(section).toContain("not approved");
  });

  it("fails with a clear message when CI is not green", () => {
    const section = extractStep2Section(content);
    expect(section).toContain("CI is not green");
  });
});

describe("merge.md — Step 3: Merge (claim, squash-merge, task-store update)", () => {
  function extractStep3Section(md: string): string {
    const match = md.match(/## Step 3: Merge[\s\S]*?(?=\n## Step 4)/);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  it("claims the PR record under phase: deploy (reusing the existing PrPhase enum value)", () => {
    const section = extractStep3Section(content);
    expect(section).toContain("/prs/claim");
    expect(section).toContain('\\"phase\\": \\"deploy\\"');
  });

  it("does not introduce a new 'merge' PrPhase enum value in the claim body", () => {
    const section = extractStep3Section(content);
    expect(section).not.toContain('\\"phase\\": \\"merge\\"');
    expect(section).not.toContain('"phase": "merge"');
  });

  it("claim call appears before the gh pr merge call", () => {
    const claimIdx = content.indexOf("/prs/claim");
    const mergeIdx = content.indexOf("gh pr merge {pr}");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeLessThan(mergeIdx);
  });

  it("skips the merge and does not merge when the claim returns 409", () => {
    const section = extractStep3Section(content);
    expect(section).toContain("409");
    const hasSkipLanguage =
      section.includes("do NOT merge") || section.includes("skipping");
    expect(hasSkipLanguage).toBe(true);
  });

  it("squash-merges with --admin", () => {
    const section = extractStep3Section(content);
    expect(section).toContain(
      "gh pr merge {pr} --repo {org}/{repo} --squash --admin",
    );
  });

  it("polls for MERGED state for up to 60 seconds", () => {
    const section = extractStep3Section(content);
    expect(section).toContain("60 seconds");
    expect(section).toContain("MERGED");
  });

  it("releases the pre-merge claim on a merge timeout without blocking task status", () => {
    const section = extractStep3Section(content);
    expect(section).toContain("/release");
    expect(section.toLowerCase()).toContain("do not patch the task");
    expect(section).not.toContain('"status": "blocked"');
  });

  it("PATCHes the task to status: merged with mergedAt", () => {
    const section = extractStep3Section(content);
    expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID");
    expect(section).toContain("merged");
    expect(section).toContain("mergedAt");
  });

  it("updates the PullRequest record post-merge with state=merged, mergedAt, reviewState=approved, commitSha", () => {
    const section = extractStep3Section(content);
    const postMergeIdx = section.indexOf(
      "Update PullRequest Record (post-merge)",
    );
    expect(postMergeIdx).toBeGreaterThan(-1);
    const postMergeSection = section.slice(postMergeIdx, postMergeIdx + 1200);
    expect(postMergeSection).toContain("/prs/$PR_RECORD_ID");
    expect(postMergeSection).toContain("merged");
    expect(postMergeSection).toContain("mergedAt");
    expect(postMergeSection).toContain("reviewState");
    expect(postMergeSection).toContain("approved");
    expect(postMergeSection).toContain("SQUASH_SHA");
    // Not a redundant claim call.
    expect(postMergeSection.includes("/prs/claim")).toBe(false);
  });

  it("rationale for --admin bypass being safe is preserved", () => {
    const section = extractStep3Section(content);
    expect(section.toLowerCase()).toContain("bypass");
  });
});

describe("merge.md — Step 4: Print Handoff", () => {
  it("has a terminal handoff block with MERGED, PR, and SHA lines", () => {
    const match = content.match(/## Step 4: Print Handoff[\s\S]*$/);
    expect(match).not.toBeNull();
    const section = match?.[0] ?? "";
    expect(section).toContain("MERGED:");
    expect(section).toContain("PR:");
    expect(section).toContain("SHA:");
  });
});

describe("merge.md — out of scope: no deploy/canary/promote pipeline logic", () => {
  it("does not contain canary revert-PR logic", () => {
    expect(content).not.toContain("CANARY FAILED");
    expect(content).not.toContain("revert/canary-");
  });

  it("does not contain a health probe step", () => {
    expect(content.toLowerCase()).not.toContain("health check");
    expect(content).not.toContain("/health");
  });

  it("does not poll for Deploy/Canary/Promote workflow runs", () => {
    expect(content).not.toContain("Promote to Prod");
    expect(content).not.toContain("ARC desync");
  });

  it("does not mark the task status as deploying/deployed", () => {
    expect(content).not.toContain('"status": "deploying"');
    expect(content).not.toContain('"status": "deployed"');
  });
});

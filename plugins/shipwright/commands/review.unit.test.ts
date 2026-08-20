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

  it("still contains the reviewedCommitSha/headRefOid dedup check for the explicit target PR", () => {
    const dedupIdx = content.indexOf(
      "Check if the PR was already reviewed at the current commit",
    );
    expect(dedupIdx).toBeGreaterThan(-1);
    const dedupSection = content.slice(dedupIdx, dedupIdx + 1500);
    expect(dedupSection.includes("record.reviewedCommitSha")).toBe(true);
    expect(dedupSection.includes("headRefOid")).toBe(true);
  });

  it("claim 409 responds [silent] and stops, with no retry against a different PR", () => {
    const claimIdx = content.indexOf("### Claim using pre-captured commit SHA");
    expect(claimIdx).toBeGreaterThan(-1);
    const claimSection = content.slice(claimIdx, claimIdx + 1600);
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

describe("review.md — RPF-1.4 verify review post before complete", () => {
  let autoPostSection: string;

  beforeAll(() => {
    const startIdx = content.indexOf("### If `auto_post_reviews` is true (default):");
    const endIdx = content.indexOf("### If `auto_post_reviews` is false (staged):");
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    autoPostSection = content.slice(startIdx, endIdx);
  });

  it("checks that the GitHub post succeeded before proceeding to Step 11b", () => {
    // Must reference checking success (exit status / html_url) before invoking Step 11b
    const step11bIdx = autoPostSection.indexOf("Step 11b");
    expect(step11bIdx).toBeGreaterThan(-1);
    const beforeStep11b = autoPostSection.slice(0, step11bIdx);
    expect(beforeStep11b.toLowerCase()).toMatch(/success|succeed|failed|failure|exit/);
    expect(beforeStep11b.includes("html_url")).toBe(true);
  });

  it("on post failure, calls POST /prs/{PR_RECORD_ID}/release instead of Step 11b", () => {
    expect(autoPostSection.includes("/release")).toBe(true);
  });

  it("on post failure, does not proceed to Step 11b", () => {
    const failureIdx = autoPostSection.toLowerCase().indexOf("**failure**");
    expect(failureIdx).toBeGreaterThan(-1);
    // Scope the release-call search to after the failure marker: RHR-1.1 added an
    // earlier, unrelated /release call (freshness-abort path) before this branch, so a
    // plain autoPostSection-wide indexOf would find that one instead of this branch's.
    const releaseIdx = autoPostSection.indexOf("/release", failureIdx);
    expect(releaseIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(failureIdx);
    // The failure branch must explicitly say to stop instead of running Step 11b
    const failureBranch = autoPostSection.slice(failureIdx, releaseIdx + 500);
    expect(failureBranch.includes("do not proceed to Step 11b")).toBe(true);
  });

  it("the success path still runs Step 11b, unchanged in behavior", () => {
    expect(autoPostSection.includes("Run Step 11b to mark the PR record posted")).toBe(
      true,
    );
  });
});

describe("review.md — RHR-1.1 review-post freshness re-check", () => {
  let autoPostSection: string;

  beforeAll(() => {
    const startIdx = content.indexOf("### If `auto_post_reviews` is true (default):");
    const endIdx = content.indexOf("### If `auto_post_reviews` is false (staged):");
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    autoPostSection = content.slice(startIdx, endIdx);
  });

  it("re-fetches headRefOid and compares against the canonical headRefOid variable before the POST call", () => {
    const postIdx = autoPostSection.indexOf("gh api -X POST");
    expect(postIdx).toBeGreaterThan(-1);
    const beforePost = autoPostSection.slice(0, postIdx);

    // Must re-fetch via gh pr view ... headRefOid before the POST call.
    expect(beforePost).toMatch(/gh pr view [^\n]*headRefOid/);
    // Must compare the fresh value against the existing canonical `headRefOid`
    // variable — not a newly-named variable standing in as a second source of truth.
    expect(beforePost).toContain("$headRefOid");
  });

  it("comes after the hard-gate validation (Step 10.5) and before the POST call", () => {
    const step105Idx = content.indexOf("### Step 10.5: Hard-Gate Validation (Before Posting)");
    const postIdx = content.indexOf("gh api -X POST /repos/{org}/{repo}/pulls/{pr}/reviews");
    const refetchIdx = content.indexOf("currentHeadRefOid");
    expect(step105Idx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(-1);
    expect(refetchIdx).toBeGreaterThan(-1);
    expect(refetchIdx).toBeGreaterThan(step105Idx);
    expect(refetchIdx).toBeLessThan(postIdx);
  });

  it("on mismatch, does not POST, releases the claim via /prs/{id}/release, and prints an abort message naming both SHAs", () => {
    const refetchIdx = autoPostSection.indexOf("currentHeadRefOid");
    expect(refetchIdx).toBeGreaterThan(-1);
    const postIdx = autoPostSection.indexOf("gh api -X POST");
    expect(postIdx).toBeGreaterThan(refetchIdx);

    const mismatchSection = autoPostSection.slice(refetchIdx, postIdx);
    expect(mismatchSection).toContain("/release");
    expect(mismatchSection).toContain("Aborted stale review for");
  });

  it("the abort message references both the old and new short SHAs", () => {
    const messageIdx = autoPostSection.indexOf("Aborted stale review for");
    expect(messageIdx).toBeGreaterThan(-1);
    const messageLine = autoPostSection.slice(messageIdx, messageIdx + 200);
    expect(messageLine).toMatch(/head moved/i);
  });

  it("the freshness re-check precedes Step 11b in file order", () => {
    const refetchIdx = content.indexOf("currentHeadRefOid");
    const step11bIdx = content.indexOf("## Step 11b: Mark PullRequest Record Posted");
    expect(refetchIdx).toBeGreaterThan(-1);
    expect(step11bIdx).toBeGreaterThan(-1);
    expect(refetchIdx).toBeLessThan(step11bIdx);
  });

  it("explicitly stops before the record-completion step on mismatch", () => {
    const refetchIdx = autoPostSection.indexOf("currentHeadRefOid");
    expect(refetchIdx).toBeGreaterThan(-1);
    const postIdx = autoPostSection.indexOf("gh api -X POST");
    const mismatchSection = autoPostSection.slice(refetchIdx, postIdx);
    expect(mismatchSection).toMatch(/stop/i);
    expect(mismatchSection).toContain("record-completion");
  });

  it("on match, the flow continues unmodified into the existing POST step", () => {
    // The existing POST call, its exit-code capture, and its comment about never
    // re-executing the POST must still be present and reachable on the match branch.
    expect(autoPostSection.includes("gh api -X POST /repos/{org}/{repo}/pulls/{pr}/reviews")).toBe(
      true,
    );
    expect(autoPostSection.includes("Never re-execute this POST.")).toBe(true);
    expect(autoPostSection.includes("POST_EXIT=0")).toBe(true);
  });

  it("does not introduce a second canonical headRefOid capture point — Step 4 and Step 14 remain the sole capture sites", () => {
    // The canonical variable is captured via `gh pr view ... --json headRefOid -q '.headRefOid'`.
    // Count occurrences of this exact capture pattern across the whole file; RHR-1.1's
    // addition must reuse a differently-named variable (currentHeadRefOid) for its own
    // re-fetch rather than reassigning `headRefOid` a third time via the same pattern.
    const captureRegex = /headRefOid=\$\(gh pr view [^\n]*--json headRefOid -q '\.headRefOid'\)/g;
    const matches = content.match(captureRegex) ?? [];
    // Step 4 and Step 14's Pre-Claim Fast Path both use this exact pattern already;
    // RHR-1.1 must not add a third occurrence assigning to `headRefOid` itself.
    expect(matches.length).toBe(2);
  });
});

describe("review.md — RVD-1.2 live-review pre-check regex parity", () => {
  const CHECK_HELPERS_PATH = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "agent",
    "src",
    "check-helpers.ts",
  );

  it("bash jq regex in Step 14's Live-Review Pre-Check matches check-helpers.ts's VERDICT_TERMINAL_LABEL", () => {
    const checkHelpersSource = readFileSync(CHECK_HELPERS_PATH, "utf-8");

    const tsMatch = checkHelpersSource.match(
      /export const VERDICT_TERMINAL_LABEL =\s*\/(.*)\/i;/,
    );
    expect(tsMatch).not.toBeNull();
    const tsPattern = tsMatch?.[1] ?? "";
    expect(tsPattern.length).toBeGreaterThan(0);

    const preCheckIdx = content.indexOf("### Live-Review Pre-Check (RVD-1.2)");
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    expect(preCheckIdx).toBeGreaterThan(-1);
    expect(fastPathIdx).toBeGreaterThan(preCheckIdx);
    const section = content.slice(preCheckIdx, fastPathIdx);

    const jqMatch = section.match(/test\("([^"]+)";\s*"i"\)/);
    expect(jqMatch).not.toBeNull();
    const jqPattern = jqMatch?.[1] ?? "";
    expect(jqPattern.length).toBeGreaterThan(0);

    // The jq pattern lives inside a single-quoted bash heredoc string, so a
    // literal backslash must be doubled (`\\`) to survive jq's own string
    // parsing. Normalize that back down to a single backslash to compare
    // against the TS regex literal's source text.
    const normalizedJqPattern = jqPattern.replace(/\\\\/g, "\\");

    expect(normalizedJqPattern).toBe(tsPattern);
  });
});

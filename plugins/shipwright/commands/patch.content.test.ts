import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATCH_MD_PATH = join(import.meta.dir, "patch.md");

let content: string;

beforeAll(() => {
  content = readFileSync(PATCH_MD_PATH, "utf-8");
});

describe("patch.md — explicit-target-only argument contract (WLS-3.3)", () => {
  it("frontmatter declares argument-hint as required (angle brackets, not optional brackets)", () => {
    const frontmatterEnd = content.indexOf("---", 3);
    const frontmatter = content.slice(0, frontmatterEnd);
    expect(frontmatter).toContain('argument-hint: "<org/repo#number>"');
    expect(frontmatter).not.toContain('argument-hint: "[org/repo#number]"');
  });

  it("states the org/repo#number argument is required in prose", () => {
    expect(content).toMatch(/org\/repo#number.{0,60}required|required.{0,60}org\/repo#number/is);
  });

  it("no-argument invocation responds [silent] and stops with no GitHub scan", () => {
    expect(content).toContain("If `$ARGUMENTS` is empty");
    const step0Idx = content.indexOf("## Step 0: Require Explicit Target");
    const step1Idx = content.indexOf("## Step 1: Get Own GH Login");
    expect(step0Idx).toBeGreaterThan(-1);
    expect(step1Idx).toBeGreaterThan(-1);
    const step0Section = content.slice(step0Idx, step1Idx);
    expect(step0Section).toContain("[silent]");
  });

  it("removes the multi-repo self-scan (gh pr list --author across configured repos)", () => {
    expect(content).not.toContain("Discover Own Open PRs");
    expect(content).not.toContain("Otherwise (no arguments)");
    expect(content).not.toContain(
      'gh pr list --state open --repo {org}/{repo} \\\n  --author "$CURRENT_USER"',
    );
    expect(content).not.toContain("No own open PRs found.");
  });

  it("Step 2 fetches the single target PR via gh pr view instead of scanning", () => {
    const step2Idx = content.indexOf("## Step 2: Resolve Target PR");
    expect(step2Idx).toBeGreaterThan(-1);
    const step2_5Idx = content.indexOf("## Step 2.5:");
    const step2Section = content.slice(step2Idx, step2_5Idx);
    expect(step2Section).toContain("gh pr view {number} --repo {org}/{repo}");
    expect(step2Section).toContain("author.login != CURRENT_USER");
  });
});

describe("patch.md — pre-work PR claim lock (CLM-2.1)", () => {
  it("Step 4 (merge conflicts): claims the PR (phase: patch) before dispatching the conflict-resolution subagent", () => {
    const step4bIdx = content.indexOf("### Step 4b: Dispatch Conflict Resolution Subagent");
    expect(step4bIdx).toBeGreaterThan(-1);
    const preStep4b = content.slice(0, step4bIdx);
    const lastClaimBeforeStep4b = preStep4b.lastIndexOf("/prs/claim");
    expect(lastClaimBeforeStep4b).toBeGreaterThan(-1);
    // The nearest preceding claim call must carry phase: "patch"
    const claimSnippet = preStep4b.slice(lastClaimBeforeStep4b, lastClaimBeforeStep4b + 400);
    expect(claimSnippet).toContain("phase");
    expect(claimSnippet).toContain("patch");
  });

  it("Step 5 (review findings): claims the PR (phase: patch) before dispatching the fix subagent", () => {
    const step5a6Idx = content.indexOf("### Step 5a.6:");
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    expect(step5a6Idx).toBeGreaterThan(-1);
    expect(step5bIdx).toBeGreaterThan(-1);
    const preStep5b = content.slice(step5a6Idx, step5bIdx);
    const lastClaimBeforeStep5b = preStep5b.lastIndexOf("/prs/claim");
    expect(lastClaimBeforeStep5b).toBeGreaterThan(-1);
    // The nearest preceding claim call must carry phase: "patch"
    const claimSnippet = preStep5b.slice(lastClaimBeforeStep5b, lastClaimBeforeStep5b + 400);
    expect(claimSnippet).toContain("phase");
    expect(claimSnippet).toContain("patch");
  });

  it("Step 6 (failing CI): claims the PR (phase: patch) before dispatching the CI-fix subagent", () => {
    const step6b5Idx = content.indexOf("### Step 6b.5:");
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    expect(step6b5Idx).toBeGreaterThan(-1);
    expect(step6cIdx).toBeGreaterThan(-1);
    const preStep6c = content.slice(step6b5Idx, step6cIdx);
    const lastClaimBeforeStep6c = preStep6c.lastIndexOf("/prs/claim");
    expect(lastClaimBeforeStep6c).toBeGreaterThan(-1);
    // The nearest preceding claim call must carry phase: "patch"
    const claimSnippet = preStep6c.slice(lastClaimBeforeStep6c, lastClaimBeforeStep6c + 400);
    expect(claimSnippet).toContain("phase");
    expect(claimSnippet).toContain("patch");
  });

  it("all three pre-work claims occur before their respective dispatch points (ordering)", () => {
    const claimIndices: number[] = [];
    let searchFrom = 0;
    for (;;) {
      const idx = content.indexOf("/prs/claim", searchFrom);
      if (idx === -1) break;
      claimIndices.push(idx);
      searchFrom = idx + 1;
    }
    const step4bIdx = content.indexOf("### Step 4b: Dispatch Conflict Resolution Subagent");
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");

    expect(claimIndices.some((i) => i < step4bIdx)).toBe(true);
    expect(claimIndices.some((i) => i < step5bIdx)).toBe(true);
    expect(claimIndices.some((i) => i < step6cIdx)).toBe(true);
  });

  it("409 handling causes the PR to be skipped and the next candidate in the list to be tried (List C)", () => {
    const step4aIdx = content.indexOf("### Step 4a: Set Up Worktree");
    const step4bIdx = content.indexOf("### Step 4b: Dispatch Conflict Resolution Subagent");
    const preDispatchSection = content.slice(step4aIdx, step4bIdx);
    expect(preDispatchSection).toContain("409");
    const hasSkipLanguage =
      preDispatchSection.includes("skip") || preDispatchSection.includes("skipping");
    expect(hasSkipLanguage).toBe(true);
    expect(preDispatchSection.toLowerCase()).toContain("next");
    expect(preDispatchSection).toContain("List C");
  });

  it("409 handling causes the PR to be skipped and the next candidate in the list to be tried (List A)", () => {
    const step5aIdx = content.indexOf("### Step 5a: Set Up Worktree");
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    const preDispatchSection = content.slice(step5aIdx, step5bIdx);
    expect(preDispatchSection).toContain("409");
    const hasSkipLanguage =
      preDispatchSection.includes("skip") || preDispatchSection.includes("skipping");
    expect(hasSkipLanguage).toBe(true);
    expect(preDispatchSection.toLowerCase()).toContain("next");
    expect(preDispatchSection).toContain("List A");
  });

  it("409 handling causes the PR to be skipped and the next candidate in the list to be tried (List D)", () => {
    const step6aIdx = content.indexOf("### Step 6a: Set Up Worktree");
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    const preDispatchSection = content.slice(step6aIdx, step6cIdx);
    expect(preDispatchSection).toContain("409");
    const hasSkipLanguage =
      preDispatchSection.includes("skip") || preDispatchSection.includes("skipping");
    expect(hasSkipLanguage).toBe(true);
    expect(preDispatchSection.toLowerCase()).toContain("next");
    expect(preDispatchSection).toContain("List D");
  });

  it("Step 4c (merge conflicts): BLOCKED path releases the pre-work claim", () => {
    const step4cIdx = content.indexOf("### Step 4c: Handle Subagent Status");
    const step4c5Idx = content.indexOf("### Step 4c.5:");
    expect(step4cIdx).toBeGreaterThan(-1);
    expect(step4c5Idx).toBeGreaterThan(-1);
    const section = content.slice(step4cIdx, step4c5Idx);
    expect(section).toContain("BLOCKED");
    expect(section).toContain("/prs/$PR_RECORD_ID/release");
  });

  it("Step 5c (review findings): BLOCKED path releases the pre-work claim", () => {
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5c5Idx = content.indexOf("### Step 5c.5:");
    expect(step5cIdx).toBeGreaterThan(-1);
    expect(step5c5Idx).toBeGreaterThan(-1);
    const section = content.slice(step5cIdx, step5c5Idx);
    expect(section).toContain("BLOCKED");
    expect(section).toContain("/prs/$PR_RECORD_ID/release");
  });

  it("Step 6d (failing CI): BLOCKED path releases the pre-work claim", () => {
    const step6dIdx = content.indexOf("### Step 6d: Handle Subagent Status");
    const step6d5Idx = content.indexOf("### Step 6d.5:");
    expect(step6dIdx).toBeGreaterThan(-1);
    expect(step6d5Idx).toBeGreaterThan(-1);
    const section = content.slice(step6dIdx, step6d5Idx);
    expect(section).toContain("BLOCKED");
    expect(section).toContain("/prs/$PR_RECORD_ID/release");
  });

  it("post-fix step 4c.5 reuses PR_RECORD_ID instead of re-calling POST /prs/claim", () => {
    const sectionIdx = content.indexOf("### Step 4c.5: Upsert PR Record");
    expect(sectionIdx).toBeGreaterThan(-1);
    const nextSectionIdx = content.indexOf("### Step 4d:", sectionIdx);
    const section = content.slice(sectionIdx, nextSectionIdx);
    expect(section.includes("/prs/claim")).toBe(false);
    expect(section.includes("PR_RECORD_ID")).toBe(true);
  });

  it("post-fix step 5c.5 reuses PR_RECORD_ID instead of re-calling POST /prs/claim", () => {
    const sectionIdx = content.indexOf("### Step 5c.5: Upsert PR Record");
    expect(sectionIdx).toBeGreaterThan(-1);
    const nextSectionIdx = content.indexOf("### Step 5d:", sectionIdx);
    const section = content.slice(sectionIdx, nextSectionIdx);
    expect(section.includes("/prs/claim")).toBe(false);
    expect(section.includes("PR_RECORD_ID")).toBe(true);
  });

  it("post-fix step 6d.5 reuses PR_RECORD_ID instead of re-calling POST /prs/claim", () => {
    const sectionIdx = content.indexOf("### Step 6d.5: Upsert PR Record");
    expect(sectionIdx).toBeGreaterThan(-1);
    const nextSectionIdx = content.indexOf("### Step 6e:", sectionIdx);
    const section = content.slice(sectionIdx, nextSectionIdx);
    expect(section.includes("/prs/claim")).toBe(false);
    expect(section.includes("PR_RECORD_ID")).toBe(true);
  });

  it("still calls POST /prs/{id}/patch in each post-fix step (patchCycles increment is patch.md-specific)", () => {
    const matches = content.match(/\/prs\/\$PR_RECORD_ID\/patch/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

describe("patch.md — pre-claim marker documentation (CBD-1.5)", () => {
  it("Arguments section documents the [preclaim:{recordId}:{commitSha}] marker format", () => {
    const argsIdx = content.indexOf("## Arguments");
    const step0Idx = content.indexOf("## Step 0: Require Explicit Target");
    expect(argsIdx).toBeGreaterThan(-1);
    expect(step0Idx).toBeGreaterThan(-1);
    const argsSection = content.slice(argsIdx, step0Idx);

    expect(argsSection).toContain("[preclaim:{recordId}:{commitSha}]");
    expect(argsSection).toContain("CBD-1.3");
  });

  it("Arguments section attributes the marker to the loop orchestrator, not a human caller", () => {
    const argsIdx = content.indexOf("## Arguments");
    const step0Idx = content.indexOf("## Step 0: Require Explicit Target");
    const argsSection = content.slice(argsIdx, step0Idx);

    expect(argsSection).toContain("loop orchestrator");
    expect(argsSection.toLowerCase()).toContain("human");
  });

  it("Arguments section says the marker must be stripped before parsing org/repo#number", () => {
    const argsIdx = content.indexOf("## Arguments");
    const step0Idx = content.indexOf("## Step 0: Require Explicit Target");
    const argsSection = content.slice(argsIdx, step0Idx);

    expect(argsSection).toContain("strip");
  });

  it("Step 2 parses and strips the marker once, extracting PRECLAIM_RECORD_ID/PRECLAIM_COMMIT_SHA", () => {
    const step2Idx = content.indexOf("## Step 2: Resolve Target PR");
    const step2_5Idx = content.indexOf("## Step 2.5:");
    expect(step2Idx).toBeGreaterThan(-1);
    expect(step2_5Idx).toBeGreaterThan(-1);
    const step2Section = content.slice(step2Idx, step2_5Idx);

    expect(step2Section).toContain("PRECLAIM_RECORD_ID");
    expect(step2Section).toContain("PRECLAIM_COMMIT_SHA");
    expect(step2Section).toContain("strip");
  });
});

describe("patch.md — pre-claim fast path skips re-claiming at all three sites (CBD-1.5)", () => {
  // List C — merge conflicts — Step 4a.6
  it("Step 4a.6 has a Pre-Claim Fast Path that validates against a freshly-fetched live headRefOid", () => {
    const siteIdx = content.indexOf("### Step 4a.6: Claim PR Record (pre-work lock)");
    const nextIdx = content.indexOf("### Step 4b: Dispatch Conflict Resolution Subagent");
    expect(siteIdx).toBeGreaterThan(-1);
    expect(nextIdx).toBeGreaterThan(-1);
    const section = content.slice(siteIdx, nextIdx);

    expect(section).toContain("Pre-Claim Fast Path");
    expect(section).toContain("headRefOid");
    expect(section).toContain("PRECLAIM_COMMIT_SHA");
  });

  it("Step 4a.6 trusts a matching marker: sets PR_RECORD_ID = PRECLAIM_RECORD_ID and skips its own /prs/claim", () => {
    const siteIdx = content.indexOf("### Step 4a.6: Claim PR Record (pre-work lock)");
    const nextIdx = content.indexOf("### Step 4b: Dispatch Conflict Resolution Subagent");
    const section = content.slice(siteIdx, nextIdx);

    expect(section).toContain("headRefOid == PRECLAIM_COMMIT_SHA");
    expect(section).toContain("PR_RECORD_ID = PRECLAIM_RECORD_ID");
    expect(section).toContain("skip");
  });

  it("Step 4a.6 falls back to self-claiming on a stale or absent marker", () => {
    const siteIdx = content.indexOf("### Step 4a.6: Claim PR Record (pre-work lock)");
    const nextIdx = content.indexOf("### Step 4b: Dispatch Conflict Resolution Subagent");
    const section = content.slice(siteIdx, nextIdx);

    expect(section).toContain("headRefOid != PRECLAIM_COMMIT_SHA");
    expect(section).toContain("no marker present");
    expect(section).toContain("self-claim");
    // self-claim path is preserved: still POSTs /prs/claim with phase patch
    expect(section).toContain("/prs/claim");
    expect(section).toContain("HEAD_SHA_PRE_PATCH");
  });

  // List A — review findings — Step 5a.6
  it("Step 5a.6 has a Pre-Claim Fast Path that validates against a freshly-fetched live headRefOid", () => {
    const siteIdx = content.indexOf("### Step 5a.6: Claim PR Record (pre-work lock)");
    const nextIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    expect(siteIdx).toBeGreaterThan(-1);
    expect(nextIdx).toBeGreaterThan(-1);
    const section = content.slice(siteIdx, nextIdx);

    expect(section).toContain("Pre-Claim Fast Path");
    expect(section).toContain("headRefOid");
    expect(section).toContain("PRECLAIM_COMMIT_SHA");
  });

  it("Step 5a.6 trusts a matching marker: sets PR_RECORD_ID = PRECLAIM_RECORD_ID and skips its own /prs/claim", () => {
    const siteIdx = content.indexOf("### Step 5a.6: Claim PR Record (pre-work lock)");
    const nextIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    const section = content.slice(siteIdx, nextIdx);

    expect(section).toContain("headRefOid == PRECLAIM_COMMIT_SHA");
    expect(section).toContain("PR_RECORD_ID = PRECLAIM_RECORD_ID");
    expect(section).toContain("skip");
  });

  it("Step 5a.6 falls back to self-claiming on a stale or absent marker", () => {
    const siteIdx = content.indexOf("### Step 5a.6: Claim PR Record (pre-work lock)");
    const nextIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    const section = content.slice(siteIdx, nextIdx);

    expect(section).toContain("headRefOid != PRECLAIM_COMMIT_SHA");
    expect(section).toContain("no marker present");
    expect(section).toContain("self-claim");
    expect(section).toContain("/prs/claim");
    expect(section).toContain("HEAD_SHA_PRE_PATCH");
  });

  // List D — failing CI — Step 6b.5
  it("Step 6b.5 has a Pre-Claim Fast Path that validates against a freshly-fetched live headRefOid", () => {
    const siteIdx = content.indexOf("### Step 6b.5: Claim PR Record (pre-work lock)");
    const nextIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    expect(siteIdx).toBeGreaterThan(-1);
    expect(nextIdx).toBeGreaterThan(-1);
    const section = content.slice(siteIdx, nextIdx);

    expect(section).toContain("Pre-Claim Fast Path");
    expect(section).toContain("headRefOid");
    expect(section).toContain("PRECLAIM_COMMIT_SHA");
  });

  it("Step 6b.5 trusts a matching marker: sets PR_RECORD_ID = PRECLAIM_RECORD_ID and skips its own /prs/claim", () => {
    const siteIdx = content.indexOf("### Step 6b.5: Claim PR Record (pre-work lock)");
    const nextIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    const section = content.slice(siteIdx, nextIdx);

    expect(section).toContain("headRefOid == PRECLAIM_COMMIT_SHA");
    expect(section).toContain("PR_RECORD_ID = PRECLAIM_RECORD_ID");
    expect(section).toContain("skip");
  });

  it("Step 6b.5 falls back to self-claiming on a stale or absent marker", () => {
    const siteIdx = content.indexOf("### Step 6b.5: Claim PR Record (pre-work lock)");
    const nextIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    const section = content.slice(siteIdx, nextIdx);

    expect(section).toContain("headRefOid != PRECLAIM_COMMIT_SHA");
    expect(section).toContain("no marker present");
    expect(section).toContain("self-claim");
    expect(section).toContain("/prs/claim");
    expect(section).toContain("HEAD_SHA_PRE_PATCH");
  });

  it("each fast path re-fetches the live head independently (three gh pr view --json headRefOid reads)", () => {
    const matches = content.match(/gh pr view \{pr\} --repo \{org\}\/\{repo\} --json headRefOid/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

describe("patch.md — rebuttal comment for all-REJECT findings (RPF-1.1)", () => {
  it("Step 5b Instructions [D] requires a gh pr comment rebuttal whenever any finding was REJECTed, independent of the commit/push condition", () => {
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    expect(step5bIdx).toBeGreaterThan(-1);
    expect(step5cIdx).toBeGreaterThan(-1);
    const step5bSection = content.slice(step5bIdx, step5cIdx);

    const dIdx = step5bSection.indexOf("[D] Commit");
    const eIdx = step5bSection.indexOf("[E] Resolve addressed inline threads");
    expect(dIdx).toBeGreaterThan(-1);
    expect(eIdx).toBeGreaterThan(-1);
    const dSection = step5bSection.slice(dIdx, eIdx);

    expect(dSection).toContain("gh pr comment");
    expect(dSection).toContain("classified REJECT");
    expect(dSection).toContain("independent");
    expect(dSection).toContain("regardless of whether other");
  });

  it("Step 5b Instructions [D] leaves the ACCEPT/MODIFY commit+push flow unchanged for the real-fix case", () => {
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5bSection = content.slice(step5bIdx, step5cIdx);

    const dIdx = step5bSection.indexOf("[D] Commit");
    const eIdx = step5bSection.indexOf("[E] Resolve addressed inline threads");
    const dSection = step5bSection.slice(dIdx, eIdx);

    expect(dSection).toContain("ACCEPTED or MODIFIED");
    expect(dSection).toContain("git add {changed files}");
    expect(dSection).toContain(
      "fix: address review findings on #{pr} — {one-line summary of changes}",
    );
    expect(dSection).toContain("git push origin {branch}");
  });

  it("Step 5b Instructions [F] report template ties DONE_WITH_CONCERNS confirmation to the rebuttal comment", () => {
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5bSection = content.slice(step5bIdx, step5cIdx);

    const fIdx = step5bSection.indexOf("[F] Report back");
    expect(fIdx).toBeGreaterThan(-1);
    const fSection = step5bSection.slice(fIdx);

    expect(fSection).toContain("rebuttal comment was posted");
  });

  it("Step 5c's DONE_WITH_CONCERNS branch requires confirming the rebuttal comment was posted before treating the no-push case as complete", () => {
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5c5Idx = content.indexOf("### Step 5c.5:");
    expect(step5cIdx).toBeGreaterThan(-1);
    expect(step5c5Idx).toBeGreaterThan(-1);
    const section = content.slice(step5cIdx, step5c5Idx);

    expect(section).toContain("DONE_WITH_CONCERNS");
    expect(section).toContain("confirm");
    expect(section).toContain("gh pr comment");
    expect(section).toContain("rebuttal");
    expect(section).not.toContain("note it and skip Step 5c.5");
  });

  it("Step 5c does not itself post the rebuttal comment — it only verifies the subagent already did", () => {
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5c5Idx = content.indexOf("### Step 5c.5:");
    const section = content.slice(step5cIdx, step5c5Idx);

    expect(section).toContain("Do not post the comment here");
  });

  it("Step 5c no longer skips Step 5c.5 on the all-REJECT no-push path — it always proceeds", () => {
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5c5Idx = content.indexOf("### Step 5c.5:");
    const section = content.slice(step5cIdx, step5c5Idx);

    expect(section).not.toContain("skip Step 5c.5");
    expect(section).toMatch(/proceed(s)? to Step 5c\.5/i);
    // Still distinguishes the all-REJECT/no-push case from the mixed/push case in prose,
    // it just no longer skips the step for it.
    expect(section).toContain("no-push");
  });
});

describe("patch.md — reset reviewState to pending after a no-push, rebuttal-confirmed patch cycle (RPF-1.2)", () => {
  it("Step 5c always proceeds to Step 5c.5, carrying forward whether this was the no-push/rebuttal-confirmed case", () => {
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5c5Idx = content.indexOf("### Step 5c.5:");
    const section = content.slice(step5cIdx, step5c5Idx);

    expect(section).toContain("DONE_WITH_CONCERNS");
    expect(section).toMatch(/proceed(s)? to Step 5c\.5/i);
    // Both the mixed-push case and the no-push case (whether every finding was REJECTed or
    // some ACCEPTED/MODIFIED findings resolved to a zero-diff no-op) now reach Step 5c.5.
    expect(section.toLowerCase()).toContain("mixed");
    expect(section).toContain("no-push");
    expect(section).not.toContain("ALL_REJECT_NO_PUSH_REBUTTAL_CONFIRMED");
  });

  it("Step 5c.5 conditionally PATCHes /prs/{id} with reviewState:pending, gated on the no-push/rebuttal-confirmed case", () => {
    const step5c5Idx = content.indexOf("### Step 5c.5: Upsert PR Record");
    const step5dIdx = content.indexOf("### Step 5d:");
    expect(step5c5Idx).toBeGreaterThan(-1);
    expect(step5dIdx).toBeGreaterThan(-1);
    const section = content.slice(step5c5Idx, step5dIdx);

    // Existing unconditional heartbeat + commitSha patch calls remain.
    expect(section).toContain("/prs/$PR_RECORD_ID/heartbeat");
    expect(section).toContain("/prs/$PR_RECORD_ID/patch");
    expect(section).toContain("commitSha");

    // New conditional reviewState reset.
    expect(section).toContain("-X PATCH");
    expect(section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"');
    expect(section).toContain("reviewState");
    expect(section).toContain("pending");
    // It must be gated by a condition, not unconditional — expect an if-check near the
    // reviewState reset referencing the no-push/rebuttal case.
    const reviewStateIdx = section.indexOf("reviewState");
    const before = section.slice(Math.max(0, reviewStateIdx - 600), reviewStateIdx);
    expect(before).toMatch(/if\s*\[/);
    expect(section).toContain("NO_PUSH_REBUTTAL_CONFIRMED");
  });

  it("Step 5c.5's reviewState reset is scoped to the no-push case, not the ACCEPT/MODIFY push case, and doesn't require every finding to be REJECTed", () => {
    const step5c5Idx = content.indexOf("### Step 5c.5: Upsert PR Record");
    const step5dIdx = content.indexOf("### Step 5d:");
    const section = content.slice(step5c5Idx, step5dIdx);

    // The prose around the conditional must reference the no-push/rebuttal case, not fire
    // for every patch cycle, and must not require literally every finding to be REJECTed
    // (a mixed run whose ACCEPTED/MODIFIED findings all resolve to zero-diff no-ops also
    // qualifies, since dedup keys off the commit SHA, not the finding classification).
    expect(section.toLowerCase()).toContain("no-push");
    const normalized = section.replace(/\s+/g, " ");
    expect(normalized).toMatch(/does not require every finding.{0,40}REJECTed/i);
  });

  it("the ACCEPT/MODIFY push path text in Step 5b [D] is unchanged — still commits, pushes, and records commitSha", () => {
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5bSection = content.slice(step5bIdx, step5cIdx);

    const dIdx = step5bSection.indexOf("[D] Commit");
    const eIdx = step5bSection.indexOf("[E] Resolve addressed inline threads");
    const dSection = step5bSection.slice(dIdx, eIdx);

    expect(dSection).toContain("ACCEPTED or MODIFIED");
    expect(dSection).toContain("git add {changed files}");
    expect(dSection).toContain("git push origin {branch}");
    // No reviewState reset language belongs in the subagent-dispatched commit instructions —
    // that logic lives in Step 5c.5, driven by the orchestrator, not the subagent.
    expect(dSection).not.toContain("reviewState");
  });
});

describe("patch.md — escalate to HITL instead of looping on a second-round disagreement (RPF-1.3)", () => {
  function getStep5a7Section() {
    const step5a7Idx = content.indexOf("### Step 5a.7: Second-Round Escalation Check (RPF-1.3)");
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    expect(step5a7Idx).toBeGreaterThan(-1);
    expect(step5bIdx).toBeGreaterThan(-1);
    return content.slice(step5a7Idx, step5bIdx);
  }

  it("Step 5a.7 exists between Step 5a.6 (claim) and Step 5b (dispatch)", () => {
    const step5a6Idx = content.indexOf("### Step 5a.6: Claim PR Record (pre-work lock)");
    const step5a7Idx = content.indexOf("### Step 5a.7: Second-Round Escalation Check (RPF-1.3)");
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    expect(step5a6Idx).toBeGreaterThan(-1);
    expect(step5a7Idx).toBeGreaterThan(step5a6Idx);
    expect(step5bIdx).toBeGreaterThan(step5a7Idx);
  });

  it("the claim step (5a.6) hands off to 5a.7, not straight to 5b", () => {
    const step5a6Idx = content.indexOf("### Step 5a.6: Claim PR Record (pre-work lock)");
    const step5a7Idx = content.indexOf("### Step 5a.7: Second-Round Escalation Check (RPF-1.3)");
    const section = content.slice(step5a6Idx, step5a7Idx);
    expect(section).toContain("Proceed to Step 5a.7");
  });

  it("second-round detection compares an author-reply comment's createdAt against the qualifying review's submittedAt", () => {
    const section = getStep5a7Section();
    expect(section).toContain("CURRENT_USER");
    expect(section).toContain("createdAt");
    expect(section).toContain("submittedAt");
    expect(section).toContain("before");
    expect(section).toContain("isAddressedByAuthorReply");
  });

  it("distinguishes this check from isAddressedByAuthorReply's direction (reply after vs. before the review)", () => {
    const section = getStep5a7Section();
    expect(section.toLowerCase()).toContain("opposite direction");
    expect(section).toContain("reply *after* a review marks");
    expect(section).toContain("reply dated *before* the");
  });

  it("escalation case resolves the linked task via the PR record and PATCHes hitl: true", () => {
    const section = getStep5a7Section();
    expect(section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"');
    expect(section).toContain("PR_TASK_ID");
    expect(section).toContain("taskId");
    expect(section).toContain("-X PATCH");
    expect(section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID"');
    expect(section).toContain('"hitl": true');
  });

  it("escalation case with no linked task PATCHes the PR record itself with hitl: true and a blockedReason, not just a warning", () => {
    const section = getStep5a7Section();
    const patchPrSnippet =
      '"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID" \\\n     -d \'{"hitl": true, "blockedReason"';
    expect(section).toContain("PR_TASK_ID` is empty");
    expect(section).not.toContain("log a warning and skip the");
    expect(section).toContain(
      `curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \\\n     -H "Content-Type: application/json" \\\n     ${patchPrSnippet}`,
    );
    expect(section).toContain("second-round disagreement");
    const emptyBranchIdx = section.indexOf("PR_TASK_ID` is empty");
    const patchPrIdx = section.indexOf(patchPrSnippet);
    expect(patchPrIdx).toBeGreaterThan(emptyBranchIdx);
  });

  it("escalation case posts exactly one PR comment via a temp file scoped by PR number", () => {
    const section = getStep5a7Section();
    expect(section).toContain("gh pr comment {pr} --repo {org}/{repo} --body-file");
    expect(section).toContain("/tmp/shipwright-patch-escalation-{pr}.txt");
    expect(section).toContain("rm /tmp/shipwright-patch-escalation-{pr}.txt");
  });

  it("escalation case releases the pre-work claim and skips to the next PR without dispatching a fix subagent", () => {
    const section = getStep5a7Section();
    expect(section).toContain("/prs/$PR_RECORD_ID/release");
    expect(section).toContain("do not dispatch the fix subagent");
    expect(section).toContain("do not post another rebuttal");
    expect(section).toContain("do not reset");
    expect(section).toContain("Move to the next qualifying PR in List A");
  });

  it("escalation case resolves the unresolved inline threads for the qualifying second-round review before releasing the claim", () => {
    const section = getStep5a7Section();
    expect(section).toContain("resolveReviewThread");
    expect(section).toContain("re-flag this same PR next");
    const resolveIdx = section.indexOf("resolveReviewThread");
    const releaseIdx = section.indexOf("/prs/$PR_RECORD_ID/release");
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(resolveIdx);
  });

  it("does not reference commit.oid, a field Step 3a's reviews query never fetches", () => {
    const section = getStep5a7Section();
    expect(section).not.toContain("commit.oid");
  });

  it("first-round rebuttals (no prior author reply before the current review) proceed normally to Step 5b", () => {
    const section = getStep5a7Section();
    const otherwiseIdx = section.indexOf("**Otherwise**");
    expect(otherwiseIdx).toBeGreaterThan(-1);
    const otherwiseSection = section.slice(otherwiseIdx);
    expect(otherwiseSection).toContain("proceed normally to Step 5b");
    expect(otherwiseSection).toContain("RPF-1.1/1.2 behavior applies as before");
  });

  it("frames the escalation as a human-judgment deadlock, explicitly skipping the reviewState reset", () => {
    const section = getStep5a7Section();
    expect(section.toLowerCase()).toContain("human-judgment deadlock");
    expect(section).toContain("do not reset");
    expect(section).toContain("reviewState");
  });
});

describe("patch.md — skip CI-fix dispatch when an unresolved HITL escalation already exists (CFE-1.1)", () => {
  function getStep6b6Section() {
    const step6b6Idx = content.indexOf("### Step 6b.6: Escalation Check (CFE-1.1)");
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    expect(step6b6Idx).toBeGreaterThan(-1);
    expect(step6cIdx).toBeGreaterThan(-1);
    return content.slice(step6b6Idx, step6cIdx);
  }

  it("Step 6b.6 exists between Step 6b.5 (claim) and Step 6c (dispatch)", () => {
    const step6b5Idx = content.indexOf("### Step 6b.5: Claim PR Record (pre-work lock)");
    const step6b6Idx = content.indexOf("### Step 6b.6: Escalation Check (CFE-1.1)");
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    expect(step6b5Idx).toBeGreaterThan(-1);
    expect(step6b6Idx).toBeGreaterThan(step6b5Idx);
    expect(step6cIdx).toBeGreaterThan(step6b6Idx);
  });

  it("the claim step (6b.5) hands off to 6b.6 in both branches, not straight to 6c", () => {
    const step6b5Idx = content.indexOf("### Step 6b.5: Claim PR Record (pre-work lock)");
    const step6b6Idx = content.indexOf("### Step 6b.6: Escalation Check (CFE-1.1)");
    const section = content.slice(step6b5Idx, step6b6Idx);
    expect(section).not.toContain("Proceed directly to Step 6c");
    expect(section).not.toContain("Proceed to Step 6c");
    expect(section).toContain("Proceed directly to Step 6b.6");
    expect(section).toContain("Proceed to Step 6b.6");
  });

  it("references Step 5a.7 as the mirrored precedent for this check", () => {
    const section = getStep6b6Section();
    expect(section).toContain("5a.7");
  });

  it("fetches the PR record fresh and checks its hitl field", () => {
    const section = getStep6b6Section();
    expect(section).toContain("GET");
    expect(section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"');
    expect(section).toContain("hitl");
  });

  it("also checks the linked task's hitl field when taskId is present", () => {
    const section = getStep6b6Section();
    expect(section).toContain("taskId");
    expect(section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks/$');
  });

  it("true branch releases the claim, does not dispatch the fix subagent, and moves to the next PR in List D", () => {
    const section = getStep6b6Section();
    expect(section).toContain("/prs/$PR_RECORD_ID/release");
    const hasSkipLanguage =
      /do not\s+dispatch.{0,40}fix subagent/is.test(section) ||
      /skip.{0,40}fix subagent/is.test(section) ||
      /fix subagent.{0,40}skip/is.test(section);
    expect(hasSkipLanguage).toBe(true);
    expect(section).toContain("next PR in List D");
  });

  it("otherwise branch proceeds normally to Step 6c", () => {
    const section = getStep6b6Section();
    const otherwiseIdx = section.indexOf("**Otherwise**");
    expect(otherwiseIdx).toBeGreaterThan(-1);
    const otherwiseSection = section.slice(otherwiseIdx);
    expect(otherwiseSection).toContain("Step 6c");
  });
});

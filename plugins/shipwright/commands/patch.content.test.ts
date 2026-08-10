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

  it("escalation case reuses the shared PR_TASK_ID from Step 2.1 and PATCHes status: blocked (no fresh taskId fetch)", () => {
    const section = getStep5a7Section();
    expect(section).toContain("PR_TASK_ID");
    // No independent GET .../prs/$PR_RECORD_ID fetch for taskId purposes anymore — that
    // resolution now lives once in Step 2.1 (MTR-2.1) and is only referenced here.
    expect(section).not.toMatch(
      /GET[^\n]*\n[^\n]*"\$SHIPWRIGHT_TASK_STORE_URL\/prs\/\$PR_RECORD_ID"[^\n]*\n[^\n]*taskId/,
    );
    expect(section).toMatch(/Step 2\.1|reuse/i);
    expect(section).toContain("-X PATCH");
    expect(section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID"');
    expect(section).toContain('"status": "blocked"');
  });

  it("escalation case with no linked task PATCHes the PR record itself with blocked: true and a blockedReason, not just a warning", () => {
    const section = getStep5a7Section();
    const patchPrSnippet =
      '"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID" \\\n     -d \'{"blocked": true, "blockedReason"';
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

  it("requires an explicit SAME_FINDING/DIFFERENT_FINDING judgment with justification for each candidate reply before escalating", () => {
    const section = getStep5a7Section();
    expect(section).toContain("SAME_FINDING");
    expect(section).toContain("DIFFERENT_FINDING");
    expect(section.toLowerCase()).toContain("justification");
    // The judgment must be printed/decided before the escalation branch runs, not after.
    const judgmentIdx = section.indexOf("SAME_FINDING");
    const escalationBranchIdx = section.indexOf(
      "**If any qualifying review has an author-reply comment",
    );
    expect(escalationBranchIdx).toBe(-1); // old unconditional-timestamp escalation framing must be gone
    const ifEscalateIdx = section.search(/\*\*If.{0,80}SAME_FINDING/is);
    expect(ifEscalateIdx).toBeGreaterThan(-1);
    expect(judgmentIdx).toBeLessThan(ifEscalateIdx);
  });

  it("states the anti-pattern explicitly: a reply predating the review is not sufficient by itself to escalate", () => {
    const section = getStep5a7Section();
    expect(section.toLowerCase()).toContain("anti-pattern");
    expect(section).toMatch(
      /predat(e|ing|es) the review.{0,200}(not sufficient|is not enough|alone is not)/is,
    );
    expect(section.toLowerCase()).toContain("content must be verified");
  });

  it("gates escalation on at least one candidate reply judged SAME_FINDING, not on timestamp precedence alone", () => {
    const section = getStep5a7Section();
    expect(section).toMatch(/at least one.{0,40}candidate.{0,60}SAME_FINDING/is);
    expect(section).not.toContain(
      "If any qualifying review has an author-reply comment dated before its `submittedAt`",
    );
  });

  it("the no-escalation path covers both no-candidate-replies and all-candidates-judged-DIFFERENT_FINDING, proceeding to Step 5b as a first-round finding", () => {
    const section = getStep5a7Section();
    const otherwiseIdx = section.indexOf("**Otherwise**");
    expect(otherwiseIdx).toBeGreaterThan(-1);
    const otherwiseSection = section.slice(otherwiseIdx);
    expect(otherwiseSection).toContain("proceed normally to Step 5b");
    expect(otherwiseSection.toLowerCase()).toContain("first-round finding");
    expect(otherwiseSection).toMatch(/no candidate replies|no candidates/i);
    expect(otherwiseSection).toContain("DIFFERENT_FINDING");
  });

  it("prefers inline-thread anchors (stable path/line) over freeform PR-comment text matching when the finding came from a thread", () => {
    const section = getStep5a7Section();
    expect(section.toLowerCase()).toContain("inline-thread anchor");
    expect(section).toContain("path");
    expect(section).toContain("line");
    expect(section.toLowerCase()).toMatch(/freeform (pr-comment )?text matching/);
  });

  it("frames the timestamp check as a shared pre-filter with check-patch.ts, and explains why the extra correlation judgment is needed here but not there", () => {
    const section = getStep5a7Section();
    expect(section).toContain("isAddressedByAuthorReply");
    expect(section.toLowerCase()).toContain("pre-filter");
    // Must no longer imply timestamp-order alone is sufficient signal for this step's decision.
    expect(section).not.toContain(
      "a reply dated *before* the\ncurrent review means we already rebutted once, the reviewer looked at that\nrebuttal, and\nstill raised a finding this round.",
    );
    // Should explain reply-after-review is inherently a stronger signal than reply-before-review.
    expect(section).toMatch(/after a review.{0,120}(stronger|inherent)/is);
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

  it("fetches the PR record fresh and checks its blocked field", () => {
    const section = getStep6b6Section();
    expect(section).toContain("GET");
    expect(section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"');
    expect(section).toContain("PR_BLOCKED");
  });

  it("also checks the linked task's status field when taskId is present", () => {
    const section = getStep6b6Section();
    expect(section).toContain("taskId");
    expect(section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks/$');
    expect(section).toContain("TASK_BLOCKED");
    expect(section).toContain('.status');
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

  it("otherwise branch hands off to Step 6b.7, not straight to 6c", () => {
    const section = getStep6b6Section();
    const otherwiseIdx = section.indexOf("**Otherwise**");
    expect(otherwiseIdx).toBeGreaterThan(-1);
    const otherwiseSection = section.slice(otherwiseIdx);
    expect(otherwiseSection).toContain("Step 6b.7");
  });
});

describe("patch.md — bundle-incomplete self-check before CI-fix dispatch (PH-1.1)", () => {
  function getStep6b7Section() {
    const step6b7Idx = content.indexOf(
      "### Step 6b.7: Bundle Completeness Gate (PH-1.1)",
    );
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    expect(step6b7Idx).toBeGreaterThan(-1);
    expect(step6cIdx).toBeGreaterThan(-1);
    return content.slice(step6b7Idx, step6cIdx);
  }

  it("Step 6b.7 exists between Step 6b.6 (escalation check) and Step 6c (dispatch)", () => {
    const step6b6Idx = content.indexOf(
      "### Step 6b.6: Escalation Check (CFE-1.1)",
    );
    const step6b7Idx = content.indexOf(
      "### Step 6b.7: Bundle Completeness Gate (PH-1.1)",
    );
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    expect(step6b6Idx).toBeGreaterThan(-1);
    expect(step6b7Idx).toBeGreaterThan(step6b6Idx);
    expect(step6cIdx).toBeGreaterThan(step6b7Idx);
  });

  it("re-queries /tasks?branch= and checks for pending/in_progress/blocked statuses, matching isBundleComplete's signal", () => {
    const section = getStep6b7Section();
    expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks?branch=");
    expect(section).toContain('"pending"');
    expect(section).toContain('"in_progress"');
    expect(section).toContain('"blocked"');
  });

  it("uses {branch} already in scope rather than re-deriving HEAD_BRANCH via gh pr view again", () => {
    const section = getStep6b7Section();
    expect(section).not.toContain("gh pr view");
    expect(section).not.toContain("headRefName");
  });

  it("contains [silent] and the fully-interpolated [skip-reason:patch:deferred:bundle-incomplete:{branch}] marker", () => {
    const section = getStep6b7Section();
    expect(section).toContain("[silent]");
    expect(section).toContain(
      "[skip-reason:patch:deferred:bundle-incomplete:",
    );
    expect(section).toContain(
      "[skip-reason:patch:deferred:bundle-incomplete:{branch}]",
    );
  });

  it("does not require a specific ordering between [skip-reason:...] and [silent]", () => {
    const section = getStep6b7Section();
    expect(section).toContain("does not matter");
  });

  it("releases the Step 6b.5 pre-work claim before stopping", () => {
    const section = getStep6b7Section();
    expect(section).toContain("/prs/$PR_RECORD_ID/release");
  });

  it("fully stops the command on incomplete bundle rather than continuing to the next PR in List D (unlike Step 6b.6)", () => {
    const section = getStep6b7Section();
    expect(section).not.toContain("next PR in List D");
    expect(section).not.toContain("Step 7");
    const hasStopLanguage =
      /stop\s+here/is.test(section) || /stop\s+the\s+command/is.test(section);
    expect(hasStopLanguage).toBe(true);
  });

  it("otherwise branch (bundle complete) proceeds to Step 6c and does not emit [silent]", () => {
    const section = getStep6b7Section();
    const otherwiseIdx = section.indexOf("**Otherwise**");
    expect(otherwiseIdx).toBeGreaterThan(-1);
    const otherwiseSection = section.slice(otherwiseIdx);
    expect(otherwiseSection).toContain("Step 6c");
    expect(otherwiseSection).not.toContain("[silent]");
  });
});

describe("patch.md — shared patch model tier resolution (MTR-2.1)", () => {
  function getStep2_1Section() {
    const step2_1Idx = content.indexOf("## Step 2.1:");
    const step2_5Idx = content.indexOf("## Step 2.5:");
    expect(step2_1Idx).toBeGreaterThan(-1);
    expect(step2_5Idx).toBeGreaterThan(-1);
    return content.slice(step2_1Idx, step2_5Idx);
  }

  it("Step 2.1 exists between Step 2 (resolve target PR) and Step 2.5 (DIRTY handling)", () => {
    const step2Idx = content.indexOf("## Step 2: Resolve Target PR");
    const step2_1Idx = content.indexOf("## Step 2.1:");
    const step2_5Idx = content.indexOf("## Step 2.5:");
    expect(step2Idx).toBeGreaterThan(-1);
    expect(step2_1Idx).toBeGreaterThan(step2Idx);
    expect(step2_5Idx).toBeGreaterThan(step2_1Idx);
  });

  it("Step 2.1 resolves PR_TASK_ID via GET /prs?repo=...&prNumber=... using the .prs[0].taskId jq path", () => {
    const section = getStep2_1Section();
    expect(section).toContain("PR_TASK_ID");
    expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&prNumber={pr}");
    expect(section).toContain(".prs[0].taskId // empty");
  });

  it("Step 2.1 documents the full escalation ladder (haiku->sonnet, sonnet->opus, opus->opus) and the no-task/failed-fetch sonnet fallback with no hard stop", () => {
    const section = getStep2_1Section();
    expect(section).toContain("PATCH_MODEL");
    expect(section.toLowerCase()).toContain("haiku");
    expect(section.toLowerCase()).toContain("sonnet");
    expect(section.toLowerCase()).toContain("opus");
    // Ladder direction: haiku -> sonnet, sonnet -> opus, opus stays opus.
    expect(section).toMatch(/haiku[^\n]{0,40}(->|→)[^\n]{0,10}sonnet/i);
    expect(section).toMatch(/sonnet[^\n]{0,40}(->|→)[^\n]{0,10}opus/i);
    expect(section).toMatch(/opus[^\n]{0,60}(->|→)[^\n]{0,10}opus|opus.{0,40}stays opus/i);
    // No-task / failed-fetch fallback: plain 'sonnet', no escalation, not a hard stop.
    expect(section).toMatch(/PATCH_MODEL\s*=\s*"?sonnet"?/);
    expect(section.toLowerCase()).toContain("no escalation");
    expect(section.toLowerCase()).toContain("not a hard stop");
    expect(section).toContain("⚠");
  });

  it("Step 2.1 notes the value is reused at Step 4b, Step 5b, Step 6c, and Step 5a.7 with no second fetch", () => {
    const section = getStep2_1Section();
    expect(section).toContain("Step 4b");
    expect(section).toContain("Step 5b");
    expect(section).toContain("Step 6c");
    expect(section).toContain("Step 5a.7");
  });

  it("Step 4b dispatch (conflict resolution) passes model: PATCH_MODEL to the Agent() call", () => {
    const step4bIdx = content.indexOf("### Step 4b: Dispatch Conflict Resolution Subagent");
    const step4cIdx = content.indexOf("### Step 4c: Handle Subagent Status");
    expect(step4bIdx).toBeGreaterThan(-1);
    expect(step4cIdx).toBeGreaterThan(-1);
    const section = content.slice(step4bIdx, step4cIdx);
    expect(section).toContain("model: PATCH_MODEL");
  });

  it("Step 5b dispatch (finding fixes) passes model: PATCH_MODEL to the Agent() call", () => {
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    expect(step5bIdx).toBeGreaterThan(-1);
    expect(step5cIdx).toBeGreaterThan(-1);
    const section = content.slice(step5bIdx, step5cIdx);
    expect(section).toContain("model: PATCH_MODEL");
  });

  it("Step 6c dispatch (CI fixes) passes model: PATCH_MODEL to the Agent() call", () => {
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    const step6dIdx = content.indexOf("### Step 6d: Handle Subagent Status");
    expect(step6cIdx).toBeGreaterThan(-1);
    expect(step6dIdx).toBeGreaterThan(-1);
    const section = content.slice(step6cIdx, step6dIdx);
    expect(section).toContain("model: PATCH_MODEL");
  });
});

describe("patch.md — [C.5] Add test coverage in fix subagent prompts (PTR-1.1)", () => {
  function getStep5bSection() {
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    expect(step5bIdx).toBeGreaterThan(-1);
    expect(step5cIdx).toBeGreaterThan(-1);
    return content.slice(step5bIdx, step5cIdx);
  }

  function getStep6cSection() {
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    const step6dIdx = content.indexOf("### Step 6d: Handle Subagent Status");
    expect(step6cIdx).toBeGreaterThan(-1);
    expect(step6dIdx).toBeGreaterThan(-1);
    return content.slice(step6cIdx, step6dIdx);
  }

  it("Step 5b prompt has [C.5] Add test coverage positioned between [C] Validate and [D] Commit", () => {
    const section = getStep5bSection();
    const cIdx = section.indexOf("[C] Validate");
    const c5Idx = section.indexOf("[C.5] Add test coverage");
    const dIdx = section.indexOf("[D] Commit");
    expect(cIdx).toBeGreaterThan(-1);
    expect(c5Idx).toBeGreaterThan(cIdx);
    expect(dIdx).toBeGreaterThan(c5Idx);
  });

  it("Step 6c prompt has [C.5] Add test coverage positioned between [C] Validate and [D] Commit", () => {
    const section = getStep6cSection();
    const cIdx = section.indexOf("[C] Validate");
    const c5Idx = section.indexOf("[C.5] Add test coverage");
    const dIdx = section.indexOf("[D] Commit");
    expect(cIdx).toBeGreaterThan(-1);
    expect(c5Idx).toBeGreaterThan(cIdx);
    expect(dIdx).toBeGreaterThan(c5Idx);
  });

  it("Step 5b's [C.5] instructs detecting test framework/conventions from nearby existing tests and re-running validate commands", () => {
    const section = getStep5bSection();
    const c5Idx = section.indexOf("[C.5] Add test coverage");
    const dIdx = section.indexOf("[D] Commit");
    const c5Section = section.slice(c5Idx, dIdx);
    expect(c5Section.toLowerCase()).toContain("test framework");
    expect(c5Section.toLowerCase()).toContain("existing tests");
    expect(c5Section.toLowerCase()).toContain("no test is needed");
  });

  it("Step 6c's [C.5] instructs detecting test framework/conventions from nearby existing tests and re-running validate commands", () => {
    const section = getStep6cSection();
    const c5Idx = section.indexOf("[C.5] Add test coverage");
    const dIdx = section.indexOf("[D] Commit");
    const c5Section = section.slice(c5Idx, dIdx);
    expect(c5Section.toLowerCase()).toContain("test framework");
    expect(c5Section.toLowerCase()).toContain("existing tests");
    expect(c5Section.toLowerCase()).toContain("no test is needed");
  });

  it("neither [C.5] block hardcodes a repo-specific test-suffix convention", () => {
    const step5bSection = getStep5bSection();
    const step6cSection = getStep6cSection();
    const c5In5b = step5bSection.slice(
      step5bSection.indexOf("[C.5] Add test coverage"),
      step5bSection.indexOf("[D] Commit"),
    );
    const c5In6c = step6cSection.slice(
      step6cSection.indexOf("[C.5] Add test coverage"),
      step6cSection.indexOf("[D] Commit"),
    );
    for (const c5Section of [c5In5b, c5In6c]) {
      expect(c5Section).not.toContain("*.unit.test.ts");
      expect(c5Section).not.toContain("*.integration.test.ts");
      expect(c5Section).not.toContain("*.smoke.test.ts");
      expect(c5Section).not.toContain("*.content.test.ts");
    }
  });

  it("Step 5b's [F] Report back block includes a TESTS_ADDED: field", () => {
    const section = getStep5bSection();
    const fIdx = section.indexOf("[F] Report back");
    expect(fIdx).toBeGreaterThan(-1);
    const fSection = section.slice(fIdx);
    expect(fSection).toContain("TESTS_ADDED:");
  });

  it("Step 6c's [E] Report back block includes a TESTS_ADDED: field", () => {
    const section = getStep6cSection();
    const eIdx = section.indexOf("[E] Report back");
    expect(eIdx).toBeGreaterThan(-1);
    const eSection = section.slice(eIdx);
    expect(eSection).toContain("TESTS_ADDED:");
  });
});

describe("patch.md — escalate first-time BLOCKED status to HITL before releasing the claim (BHE-1.1)", () => {
  function getStep4cSection() {
    const step4cIdx = content.indexOf("### Step 4c: Handle Subagent Status");
    const step4c5Idx = content.indexOf("### Step 4c.5:");
    expect(step4cIdx).toBeGreaterThan(-1);
    expect(step4c5Idx).toBeGreaterThan(-1);
    return content.slice(step4cIdx, step4c5Idx);
  }

  function getStep5cSection() {
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5c5Idx = content.indexOf("### Step 5c.5:");
    expect(step5cIdx).toBeGreaterThan(-1);
    expect(step5c5Idx).toBeGreaterThan(-1);
    return content.slice(step5cIdx, step5c5Idx);
  }

  function getStep6dSection() {
    const step6dIdx = content.indexOf("### Step 6d: Handle Subagent Status");
    const step6d5Idx = content.indexOf("### Step 6d.5:");
    expect(step6dIdx).toBeGreaterThan(-1);
    expect(step6d5Idx).toBeGreaterThan(-1);
    return content.slice(step6dIdx, step6d5Idx);
  }

  function getBlockedBranch(section: string) {
    const blockedIdx = section.indexOf("**BLOCKED**");
    expect(blockedIdx).toBeGreaterThan(-1);
    return section.slice(blockedIdx);
  }

  function assertEscalationBeforeRelease(
    section: string,
    opts: { taskPatchSnippet: string; prPatchSnippet: string; commentTmpPath: string },
  ) {
    const blocked = getBlockedBranch(section);

    // status: blocked PATCH to the linked task
    expect(blocked).toContain(opts.taskPatchSnippet);
    expect(blocked).toContain('"status": "blocked"');

    // blocked + blockedReason PATCH fallback to the PR record
    expect(blocked).toContain(opts.prPatchSnippet);
    expect(blocked).toContain("blockedReason");

    // PR comment via temp file
    expect(blocked).toContain(`gh pr comment {pr} --repo {org}/{repo} --body-file ${opts.commentTmpPath}`);
    expect(blocked).toContain(`rm ${opts.commentTmpPath}`);

    // Ordering: status PATCH + comment must occur BEFORE the release call
    const taskPatchIdx = blocked.indexOf(opts.taskPatchSnippet);
    const prPatchIdx = blocked.indexOf(opts.prPatchSnippet);
    const commentIdx = blocked.indexOf(`--body-file ${opts.commentTmpPath}`);
    const releaseIdx = blocked.indexOf("/prs/$PR_RECORD_ID/release");

    expect(releaseIdx).toBeGreaterThan(-1);
    expect(taskPatchIdx).toBeGreaterThan(-1);
    expect(taskPatchIdx).toBeLessThan(releaseIdx);
    expect(prPatchIdx).toBeGreaterThan(-1);
    expect(prPatchIdx).toBeLessThan(releaseIdx);
    expect(commentIdx).toBeGreaterThan(-1);
    expect(commentIdx).toBeLessThan(releaseIdx);
  }

  it("Step 4c BLOCKED branch escalates to HITL (task or PR record) and posts a PR comment before releasing the claim", () => {
    const section = getStep4cSection();
    assertEscalationBeforeRelease(section, {
      taskPatchSnippet: '"$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID"',
      prPatchSnippet: '"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"',
      commentTmpPath: "/tmp/shipwright-patch-blocked-4c-{pr}.txt",
    });
    const blocked = getBlockedBranch(section);
    expect(blocked.toLowerCase()).toContain("merge-conflict");
  });

  it("Step 5c BLOCKED branch (first-round, plain BLOCKED) escalates to HITL and posts a PR comment before releasing the claim", () => {
    const section = getStep5cSection();
    assertEscalationBeforeRelease(section, {
      taskPatchSnippet: '"$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID"',
      prPatchSnippet: '"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"',
      commentTmpPath: "/tmp/shipwright-patch-blocked-5c-{pr}.txt",
    });
    const blocked = getBlockedBranch(section);
    expect(blocked.toLowerCase()).toContain("review-finding fix");
  });

  it("Step 5c's BLOCKED escalation reuses PR_TASK_ID rather than re-fetching taskId", () => {
    const section = getStep5cSection();
    const blocked = getBlockedBranch(section);
    expect(blocked).toContain("PR_TASK_ID");
    expect(blocked).not.toMatch(
      /GET[^\n]*\n[^\n]*"\$SHIPWRIGHT_TASK_STORE_URL\/prs\/\$PR_RECORD_ID"[^\n]*\n[^\n]*taskId/,
    );
  });

  it("Step 6d BLOCKED branch escalates to HITL and posts a PR comment before releasing the claim", () => {
    const section = getStep6dSection();
    assertEscalationBeforeRelease(section, {
      taskPatchSnippet: '"$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID"',
      prPatchSnippet: '"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"',
      commentTmpPath: "/tmp/shipwright-patch-blocked-6d-{pr}.txt",
    });
    const blocked = getBlockedBranch(section);
    expect(blocked.toLowerCase()).toContain("ci-fix");
  });

  it("all three BLOCKED sites use distinct temp file names to avoid cross-worktree collisions", () => {
    expect(content).toContain("/tmp/shipwright-patch-blocked-4c-{pr}.txt");
    expect(content).toContain("/tmp/shipwright-patch-blocked-5c-{pr}.txt");
    expect(content).toContain("/tmp/shipwright-patch-blocked-6d-{pr}.txt");
  });

  it("the existing Step 5a.7 second-round-disagreement escalation is unaffected by the new Step 5c BLOCKED escalation", () => {
    const step5a7Idx = content.indexOf("### Step 5a.7: Second-Round Escalation Check (RPF-1.3)");
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    expect(step5a7Idx).toBeGreaterThan(-1);
    expect(step5bIdx).toBeGreaterThan(step5a7Idx);
    const step5a7Section = content.slice(step5a7Idx, step5bIdx);
    expect(step5a7Section).toContain("/tmp/shipwright-patch-escalation-{pr}.txt");
    expect(step5a7Section).toContain("second-round disagreement");
  });

  it("Step 6d's BLOCKED escalation is consistent with Step 6b.6's pre-dispatch status check (same PATCH targets)", () => {
    const step6b6Idx = content.indexOf("### Step 6b.6: Escalation Check (CFE-1.1)");
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    const step6b6Section = content.slice(step6b6Idx, step6cIdx);
    expect(step6b6Section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"');
    expect(step6b6Section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks/$');

    const step6dSection = getStep6dSection();
    const blocked = getBlockedBranch(step6dSection);
    expect(blocked).toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID"');
    expect(blocked).toContain('"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"');
  });
});

describe("patch.md — docs-first toolchain discovery + per-repo cache (TDF-1.1)", () => {
  function checkSite(step: string, next: string) {
    const stepIdx = content.indexOf(step);
    expect(stepIdx).toBeGreaterThan(-1);
    const nextIdx = content.indexOf(next, stepIdx);
    expect(nextIdx).toBeGreaterThan(stepIdx);
    const section = content.slice(stepIdx, nextIdx);
    expect(section).toContain("state/toolchain-cache/{repo}.json");
    expect(section).toMatch(/CLAUDE\.md.{0,60}docs\/\*\.md.{0,20}ai-docs\/\*\.md/is);
    expect(section).toMatch(/authoritative if found/i);
  }

  it("Step 4a.5 checks the cache before fresh detection, then docs-first, then config-file fallback", () => {
    checkSite("### Step 4a.5: Detect Project Toolchain", "### Step 4a.6");
  });

  it("Step 5a.5 checks the cache before fresh detection, then docs-first, then config-file fallback", () => {
    checkSite("### Step 5a.5: Detect Project Toolchain", "### Step 5a.6");
  });

  it("Step 6a.5 checks the cache before fresh detection, then docs-first, then config-file fallback", () => {
    checkSite("### Step 6a.5: Detect Project Toolchain", "### Step 6b");
  });

  it("does not reference the old single shared cache file", () => {
    expect(content).not.toContain("state/toolchain-cache.json");
  });

  it("stores a tests object for multi-layer test commands at each detection site", () => {
    function checkTestsField(step: string, next: string) {
      const stepIdx = content.indexOf(step);
      const nextIdx = content.indexOf(next, stepIdx);
      const section = content.slice(stepIdx, nextIdx);
      expect(section).toMatch(/\{tests\}/i);
    }
    checkTestsField("### Step 4a.5: Detect Project Toolchain", "### Step 4a.6");
    checkTestsField("### Step 5a.5: Detect Project Toolchain", "### Step 5a.6");
    checkTestsField("### Step 6a.5: Detect Project Toolchain", "### Step 6b");
  });
});

describe("patch.md — Step 2.5/Step 3 opening prose reflects single-PR scope (PCG-1.1)", () => {
  function getStep2_5Section() {
    const step2_5Idx = content.indexOf("## Step 2.5: Handle DIRTY PRs (Auto-Rebase Attempt)");
    const step3Idx = content.indexOf("## Step 3: Classify PRs into Three Lists");
    expect(step2_5Idx).toBeGreaterThan(-1);
    expect(step3Idx).toBeGreaterThan(-1);
    return content.slice(step2_5Idx, step3Idx);
  }

  function getStep3OpeningSection() {
    const step3Idx = content.indexOf("## Step 3: Classify PRs into Three Lists");
    const step3aIdx = content.indexOf("### Step 3a: Check for Unaddressed Review Findings");
    expect(step3Idx).toBeGreaterThan(-1);
    expect(step3aIdx).toBeGreaterThan(-1);
    return content.slice(step3Idx, step3aIdx);
  }

  it("Step 2.5's opening line no longer describes 'each PR discovered in Step 2'", () => {
    const section = getStep2_5Section();
    expect(section).not.toContain("For each PR discovered in Step 2");
  });

  it("Step 2.5's opening line reflects the single target PR resolved in Step 2", () => {
    const section = getStep2_5Section();
    const openingLine =
      section
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .find((line) => !line.trim().startsWith("#")) ?? "";
    expect(openingLine).toMatch(/the (target )?PR resolved in Step 2/i);
  });

  it("Step 3's opening prose no longer says 'each PR' or 'all PRs'", () => {
    const section = getStep3OpeningSection();
    expect(section).not.toContain("each PR");
    expect(section).not.toContain("all PRs");
    expect(section).not.toContain("Work through all PRs before continuing");
  });

  it("Step 3's opening prose reflects checking the single target PR against all three conditions", () => {
    const section = getStep3OpeningSection();
    expect(section).toMatch(/the (target )?PR against all three conditions/i);
  });

  it("Step 3's List A/C/D labels and multi-list membership note are unchanged", () => {
    const section = getStep3OpeningSection();
    expect(section).toContain("**List A** — PRs with unresolved review or PR comments");
    expect(section).toContain("**List C** — PRs with merge conflicts (DIRTY)");
    expect(section).toContain("**List D** — PRs with failing CI");
    expect(section).toMatch(/appear in multiple lists/);
    expect(section).toContain("processed in the order the steps execute (C → A → D)");
  });

  it("does not touch the 'move to the next PR in List X' fallback phrasing deeper in Steps 4-6", () => {
    expect(content).toContain("Move to the next candidate PR in List C");
    expect(content).toContain("Move to the next qualifying PR in List A");
    expect(content).toContain("Move to the next PR in List D");
  });

  it("does not touch the List A/C/D classification labels used later in Steps 3a-3c", () => {
    expect(content).toContain("add it to **List A**");
    expect(content).toContain("add to **List C**");
    expect(content).toContain("add the PR to **List D**");
  });
});

describe("patch.md — end-of-run CI verification gate (PCG-1.1)", () => {
  function getStep6_5Section() {
    const step6_5Idx = content.indexOf("## Step 6.5: Verify CI After Patch");
    const step7Idx = content.indexOf("## Step 7: Report");
    expect(step6_5Idx).toBeGreaterThan(-1);
    expect(step7Idx).toBeGreaterThan(-1);
    return content.slice(step6_5Idx, step7Idx);
  }

  it("Step 6.5 exists between Step 6e (cleanup) and Step 7 (report)", () => {
    const step6eIdx = content.indexOf("### Step 6e: Cleanup Worktree");
    const step6_5Idx = content.indexOf("## Step 6.5: Verify CI After Patch");
    const step7Idx = content.indexOf("## Step 7: Report");
    expect(step6eIdx).toBeGreaterThan(-1);
    expect(step6_5Idx).toBeGreaterThan(step6eIdx);
    expect(step7Idx).toBeGreaterThan(step6_5Idx);
  });

  it("fires only when at least one of Steps 4/5/6 pushed a commit this cycle, and skips cleanly with a one-line message otherwise", () => {
    const section = getStep6_5Section();
    expect(section).toMatch(/Step 4.{0,20}Step 5.{0,20}Step 6|Steps 4[/,].{0,10}5[/,].{0,10}6/is);
    expect(section.toLowerCase()).toContain("pushed");
    expect(section).toMatch(/skip/i);
    // The skip message is a one-liner, not a multi-paragraph explanation.
    const skipLineMatch = section.match(/^.*no.*push.*$/im);
    expect(skipLineMatch).not.toBeNull();
  });

  it("polls the GitHub Actions API for the final HEAD SHA at a bounded cadence (30s interval, ~5 min cap)", () => {
    const section = getStep6_5Section();
    expect(section).toContain("repos/$REPO/actions/runs?head_sha=$HEAD_SHA");
    expect(section).toMatch(/30[\s-]?second|30s/i);
    expect(section).toMatch(/5[\s-]?min/i);
  });

  it("renews the PR claim's heartbeat on every poll iteration", () => {
    const section = getStep6_5Section();
    expect(section).toContain("/prs/$PR_RECORD_ID/heartbeat");
    expect(section).toMatch(/each (poll|iteration)|every (poll|iteration)/i);
  });

  it("skips cleanly if no CI runs are configured for the repo, mirroring the existing no-CI-configured skip pattern", () => {
    const section = getStep6_5Section();
    expect(section.toLowerCase()).toContain("no ci");
    expect(section).toMatch(/skip/i);
  });

  it("on green (or no CI configured), proceeds to the existing Step 7 report unchanged", () => {
    const section = getStep6_5Section();
    expect(section).toContain("Step 7");
  });

  it("on still-red after the poll window, reuses Step 6c's prompt template verbatim instead of duplicating it", () => {
    const section = getStep6_5Section();
    expect(section).toContain("Step 6c");
    expect(section.toLowerCase()).toMatch(/same prompt template|exact same prompt|reus\w* .{0,40}step 6c/i);
    // Must not duplicate Step 6c's actual prompt body text in Step 6.5.
    expect(section).not.toContain("You are fixing failing CI on a pull request");
    expect(section).not.toContain("[A] Diagnose the failures");
  });

  it("dispatches exactly one bonus CI-fix subagent and pushes once, with no re-poll or retry", () => {
    const section = getStep6_5Section();
    expect(section).toMatch(/one|single/i);
    expect(section).toMatch(/no.{0,20}(re-poll|retry|further)/i);
  });

  it("on BLOCKED from the bonus subagent, reuses Step 6d's existing HITL-escalation branch instead of a new escalation path", () => {
    const section = getStep6_5Section();
    expect(section).toContain("Step 6d");
    expect(section.toLowerCase()).toMatch(/same (hitl|escalation)|reus\w* .{0,40}step 6d/i);
    // Must not duplicate Step 6d's escalation procedure text in Step 6.5.
    expect(section).not.toContain("PATCH the linked task to `hitl: true`");
    expect(section).not.toContain("shipwright-patch-blocked-6d-{pr}.txt");
  });

  it("uses the same PATCH-hitl/PR-comment/release convention referenced from Step 6d, not a bespoke mechanism", () => {
    const section = getStep6_5Section();
    expect(section).toMatch(/hitl/i);
  });
});

describe("patch.md — drop stale review-patch reference from claim-release steps (DPF-2.2)", () => {
  it("contains no reference to the removed review-patch command/cron anywhere", () => {
    expect(content.toLowerCase()).not.toContain("review-patch");
  });

  it("all three claim-release steps (4c.3, 5c.3, 6d.3) use the corrected 'a subsequent patch run' phrasing", () => {
    const matches = content.match(/a subsequent patch run/g) ?? [];
    expect(matches.length).toBe(3);
  });
});

describe("patch.md — capture and report CI failure signature (CSD-1.2)", () => {
  function getStep6bSection() {
    const step6bIdx = content.indexOf("### Step 6b: Collect CI Failure Output");
    const step6b5Idx = content.indexOf("### Step 6b.5:");
    expect(step6bIdx).toBeGreaterThan(-1);
    expect(step6b5Idx).toBeGreaterThan(step6bIdx);
    return content.slice(step6bIdx, step6b5Idx);
  }

  function getStep6d5Section() {
    const step6d5Idx = content.indexOf("### Step 6d.5: Upsert PR Record");
    const step6eIdx = content.indexOf("### Step 6e:");
    expect(step6d5Idx).toBeGreaterThan(-1);
    expect(step6eIdx).toBeGreaterThan(step6d5Idx);
    return content.slice(step6d5Idx, step6eIdx);
  }

  it("Step 6b computes the failing-job-name signature via gh run view --json jobs --jq, sorted and comma-joined", () => {
    const section = getStep6bSection();
    expect(section).toContain('gh run view "$RUN_ID" --json jobs');
    expect(section).toContain("--jq");
    expect(section).toContain('select(.conclusion=="failure")');
    expect(section).toContain(".name");
    expect(section).toContain("sort");
    expect(section).toContain('join(",")');
  });

  it("Step 6b stores the computed signature in a CI_FAILURE_SIGNATURE variable", () => {
    const section = getStep6bSection();
    expect(section).toMatch(/CI_FAILURE_SIGNATURE=/);
  });

  it("Step 6b's signature computation runs after the existing RUN_ID/log-collection block", () => {
    const section = getStep6bSection();
    const runIdIdx = section.indexOf("RUN_ID=$(gh run list");
    const logsIdx = section.indexOf("gh run view \"$RUN_ID\" --log --failed");
    const signatureIdx = section.indexOf("CI_FAILURE_SIGNATURE=");
    expect(runIdIdx).toBeGreaterThan(-1);
    expect(logsIdx).toBeGreaterThan(runIdIdx);
    expect(signatureIdx).toBeGreaterThan(logsIdx);
  });

  it("Step 6d.5's POST /prs/:id/patch payload conditionally includes ciFailureSignature when CI_FAILURE_SIGNATURE is set", () => {
    const section = getStep6d5Section();
    // Existing unconditional heartbeat + commitSha patch call remains.
    expect(section).toContain("/prs/$PR_RECORD_ID/heartbeat");
    expect(section).toContain("/prs/$PR_RECORD_ID/patch");
    expect(section).toContain("commitSha");
    // New conditional inclusion of ciFailureSignature.
    expect(section).toContain("ciFailureSignature");
    expect(section).toContain("CI_FAILURE_SIGNATURE");
    // Must be gated by a condition (guarding Steps 4/5's reuse of this same block, which
    // never populate CI_FAILURE_SIGNATURE), not unconditionally appended.
    const codeBlockIdx = section.indexOf("```bash");
    const sigIdx = section.indexOf("ciFailureSignature", codeBlockIdx);
    expect(sigIdx).toBeGreaterThan(-1);
    const before = section.slice(codeBlockIdx, sigIdx);
    expect(before).toMatch(/if\s*\[\s*-n\s*"\$CI_FAILURE_SIGNATURE"/);
  });

  it("Step 6d.5's guard on CI_FAILURE_SIGNATURE mirrors the existing PR_RECORD_ID '-n' guard pattern", () => {
    const section = getStep6d5Section();
    expect(section).toMatch(/if\s*\[\s*-n\s*"\$PR_RECORD_ID"\s*\]/);
    expect(section).toMatch(/if\s*\[\s*-n\s*"\$CI_FAILURE_SIGNATURE"\s*\]/);
  });
});

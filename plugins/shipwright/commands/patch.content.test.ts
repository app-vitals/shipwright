import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATCH_MD_PATH = join(import.meta.dir, "patch.md");
const ESCALATION_PATTERN_PATH = join(import.meta.dir, "references", "escalation-pattern.md");

let content: string;
let escalationPatternContent: string;

beforeAll(() => {
  content = readFileSync(PATCH_MD_PATH, "utf-8");
  escalationPatternContent = readFileSync(ESCALATION_PATTERN_PATH, "utf-8");
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

describe("patch.md — patch-author allowlist (PAS-1.1)", () => {
  it("Step 1 fetches the agent's patchAuthorAllowlist via /agents/{id}/config, mirroring review.md's config-fetch pattern", () => {
    const step1Idx = content.indexOf("## Step 1: Get Own GH Login");
    expect(step1Idx).toBeGreaterThan(-1);
    const step2Idx = content.indexOf("## Step 2: Resolve Target PR");
    expect(step2Idx).toBeGreaterThan(-1);
    const step1Section = content.slice(step1Idx, step2Idx);
    expect(step1Section).toContain("CURRENT_USER=$(gh api /user -q '.login')");
    expect(step1Section).toContain("/agents/$SHIPWRIGHT_AGENT_ID/config");
    expect(step1Section).toContain("patchAuthorAllowlist");
    expect(step1Section).toContain("PATCH_AUTHOR_ALLOWLIST");
  });

  it("documents fail-closed behavior: a failed config fetch or empty/absent allowlist falls back to CURRENT_USER-only", () => {
    const step1Idx = content.indexOf("## Step 1: Get Own GH Login");
    const step2Idx = content.indexOf("## Step 2: Resolve Target PR");
    const step1Section = content.slice(step1Idx, step2Idx);
    expect(step1Section).toMatch(/fail[- ]closed/i);
    expect(step1Section).toContain("today's `CURRENT_USER`-only behavior");
  });

  it("Step 2's scope check widens to author.login == CURRENT_USER OR author.login in PATCH_AUTHOR_ALLOWLIST, preserving the pre-existing CURRENT_USER-only substring", () => {
    const step2Idx = content.indexOf("## Step 2: Resolve Target PR");
    const step2_5Idx = content.indexOf("## Step 2.5:");
    const step2Section = content.slice(step2Idx, step2_5Idx);
    // Pre-existing substring must survive (WLS-3.3's original test pins this exact string).
    expect(step2Section).toContain("author.login != CURRENT_USER");
    // New: the gate must also reference the allowlist as an alternative match.
    expect(step2Section).toContain("PATCH_AUTHOR_ALLOWLIST");
  });

  it("Step 1 keeps the allowlist as a JSON array (jq -c), not a comma-joined string, so Step 2 can test exact membership", () => {
    const step1Idx = content.indexOf("## Step 1: Get Own GH Login");
    const step2Idx = content.indexOf("## Step 2: Resolve Target PR");
    const step1Section = content.slice(step1Idx, step2Idx);
    expect(step1Section).toContain("jq -c '.patchAuthorAllowlist // []'");
    // A comma-joined string is exactly what invites a substring match downstream.
    expect(step1Section).not.toContain('join(",")');
  });

  it("Step 2 shows a concrete exact-membership jq snippet and explicitly warns off the substring form", () => {
    const step2Idx = content.indexOf("## Step 2: Resolve Target PR");
    const step2_5Idx = content.indexOf("## Step 2.5:");
    const step2Section = content.slice(step2Idx, step2_5Idx);
    // The mechanical check must be shown, not just described in prose.
    expect(step2Section).toContain(
      `jq -e --arg a "$PR_AUTHOR" 'any(.[]; . == $a)'`,
    );
    // And the unsafe substring alternative must be called out as forbidden.
    expect(step2Section).toContain(
      `[[ "$PATCH_AUTHOR_ALLOWLIST" == *"$PR_AUTHOR"* ]]`,
    );
    expect(step2Section).toMatch(/never a substring|not a substring|Do \*\*not\*\*/);
  });

  it("Step 2 captures PR_AUTHOR from the gh pr view result for reuse at Step 5a.7", () => {
    const step2Idx = content.indexOf("## Step 2: Resolve Target PR");
    const step2_5Idx = content.indexOf("## Step 2.5:");
    const step2Section = content.slice(step2Idx, step2_5Idx);
    expect(step2Section).toContain("PR_AUTHOR");
  });

  it("Step 5a.7's author-reply detection threads PR_AUTHOR instead of a hardcoded CURRENT_USER-only comparison", () => {
    const step5a7Idx = content.indexOf("### Step 5a.7: Second-Round Escalation Check (RPF-1.3)");
    expect(step5a7Idx).toBeGreaterThan(-1);
    const nextSectionIdx = content.indexOf("### Step 5a.8", step5a7Idx);
    const step5a7End = nextSectionIdx > -1 ? nextSectionIdx : content.indexOf("### Step 5b", step5a7Idx);
    expect(step5a7End).toBeGreaterThan(-1);
    const step5a7Section = content.slice(step5a7Idx, step5a7End);
    expect(step5a7Section).toContain("author.login == PR_AUTHOR");
    expect(step5a7Section).not.toContain("author.login == CURRENT_USER");
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

  it("Step 4c (merge conflicts): BLOCKED path points at the shared escalation pattern, which releases the pre-work claim (PH-1.2)", () => {
    const step4cIdx = content.indexOf("### Step 4c: Handle Subagent Status");
    const step4c5Idx = content.indexOf("### Step 4c.5:");
    expect(step4cIdx).toBeGreaterThan(-1);
    expect(step4c5Idx).toBeGreaterThan(-1);
    const section = content.slice(step4cIdx, step4c5Idx);
    expect(section).toContain("BLOCKED");
    expect(section).toContain("references/escalation-pattern.md");
    expect(escalationPatternContent).toContain("/prs/$PR_RECORD_ID/release");
  });

  it("Step 5c (review findings): BLOCKED path points at the shared escalation pattern, which releases the pre-work claim (PH-1.2)", () => {
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5c5Idx = content.indexOf("### Step 5c.5:");
    expect(step5cIdx).toBeGreaterThan(-1);
    expect(step5c5Idx).toBeGreaterThan(-1);
    const section = content.slice(step5cIdx, step5c5Idx);
    expect(section).toContain("BLOCKED");
    expect(section).toContain("references/escalation-pattern.md");
    expect(escalationPatternContent).toContain("/prs/$PR_RECORD_ID/release");
  });

  it("Step 6d (failing CI): BLOCKED path points at the shared escalation pattern, which releases the pre-work claim (PH-1.2)", () => {
    const step6dIdx = content.indexOf("### Step 6d: Handle Subagent Status");
    const step6d5Idx = content.indexOf("### Step 6d.5:");
    expect(step6dIdx).toBeGreaterThan(-1);
    expect(step6d5Idx).toBeGreaterThan(-1);
    const section = content.slice(step6dIdx, step6d5Idx);
    expect(section).toContain("BLOCKED");
    expect(section).toContain("references/escalation-pattern.md");
    expect(escalationPatternContent).toContain("/prs/$PR_RECORD_ID/release");
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

describe("patch.md — no manual reviewState reset; ledger write is the sole re-review trigger (PFL-4.1)", () => {
  it("Step 5c always proceeds to Step 5c.5 for both the mixed-push and no-push cases", () => {
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5c5Idx = content.indexOf("### Step 5c.5:");
    const section = content.slice(step5cIdx, step5c5Idx);

    expect(section).toContain("DONE_WITH_CONCERNS");
    expect(section).toMatch(/proceed(s)? to Step 5c\.5/i);
    expect(section.toLowerCase()).toContain("mixed");
    expect(section).toContain("no-push");
    expect(section).not.toContain("ALL_REJECT_NO_PUSH_REBUTTAL_CONFIRMED");
    // The manual reviewState reset's own gating variable is gone — PFL-4.1 removed it
    // entirely, along with the reset it used to gate.
    expect(section).not.toContain("NO_PUSH_REBUTTAL_CONFIRMED");
  });

  it("Step 5c.5 no longer PATCHes /prs/{id} with reviewState:pending — the manual reset is fully removed", () => {
    const step5c5Idx = content.indexOf("### Step 5c.5: Upsert PR Record");
    const step5dIdx = content.indexOf("### Step 5d:");
    expect(step5c5Idx).toBeGreaterThan(-1);
    expect(step5dIdx).toBeGreaterThan(-1);
    const section = content.slice(step5c5Idx, step5dIdx);

    // Existing unconditional heartbeat + commitSha patch calls remain.
    expect(section).toContain("/prs/$PR_RECORD_ID/heartbeat");
    expect(section).toContain("/prs/$PR_RECORD_ID/patch");
    expect(section).toContain("commitSha");

    // No manual reviewState reset anywhere in this step.
    expect(section).not.toContain("NO_PUSH_REBUTTAL_CONFIRMED");
    expect(section).not.toContain('"reviewState": "pending"');
    expect(section).not.toContain("reviewState reset failed");
  });

  it("Step 5c.5 documents the ledger POST as the sole mechanism re-qualifying a no-push rebuttal cycle for review, citing PFL-3.1's hasFreshLedgerFinding", () => {
    const step5c5Idx = content.indexOf("### Step 5c.5: Upsert PR Record");
    const step5dIdx = content.indexOf("### Step 5d:");
    const section = content.slice(step5c5Idx, step5dIdx);

    expect(section).toContain("hasFreshLedgerFinding");
    expect(section).toContain("PFL-3.1");
    expect(section.toLowerCase()).toContain("sole mechanism");
    expect(section).toContain("PFL-4.1");
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
    // there is no reviewState reset anywhere now (PFL-4.1).
    expect(dSection).not.toContain("reviewState");
  });
});

describe("patch.md — POST a rejected ledger entry on rebuttal (PFL-2.2)", () => {
  it("Step 5c.5 POSTs a source:patch, disposition:rejected ledger entry to /prs/:id/findings for each REJECTed finding", () => {
    const step5c5Idx = content.indexOf("### Step 5c.5: Upsert PR Record");
    const step5dIdx = content.indexOf("### Step 5d:");
    expect(step5c5Idx).toBeGreaterThan(-1);
    expect(step5dIdx).toBeGreaterThan(-1);
    const section = content.slice(step5c5Idx, step5dIdx);

    expect(section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/findings"');
    expect(section).toContain('\\"source\\": \\"patch\\"');
    expect(section).toContain('\\"disposition\\": \\"rejected\\"');
  });

  it("the ledger POST runs alongside the existing rebuttal comment + thread resolution, unconditionally whenever findings were REJECTed", () => {
    const step5c5Idx = content.indexOf("### Step 5c.5: Upsert PR Record");
    const step5dIdx = content.indexOf("### Step 5d:");
    const section = content.slice(step5c5Idx, step5dIdx);

    const findingsIdx = section.indexOf("/prs/$PR_RECORD_ID/findings");
    expect(findingsIdx).toBeGreaterThan(-1);
    // No reviewState reset for it to be gated on or nested inside anymore.
    expect(section).not.toContain('"reviewState": "pending"');
    expect(section).not.toContain("NO_PUSH_REBUTTAL_CONFIRMED");
  });

  it("Step 5c tracks REJECTed findings this cycle (ref + rejection reason), for Step 5c.5 to loop over", () => {
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5c5Idx = content.indexOf("### Step 5c.5:");
    const section = content.slice(step5cIdx, step5c5Idx);

    expect(section).toContain("REJECTED_FINDINGS_THIS_CYCLE");
  });

  it("the ledger POST call follows the same warn-and-continue error-handling idiom as the other Step 5c.5 task-store calls", () => {
    const step5c5Idx = content.indexOf("### Step 5c.5: Upsert PR Record");
    const step5dIdx = content.indexOf("### Step 5d:");
    const section = content.slice(step5c5Idx, step5dIdx);

    const findingsIdx = section.indexOf("/prs/$PR_RECORD_ID/findings");
    const after = section.slice(findingsIdx, findingsIdx + 400);
    expect(after).toMatch(/\|\|\s*\\?\s*\n\s*echo "⚠/);
  });

  it("Step 5c.5 findings POST includes agentId set to $SHIPWRIGHT_AGENT_ID", () => {
    const step5c5Idx = content.indexOf("### Step 5c.5: Upsert PR Record");
    const step5dIdx = content.indexOf("### Step 5d:");
    const section = content.slice(step5c5Idx, step5dIdx);

    expect(section).toContain('\\\"agentId\\\": \\\"$SHIPWRIGHT_AGENT_ID\\\"');
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

  it("escalation case reuses the shared PR_TASK_ID from Step 2.1, and the shared escalation pattern PATCHes status: blocked (no fresh taskId fetch) (PH-1.2)", () => {
    const section = getStep5a7Section();
    expect(section).toContain("PR_TASK_ID");
    // No independent GET .../prs/$PR_RECORD_ID fetch for taskId purposes anymore — that
    // resolution now lives once in Step 2.1 (MTR-2.1) and is only referenced here.
    expect(section).not.toMatch(
      /GET[^\n]*\n[^\n]*"\$SHIPWRIGHT_TASK_STORE_URL\/prs\/\$PR_RECORD_ID"[^\n]*\n[^\n]*taskId/,
    );
    expect(section).toMatch(/Step 2\.1|reuse/i);
    expect(section).toContain("references/escalation-pattern.md");
    expect(escalationPatternContent).toContain("-X PATCH");
    expect(escalationPatternContent).toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID"');
    expect(escalationPatternContent).toContain('"status": "blocked"');
  });

  it("escalation case's {blockedReason} is stated inline, and the shared pattern PATCHes the PR record with blocked: true when no task is linked (PH-1.2)", () => {
    const section = getStep5a7Section();
    expect(section).toContain("second-round disagreement between reviewer and automated fix");
    expect(section).toContain("references/escalation-pattern.md");
    const patchPrSnippet =
      '"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID" \\\n  -d \'{"blocked": true, "blockedReason"';
    expect(escalationPatternContent).toContain("PR_TASK_ID` is empty");
    expect(escalationPatternContent).not.toContain("log a warning and skip the");
    expect(escalationPatternContent).toContain(
      `curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  ${patchPrSnippet}`,
    );
    const emptyBranchIdx = escalationPatternContent.indexOf("PR_TASK_ID` is empty");
    const patchPrIdx = escalationPatternContent.indexOf(patchPrSnippet);
    expect(patchPrIdx).toBeGreaterThan(emptyBranchIdx);
  });

  it("escalation case states its {temp_file_slug}/comment inline, and the shared pattern posts exactly one PR comment via a temp file scoped by PR number (PH-1.2)", () => {
    const section = getStep5a7Section();
    expect(section).toContain("references/escalation-pattern.md");
    expect(section).toContain("`escalation`");
    expect(section).toContain("/tmp/shipwright-patch-escalation-{pr}.txt");
    expect(escalationPatternContent).toContain(
      "gh pr comment {pr} --repo {org}/{repo} --body-file /tmp/shipwright-patch-{temp_file_slug}-{pr}.txt",
    );
    expect(escalationPatternContent).toContain("rm /tmp/shipwright-patch-{temp_file_slug}-{pr}.txt");
  });

  it("escalation case releases the pre-work claim (via the shared pattern) and skips to the next PR without dispatching a fix subagent", () => {
    const section = getStep5a7Section();
    expect(section).toContain("references/escalation-pattern.md");
    expect(escalationPatternContent).toContain("/prs/$PR_RECORD_ID/release");
    expect(section).toContain("do not dispatch the fix subagent");
    expect(section).toContain("do not post another rebuttal");
    expect(section).toContain("do not reset");
    expect(section).toContain("Move to the next qualifying PR in List A");
  });

  it("escalation case resolves the unresolved inline threads for the qualifying second-round review before releasing the claim (site-specific hook step, per escalation-pattern.md)", () => {
    const section = getStep5a7Section();
    expect(section).toContain("resolveReviewThread");
    expect(section).toContain("re-flag this same PR next");
    expect(section).toContain("Extra step, unique to this site");
    const resolveIdx = section.indexOf("resolveReviewThread");
    const releaseNoteIdx = section.indexOf("Claim released");
    expect(resolveIdx).toBeGreaterThan(-1);
    // The site documents the thread-resolution step; the actual release call lives in the
    // shared reference (verified above) and happens after this site-specific hook per
    // escalation-pattern.md's step 3/4 ordering.
    expect(releaseNoteIdx).toBeGreaterThan(-1);
    expect(escalationPatternContent).toContain("Site-specific hook point");
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

  it("queries GET /tasks?repo=&pr= directly instead of reading PR_RECORD.taskId", () => {
    const section = getStep6b6Section();
    expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks?repo={org}/{repo}&pr={pr}");
    // No jq extraction of .taskId off the PR record anymore.
    expect(section).not.toMatch(/jq -r '\.taskId/);
    expect(section).not.toContain('echo "$PR_RECORD" | jq -r \'.taskId');
  });

  it("treats the PR as HITL-escalated if ANY matched task has hitl===true OR status==='blocked' (OR across all matches, mirrors PTL-1.1's check-helpers.ts semantics)", () => {
    const section = getStep6b6Section();
    expect(section).toContain("TASK_BLOCKED");
    expect(section).toMatch(/hitl.{0,20}(===|==)\s*true/i);
    expect(section).toMatch(/status.{0,20}(===|==)\s*['"]blocked['"]/i);
    expect(section.toLowerCase()).toContain("any");
    expect(section).toContain("PTL-1.1");
    expect(section).toContain("check-helpers.ts");
  });

  it("zero-match fallback at Step 6b.6 is unchanged: only PR_BLOCKED (from the PR record) matters, no task-based escalation signal", () => {
    const section = getStep6b6Section();
    expect(section).toMatch(/no (matching )?tasks?.{0,60}(found|match)/i);
    expect(section.toLowerCase()).toContain("no task-based escalation signal");
  });

  it("Step 6b.6 exposes a single PR_TASK_ID (first matched task, or empty if none) for Step 6d's downstream BLOCKED-escalation reuse", () => {
    const section = getStep6b6Section();
    expect(section).toContain("PR_TASK_ID");
    expect(section.toLowerCase()).toMatch(/first match|first task/i);
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
    const step6b8Idx = content.indexOf(
      "### Step 6b.8: Rerun-First for Cancelled-Only CI (PCC-1.1)",
    );
    expect(step6b7Idx).toBeGreaterThan(-1);
    expect(step6b8Idx).toBeGreaterThan(-1);
    return content.slice(step6b7Idx, step6b8Idx);
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

  it("otherwise branch (bundle complete) proceeds to Step 6b.8 (which itself falls through to Step 6c) and does not emit [silent]", () => {
    const section = getStep6b7Section();
    const otherwiseIdx = section.indexOf("**Otherwise**");
    expect(otherwiseIdx).toBeGreaterThan(-1);
    const otherwiseSection = section.slice(otherwiseIdx);
    expect(otherwiseSection).toContain("Step 6b.8");
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

  it("Step 2.1 resolves matched tasks via GET /tasks?repo=&pr= directly, not PullRequest.taskId", () => {
    const section = getStep2_1Section();
    expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks?repo={org}/{repo}&pr={pr}");
    expect(section).not.toContain("$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&prNumber={pr}");
    expect(section).not.toContain(".prs[0].taskId");
  });

  it("Step 2.1 escalates the HIGHEST model tier among ALL matched tasks (mirrors PTL-1.2's review.md rule)", () => {
    const section = getStep2_1Section();
    expect(section.toLowerCase()).toContain("highest tier");
    expect(section).toMatch(/all match(ed|es)/i);
    expect(section).toContain("PTL-1.2");
  });

  it("Step 2.1 has real jq/bash computing PATCH_MODEL and PR_TASK_ID from $MATCHED_TASKS, not just prose (mirrors Step 6b.6's jq mechanics)", () => {
    const section = getStep2_1Section();
    // Must reference the tasks array and each task's model field via jq, not just describe
    // the computation in prose.
    expect(section).toMatch(/\.tasks\[\]/);
    expect(section).toMatch(/\.model/);
    expect(section).toContain("jq -r");
    expect(section).toContain("echo \"$MATCHED_TASKS\"");
    // Must actually assign both output variables from that jq, not just declare them.
    expect(section).toMatch(/PATCH_MODEL=\$\(/);
    expect(section).toMatch(/PR_TASK_ID=\$\(/);
  });

  it("Step 2.1 still resolves a single PR_TASK_ID scalar for downstream single-task escalation-PATCH reuse, and documents why", () => {
    const section = getStep2_1Section();
    expect(section).toContain("PR_TASK_ID");
    // Must explain the single-scalar choice explicitly, since the model-tier calc now
    // considers multiple matches but downstream consumers still PATCH one task.
    expect(section.toLowerCase()).toMatch(/downstream|escalation-patch consumers/i);
  });

  it("Step 2.1's zero-match fallback is unchanged: PATCH_MODEL=sonnet, warning, not a hard stop", () => {
    const section = getStep2_1Section();
    expect(section).toMatch(/no (matching )?tasks?.{0,60}(found|match)/i);
    expect(section).toMatch(/PATCH_MODEL\s*=\s*"?sonnet"?/);
    expect(section.toLowerCase()).toContain("no escalation");
    expect(section.toLowerCase()).toContain("not a hard stop");
    expect(section).toContain("⚠");
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

  // PH-1.2: the literal PATCH/comment/release curl sequence lives once in
  // references/escalation-pattern.md now, rather than being repeated at each of the 4 call
  // sites. Verify the shared file's sequencing once, then verify each call site (a) points
  // at the shared reference and (b) still carries its own distinct blockedReason/comment/
  // temp-file-slug parameter values inline.
  function assertSharedPatternSequencing() {
    // status: blocked PATCH to the linked task
    expect(escalationPatternContent).toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID"');
    expect(escalationPatternContent).toContain('"status": "blocked"');

    // blocked + blockedReason PATCH fallback to the PR record
    expect(escalationPatternContent).toContain('"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"');
    expect(escalationPatternContent).toContain("blockedReason");

    // PR comment via temp file
    expect(escalationPatternContent).toContain(
      "gh pr comment {pr} --repo {org}/{repo} --body-file /tmp/shipwright-patch-{temp_file_slug}-{pr}.txt",
    );
    expect(escalationPatternContent).toContain("rm /tmp/shipwright-patch-{temp_file_slug}-{pr}.txt");

    // Ordering: status PATCH + comment must occur BEFORE the release call
    const taskPatchIdx = escalationPatternContent.indexOf(
      '"$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID"',
    );
    const prPatchIdx = escalationPatternContent.indexOf(
      '"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"',
    );
    const commentIdx = escalationPatternContent.indexOf("--body-file /tmp/shipwright-patch-");
    const releaseIdx = escalationPatternContent.indexOf("/prs/$PR_RECORD_ID/release");

    expect(releaseIdx).toBeGreaterThan(-1);
    expect(taskPatchIdx).toBeGreaterThan(-1);
    expect(taskPatchIdx).toBeLessThan(releaseIdx);
    expect(prPatchIdx).toBeGreaterThan(-1);
    expect(prPatchIdx).toBeLessThan(releaseIdx);
    expect(commentIdx).toBeGreaterThan(-1);
    expect(commentIdx).toBeLessThan(releaseIdx);
  }

  it("the shared escalation-pattern.md sequences task/PR PATCH + PR comment before the claim release", () => {
    assertSharedPatternSequencing();
  });

  it("Step 4c BLOCKED branch points at the shared escalation pattern and states its own blockedReason/comment/temp-file-slug inline", () => {
    const section = getStep4cSection();
    const blocked = getBlockedBranch(section);
    expect(blocked).toContain("references/escalation-pattern.md");
    expect(blocked).toContain(
      '"merge-conflict resolution blocked — automated conflict\n    resolution could not complete"',
    );
    expect(blocked.toLowerCase()).toContain("merge-conflict resolution subagent reported blocked");
    expect(blocked).toContain("`blocked-4c`");
    expect(blocked).toContain("/tmp/shipwright-patch-blocked-4c-{pr}.txt");
    expect(blocked).toContain("Step 2.1");
  });

  it("Step 5c BLOCKED branch (first-round, plain BLOCKED) points at the shared escalation pattern and states its own blockedReason/comment/temp-file-slug inline", () => {
    const section = getStep5cSection();
    const blocked = getBlockedBranch(section);
    expect(blocked).toContain("references/escalation-pattern.md");
    expect(blocked).toContain(
      '"review-finding fix blocked — automated fix subagent could not\n    complete"',
    );
    expect(blocked.toLowerCase()).toContain("review-finding fix subagent reported blocked");
    expect(blocked).toContain("`blocked-5c`");
    expect(blocked).toContain("/tmp/shipwright-patch-blocked-5c-{pr}.txt");
    expect(blocked).toContain("Step 2.1");
  });

  it("Step 5c's BLOCKED escalation reuses PR_TASK_ID rather than re-fetching taskId", () => {
    const section = getStep5cSection();
    const blocked = getBlockedBranch(section);
    expect(blocked).toContain("PR_TASK_ID");
    expect(blocked).not.toMatch(
      /GET[^\n]*\n[^\n]*"\$SHIPWRIGHT_TASK_STORE_URL\/prs\/\$PR_RECORD_ID"[^\n]*\n[^\n]*taskId/,
    );
  });

  it("Step 6d BLOCKED branch points at the shared escalation pattern and states its own blockedReason/comment/temp-file-slug inline", () => {
    const section = getStep6dSection();
    const blocked = getBlockedBranch(section);
    expect(blocked).toContain("references/escalation-pattern.md");
    expect(blocked).toContain(
      '"CI-fix blocked — automated CI-fix subagent could not\n    complete"',
    );
    expect(blocked.toLowerCase()).toContain("ci-fix subagent reported blocked");
    expect(blocked).toContain("`blocked-6d`");
    expect(blocked).toContain("/tmp/shipwright-patch-blocked-6d-{pr}.txt");
    // Distinct from the other two BLOCKED sites: this one reuses PR_TASK_ID from Step 6b.6,
    // not Step 2.1.
    expect(blocked).toContain("Step 6b.6");
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

  it("Step 6d's BLOCKED escalation is consistent with Step 6b.6's pre-dispatch status check (same PATCH targets, via the shared escalation pattern)", () => {
    const step6b6Idx = content.indexOf("### Step 6b.6: Escalation Check (CFE-1.1)");
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    const step6b6Section = content.slice(step6b6Idx, step6cIdx);
    expect(step6b6Section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"');
    expect(step6b6Section).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks?repo={org}/{repo}&pr={pr}");

    const step6dSection = getStep6dSection();
    const blocked = getBlockedBranch(step6dSection);
    expect(blocked).toContain("references/escalation-pattern.md");
    // The shared pattern Step 6d points at uses the same two PATCH targets as Step 6b.6's
    // own pre-dispatch check.
    expect(escalationPatternContent).toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID"');
    expect(escalationPatternContent).toContain('"$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID"');
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

  it("the shared escalation-pattern.md reference uses the corrected 'a subsequent patch run' phrasing (PH-1.2 collapsed the 3 formerly-separate inline copies into this one)", () => {
    const matches = escalationPatternContent.match(/a subsequent patch run/g) ?? [];
    expect(matches.length).toBe(1);
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

describe("patch.md — detect stale-cancelled CI, rerun before escalating to CI-fix (PCC-1.1)", () => {
  function getStep3cSection() {
    const step3cIdx = content.indexOf(
      "### Step 3c: Check for Failing CI (for PRs not in List C)",
    );
    const step3dIdx = content.indexOf("### Step 3d: Summary");
    expect(step3cIdx).toBeGreaterThan(-1);
    expect(step3dIdx).toBeGreaterThan(step3cIdx);
    return content.slice(step3cIdx, step3dIdx);
  }

  function getStep6b8Section() {
    const step6b8Idx = content.indexOf(
      "### Step 6b.8: Rerun-First for Cancelled-Only CI (PCC-1.1)",
    );
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    expect(step6b8Idx).toBeGreaterThan(-1);
    expect(step6cIdx).toBeGreaterThan(step6b8Idx);
    return content.slice(step6b8Idx, step6cIdx);
  }

  it("Step 3c independently detects cancelled CI using the same latest-run-per-workflow dedup, distinct from the failure/timed_out check", () => {
    const section = getStep3cSection();
    expect(section).toContain('conclusion == "cancelled"');
    expect(section).toContain("CI_HAS_CANCELLED");
    expect(section).toContain("CI_HAS_FAILING");
    expect(section).toContain("CANCELLED_RUN_ID");
    expect(section).toContain("independently");
    expect(section).toContain("not mutually exclusive with");
  });

  it("Step 3c records that a cancelled-only PR (no CI_HAS_FAILING) routes to the new Step 6b.8 branch", () => {
    const section = getStep3cSection();
    expect(section).toContain("Step 6b.8");
    expect(section).toContain("cancelled-only");
  });

  it("Step 6b.8 exists between Step 6b.7 (bundle gate) and Step 6c (dispatch)", () => {
    const step6b7Idx = content.indexOf(
      "### Step 6b.7: Bundle Completeness Gate (PH-1.1)",
    );
    const step6b8Idx = content.indexOf(
      "### Step 6b.8: Rerun-First for Cancelled-Only CI (PCC-1.1)",
    );
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    expect(step6b7Idx).toBeGreaterThan(-1);
    expect(step6b8Idx).toBeGreaterThan(step6b7Idx);
    expect(step6cIdx).toBeGreaterThan(step6b8Idx);
  });

  it("Step 6b.7's otherwise branch hands off to Step 6b.8, not straight to 6c", () => {
    const step6b7Idx = content.indexOf(
      "### Step 6b.7: Bundle Completeness Gate (PH-1.1)",
    );
    const step6b8Idx = content.indexOf(
      "### Step 6b.8: Rerun-First for Cancelled-Only CI (PCC-1.1)",
    );
    const section = content.slice(step6b7Idx, step6b8Idx);
    const otherwiseIdx = section.indexOf("**Otherwise**");
    expect(otherwiseIdx).toBeGreaterThan(-1);
    const otherwiseSection = section.slice(otherwiseIdx);
    expect(otherwiseSection).toContain("Step 6b.8");
  });

  it("gates the rerun-first branch on cancelled-only, no failure/timed_out", () => {
    const section = getStep6b8Section();
    expect(section.toLowerCase()).toContain("cancelled-only, no failure/timed_out");
    expect(section).toContain("CI_HAS_CANCELLED=true");
    expect(section).toContain("CI_HAS_FAILING");
    expect(section).toMatch(/CI_HAS_FAILING.{0,40}NOT also true/is);
  });

  it("a PR with a genuine failure/timed_out run skips this step entirely and proceeds directly to Step 6c", () => {
    const section = getStep6b8Section();
    expect(section).toMatch(
      /does not hold.{0,400}proceed directly to\s+Step 6c/is,
    );
    expect(section).toContain("completely unaffected by the cancelled-only branch");
  });

  it("does not treat cancelled as failure-equivalent for concurrency/cancel-in-progress workflows — scoped to run state, not workflow identity", () => {
    const section = getStep6b8Section();
    for (const workflow of [
      "chart-release.yml",
      "sync-plugin-version.yml",
      "auto-bump-chart.yml",
      "deploy-site.yml",
    ]) {
      expect(section).toContain(workflow);
    }
    expect(section).toContain("concurrency");
    expect(section.toLowerCase()).toMatch(/not to workflow\s+identity/);
    expect(section.toLowerCase()).toContain("no-op");
  });

  it("calls `gh run rerun` for the cancelled run, with no commit and no subagent dispatch in this branch", () => {
    const section = getStep6b8Section();
    expect(section).toContain("gh run rerun");
    expect(section).toContain("$CANCELLED_RUN_ID");
    expect(section).toContain("no commit");
    expect(section).toContain("no subagent dispatch");
  });

  it("polls for a terminal result with a brief, bounded cadence distinct from Step 6.5a's 30s/10-poll gate", () => {
    const section = getStep6b8Section();
    expect(section).toContain("gh run view");
    expect(section).toMatch(/status.{0,20}conclusion/is);
    expect(section).toMatch(/15 seconds/);
    expect(section).toMatch(/8 times/);
    expect(section).toContain("queued");
    expect(section).toContain("in_progress");
    expect(section).toContain("waiting");
  });

  it("renews the claim heartbeat on each poll iteration, same as other polling loops", () => {
    const section = getStep6b8Section();
    expect(section).toContain("/prs/$PR_RECORD_ID/heartbeat");
  });

  it("treats an exhausted poll window with no terminal result as inconclusive and falls through to Step 6c", () => {
    const section = getStep6b8Section();
    expect(section.toLowerCase()).toContain("inconclusive");
    expect(section).toMatch(/exhausted.{0,200}Step 6c/is);
  });

  it("on a successful (or other non-cancelled/non-failure terminal) rerun, skips Step 6c, releases the claim, and moves to the next PR in List D", () => {
    const section = getStep6b8Section();
    expect(section).toContain("Skip Step 6c entirely");
    expect(section).toContain("/prs/$PR_RECORD_ID/release");
    expect(section).toContain("next PR in List D");
  });

  it("falls through to Step 6c only when the rerun itself ends cancelled or failure (or times out inconclusively)", () => {
    const section = getStep6b8Section();
    expect(section).toContain("ends `cancelled` or `failure`");
    expect(section).toContain("repeated-timeout/hang signal");
    expect(section).not.toContain("normal test failure");
  });

  it("collects the job's abnormal duration vs. typical duration from the Actions API for the Step 6c prompt", () => {
    const section = getStep6b8Section();
    expect(section).toContain("actions/runs/$CANCELLED_RUN_ID/jobs");
    expect(section).toContain("started_at");
    expect(section).toContain("completed_at");
    expect(section).toContain("typical duration");
  });

  it("Step 6c's prompt construction notes the repeated-timeout/hang context when arriving via Step 6b.8", () => {
    const step6cIdx = content.indexOf("### Step 6c: Dispatch Fix Subagent");
    const step6dIdx = content.indexOf("### Step 6d: Handle Subagent Status");
    expect(step6cIdx).toBeGreaterThan(-1);
    expect(step6dIdx).toBeGreaterThan(step6cIdx);
    const section = content.slice(step6cIdx, step6dIdx);
    expect(section).toContain("REPEATED TIMEOUT/HANG SIGNAL");
    expect(section).toContain("Step 6b.8");
    expect(section).toContain("repeated-timeout-context");
    expect(section.toLowerCase()).toMatch(/not a normal test\s+failure/);
  });
});

describe("patch.md — no-op at dispatch skip-reason tag (RVD-2.4)", () => {
  function getStep3dSection() {
    const step3dIdx = content.indexOf("### Step 3d: Summary");
    const step4Idx = content.indexOf("## Step 4: Resolve Merge Conflicts");
    expect(step3dIdx).toBeGreaterThan(-1);
    expect(step4Idx).toBeGreaterThan(step3dIdx);
    return content.slice(step3dIdx, step4Idx);
  }

  it("Step 3d (empty lists) contains [skip-reason:patch:deferred:no-op-at-dispatch:{pr}] alongside [silent]", () => {
    const section = getStep3dSection();
    expect(section).toContain("[silent]");
    expect(section).toContain(
      "[skip-reason:patch:deferred:no-op-at-dispatch:",
    );
    expect(section).toContain(
      "[skip-reason:patch:deferred:no-op-at-dispatch:{pr}]",
    );
  });

  it("does not require a specific ordering between [skip-reason:...] and [silent]", () => {
    const section = getStep3dSection();
    expect(section).toContain("does not matter");
  });

  it("explains that this differs from review.md's RVD-2.2/2.3 because getPatchCandidates() has no persisted cache drift", () => {
    const section = getStep3dSection();
    const hasExplanation =
      section.indexOf("getPatchCandidates") > -1 &&
      section.indexOf("no persisted") > -1;
    expect(hasExplanation).toBe(true);
  });
});

describe("patch.md — dependency-risk detection (DBP-1.2)", () => {
  function getStep3a5Section() {
    const step3a5Idx = content.indexOf("### Step 3a.5: Dependency-Risk Detection (DBP-1.2)");
    const step3bIdx = content.indexOf("### Step 3b: Check for DIRTY State");
    expect(step3a5Idx).toBeGreaterThan(-1);
    expect(step3bIdx).toBeGreaterThan(step3a5Idx);
    return content.slice(step3a5Idx, step3bIdx);
  }

  it("Step 3a.5 exists between Step 3a and Step 3b", () => {
    const step3aIdx = content.indexOf('### Step 3a: Check for Unaddressed Review Findings');
    const step3a5Idx = content.indexOf("### Step 3a.5: Dependency-Risk Detection (DBP-1.2)");
    const step3bIdx = content.indexOf("### Step 3b: Check for DIRTY State");
    expect(step3aIdx).toBeGreaterThan(-1);
    expect(step3a5Idx).toBeGreaterThan(step3aIdx);
    expect(step3bIdx).toBeGreaterThan(step3a5Idx);
  });

  it("does not try to recover the finding by scanning review bodies — that fast path could never match posted data", () => {
    const section = getStep3a5Section();
    // The full **Recommendation**/**Flags**/**Reasoning** block only ever lands in the
    // local state/reviews/PR_REVIEW_{pr}.md narrative (review.md:782), which is never
    // posted; the GitHub-posted body carries only a condensed one-line clause with no
    // flags (review.md:1118-1126). So no parse step may set DEPENDENCY_RISK_FINDING from
    // a review body — the section must explain that rather than attempt it.
    expect(section).not.toMatch(/parse\s+`?\{recommendation, flags, reasoning\}`?\s+from/i);
    expect(section).toContain("PR_REVIEW_{pr}.md");
    expect(section).toContain("review.md:1118-1126");
    expect(section).toMatch(/could never match real posted data/i);
    expect(section).toMatch(/`flags`\s+is\s+absent from it entirely/i);
  });

  it("derives the finding from the PR's own diff, invoking resolve-dependency-watched-paths.ts and referencing dependency-risk-analysis.md by name", () => {
    const section = getStep3a5Section();
    expect(section).toContain("resolve-dependency-watched-paths.ts");
    expect(section).toContain("references/dependency-risk-analysis.md");
  });

  it("derivation mirrors review.md's Step 5.8 without assuming a worktree exists yet", () => {
    const section = getStep3a5Section();
    expect(section).toContain("review.md");
    expect(section).toContain("Step 5.8");
    expect(section).toContain("gh api");
    expect(section).toContain("gh pr diff {pr} --repo {org}/{repo} --name-only");
  });

  it("has no dependency on any review-session state ever having existed", () => {
    const section = getStep3a5Section();
    expect(section.toLowerCase()).toContain("independently");
    expect(section).toContain("any agent can claim either phase");
  });

  it("when not triggered, DEPENDENCY_RISK_FINDING stays unset for the PR", () => {
    const section = getStep3a5Section();
    expect(section).toMatch(/DEPENDENCY_RISK_FINDING.{0,40}stays\s+unset/is);
  });

  it("routes a hold/review recommendation into List A directly, since a dependency-bump-only PR can still get a clean Verdict: APPROVE", () => {
    const section = getStep3a5Section();
    expect(section).toMatch(/route.{0,60}(?:"hold"|hold).{0,60}(?:"review"|review).{0,80}List A/is);
    expect(section).toContain("Verdict: APPROVE");
    expect(section).toContain("compute-review-verdict.ts");
    expect(section.toLowerCase()).toContain("regardless of whether step 3a's own criteria");
  });

  it("a merge recommendation does not affect List A membership", () => {
    const section = getStep3a5Section();
    expect(section).toMatch(/"merge".{0,60}nothing to remediate and does\s+not\s+affect List A/is);
  });

  it("has an already-held exclusion so a held finding is not re-routed into List A every cycle", () => {
    const section = getStep3a5Section();
    expect(section).toMatch(/already-held exclusion/i);
    expect(section).toContain("Independence Principle #6");
    expect(section).toContain("Skills Are Idempotent");
    // The exclusion must be positioned as the analogue of Step 3a's own
    // resolved/replied/superseded state, which this finding inherently lacks.
    expect(section).toContain("isResolved");
    expect(section).toMatch(/synthesized fresh from the diff on every cycle/i);
  });

  it("the already-held exclusion reads the findings ledger keyed on a HEAD-SHA-scoped ref, so it self-expires on a new commit", () => {
    const section = getStep3a5Section();
    expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&prNumber={pr}");
    expect(section).toContain("dependency-risk@{headRefOid}");
    expect(section).toContain('disposition == "rejected"');
    expect(section).toMatch(/self-expiring/i);
    // headRefOid comes from Step 3a's existing query — no extra GitHub round trip.
    expect(section).toMatch(/no extra GitHub call/i);
  });

  it("the already-held exclusion fails open — a missing or unreadable ledger never suppresses a first-round remediation", () => {
    const section = getStep3a5Section();
    expect(section).toMatch(/HELD_DEP_FINDINGS.{0,120}(`0`|empty).{0,200}route normally/is);
    expect(section).toMatch(/must never suppress a first-round remediation/i);
  });

  it("an excluded already-held finding still leaves ordinary Step 3a findings free to route the PR into List A", () => {
    const section = getStep3a5Section();
    expect(section).toMatch(/leave its List A membership entirely to Step 3a's own\s+criteria/i);
    expect(section).toMatch(/omit Step 5b's DEPENDENCY-RISK REMEDIATION PROTOCOL block/i);
  });
});

describe("patch.md — dependency-patch protocol injected into Step 5b (DBP-1.2)", () => {
  function getStep5bPromptSection() {
    const step5bIdx = content.indexOf("### Step 5b: Dispatch Fix Subagent");
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    expect(step5bIdx).toBeGreaterThan(-1);
    expect(step5cIdx).toBeGreaterThan(-1);
    return content.slice(step5bIdx, step5cIdx);
  }

  it("Step 5b's prompt includes a DEPENDENCY-RISK REMEDIATION PROTOCOL section referencing references/dependency-patch.md", () => {
    const section = getStep5bPromptSection();
    expect(section).toContain("DEPENDENCY-RISK REMEDIATION PROTOCOL");
    expect(section).toContain("references/dependency-patch.md");
  });

  it("the protocol section is gated on DEPENDENCY_RISK_FINDING with recommendation review or hold, since merge has nothing to remediate", () => {
    const section = getStep5bPromptSection();
    expect(section).toContain("DEPENDENCY_RISK_FINDING");
    expect(section).toMatch(/"review"\s+or\s+"hold"/);
    expect(section.toLowerCase()).toContain("nothing to remediate");
  });

  it("the protocol section is additive, ahead of the [A.5] verify/classify instructions, not a replacement", () => {
    const section = getStep5bPromptSection();
    expect(section).toContain("additive");
    expect(section).toMatch(/ahead of.{0,40}\[A\.5\]/is);
    expect(section).toMatch(/not replac/i);
    // Confirm ordering: the protocol block precedes the [A.5] heading in the rendered prompt.
    const protocolIdx = section.indexOf("DEPENDENCY-RISK REMEDIATION PROTOCOL");
    const a5Idx = section.indexOf("[A.5] Verify each finding before implementing it");
    expect(protocolIdx).toBeGreaterThan(-1);
    expect(a5Idx).toBeGreaterThan(protocolIdx);
  });

  it("routes a verified fix through the existing [D]/[E] commit/push and thread-resolution path — no new resolution mechanism", () => {
    const section = getStep5bPromptSection();
    expect(section).toMatch(/same \[D\]\/\[E\] commit\/push/);
    expect(section.toLowerCase()).toContain("no separate mechanism");
  });

  it("a finding that fails to reproduce or has no catalog strategy falls through to [A.5] classification unchanged", () => {
    const section = getStep5bPromptSection();
    expect(section).toContain("classify it REJECT in [A.5]");
    expect(section).toContain("classify REJECT in [A.5]");
    // [A.5] itself must be untouched by this feature — its own heading and body survive verbatim.
    const a5Idx = content.indexOf("[A.5] Verify each finding before implementing it");
    expect(a5Idx).toBeGreaterThan(-1);
    const a5Section = content.slice(a5Idx, a5Idx + 1000);
    expect(a5Section).toContain("Reviewers can be wrong");
    expect(a5Section).toContain("ACCEPT");
    expect(a5Section).toContain("MODIFY");
    expect(a5Section).toContain("REJECT");
  });

  it("does not restate the reproduce-before-fixing protocol's mechanics — points at the reference file instead", () => {
    const section = getStep5bPromptSection();
    expect(section).toContain("verification command");
    expect(section).toContain("bounded strategy catalog");
  });

  it("a REJECTed dependency-risk finding is reported under the SHA-scoped ledger ref Step 3a.5's exclusion matches on", () => {
    const section = getStep5bPromptSection();
    expect(section).toContain("dependency-risk@{headRefOid}");
    expect(section).toMatch(/rather than a free-text slug/i);
    // The ref must be tied to the REJECT exits (protocol steps 2 and 4), not the ACCEPT one.
    expect(section).toMatch(/step 2 or step 4 above lands on REJECT/i);
  });

  it("Step 5c carries the dependency-risk ref verbatim into the findings-ledger write", () => {
    const step5cIdx = content.indexOf("### Step 5c: Handle Subagent Status");
    const step5c5Idx = content.indexOf("### Step 5c.5: Upsert PR Record");
    expect(step5cIdx).toBeGreaterThan(-1);
    expect(step5c5Idx).toBeGreaterThan(step5cIdx);
    const section = content.slice(step5cIdx, step5c5Idx);
    expect(section).toContain("dependency-risk@{headRefOid}");
    expect(section).toMatch(/carry it through verbatim/i);
    expect(section).toMatch(/Step 3a\.5's\s+already-held exclusion matches on that exact string/i);
  });
});

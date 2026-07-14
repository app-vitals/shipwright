import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATCH_MD_PATH = join(import.meta.dir, "patch.md");

let content: string;

beforeAll(() => {
  content = readFileSync(PATCH_MD_PATH, "utf-8");
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

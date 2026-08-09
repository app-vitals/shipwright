// Unit tests for compute-review-verdict.ts — pure logic, no I/O.
//
// Covers the Case 1/Case 2 truth table documented in
// plugins/shipwright/commands/review.md Step 10 (lines ~604-618) plus the
// non-self-review clean-approve path further down that step. See review.md's
// "Worked example" for the recurring production incident this mechanical
// gate exists to prevent.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  computeVerdict,
  validateReviewVerdict,
} from "./compute-review-verdict";

describe("computeVerdict", () => {
  it("selfReview=true, unaddressedFindings=false, currentPassHasBlockingFindings=false -> Case 1: event COMMENT (self-review override), label APPROVE", () => {
    const result = computeVerdict({
      selfReview: true,
      unaddressedFindings: false,
      currentPassHasBlockingFindings: false,
    });
    expect(result).toEqual({ event: "COMMENT", verdictLabel: "APPROVE" });
  });

  it("selfReview=true, unaddressedFindings=false, currentPassHasBlockingFindings=true -> event COMMENT, label COMMENT (fresh blocking finding on an otherwise-clean self-review)", () => {
    const result = computeVerdict({
      selfReview: true,
      unaddressedFindings: false,
      currentPassHasBlockingFindings: true,
    });
    expect(result).toEqual({ event: "COMMENT", verdictLabel: "COMMENT" });
  });

  it("selfReview=true, unaddressedFindings=true, currentPassHasBlockingFindings=false -> Case 2 self-review variant: event COMMENT, label COMMENT", () => {
    const result = computeVerdict({
      selfReview: true,
      unaddressedFindings: true,
      currentPassHasBlockingFindings: false,
    });
    expect(result).toEqual({ event: "COMMENT", verdictLabel: "COMMENT" });
  });

  it("selfReview=true, unaddressedFindings=true, currentPassHasBlockingFindings=true -> event COMMENT, label COMMENT", () => {
    const result = computeVerdict({
      selfReview: true,
      unaddressedFindings: true,
      currentPassHasBlockingFindings: true,
    });
    expect(result).toEqual({ event: "COMMENT", verdictLabel: "COMMENT" });
  });

  it("selfReview=false, unaddressedFindings=false, currentPassHasBlockingFindings=false -> normal clean approve: event APPROVE, label APPROVE", () => {
    const result = computeVerdict({
      selfReview: false,
      unaddressedFindings: false,
      currentPassHasBlockingFindings: false,
    });
    expect(result).toEqual({ event: "APPROVE", verdictLabel: "APPROVE" });
  });

  it("selfReview=false, unaddressedFindings=false, currentPassHasBlockingFindings=true -> Case 3 (the bug this fix closes): event COMMENT, label COMMENT, not a silent APPROVE", () => {
    const result = computeVerdict({
      selfReview: false,
      unaddressedFindings: false,
      currentPassHasBlockingFindings: true,
    });
    expect(result).toEqual({ event: "COMMENT", verdictLabel: "COMMENT" });
  });

  it("selfReview=false, unaddressedFindings=true, currentPassHasBlockingFindings=false -> Case 2: event COMMENT, label COMMENT", () => {
    const result = computeVerdict({
      selfReview: false,
      unaddressedFindings: true,
      currentPassHasBlockingFindings: false,
    });
    expect(result).toEqual({ event: "COMMENT", verdictLabel: "COMMENT" });
  });

  it("selfReview=false, unaddressedFindings=true, currentPassHasBlockingFindings=true -> event COMMENT, label COMMENT", () => {
    const result = computeVerdict({
      selfReview: false,
      unaddressedFindings: true,
      currentPassHasBlockingFindings: true,
    });
    expect(result).toEqual({ event: "COMMENT", verdictLabel: "COMMENT" });
  });
});

describe("validateReviewVerdict", () => {
  it("returns valid:true when the body's Verdict label matches the computed label (Case 1, correctly labeled)", () => {
    const result = validateReviewVerdict({
      selfReview: true,
      unaddressedFindings: false,
      currentPassHasBlockingFindings: false,
      body: "Verdict: APPROVE — Clean conversion, all routes verified, no blocking issues.",
    });
    expect(result).toEqual({ valid: true });
  });

  it("returns valid:true when the body's Verdict label matches the computed label (Case 2, correctly labeled)", () => {
    const result = validateReviewVerdict({
      selfReview: false,
      unaddressedFindings: true,
      currentPassHasBlockingFindings: false,
      body: "Verdict: COMMENT — missing error handling on the retry path.",
    });
    expect(result).toEqual({ valid: true });
  });

  it("returns valid:true when the body's Verdict label matches the computed label (Case 3, correctly labeled: fresh blocking finding, no prior unaddressed findings)", () => {
    const result = validateReviewVerdict({
      selfReview: false,
      unaddressedFindings: false,
      currentPassHasBlockingFindings: true,
      body: "Verdict: COMMENT — new critical finding: unbounded recursion on the retry path.",
    });
    expect(result).toEqual({ valid: true });
  });

  it("catches the exact production mismatch: Case 1 (selfReview=true, unaddressedFindings=false, currentPassHasBlockingFindings=false) mislabeled 'Verdict: COMMENT'", () => {
    const result = validateReviewVerdict({
      selfReview: true,
      unaddressedFindings: false,
      currentPassHasBlockingFindings: false,
      body: "Verdict: COMMENT — No blocking issues found... checks out clean.",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/APPROVE/);
    expect(result.error).toMatch(/COMMENT/);
  });

  it("catches a mismatch in the other direction: Case 2 mislabeled 'Verdict: APPROVE'", () => {
    const result = validateReviewVerdict({
      selfReview: false,
      unaddressedFindings: true,
      currentPassHasBlockingFindings: false,
      body: "Verdict: APPROVE — looks fine to me.",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/APPROVE/);
    expect(result.error).toMatch(/COMMENT/);
  });

  it("catches the exact bug this fix closes: a fresh critical finding with no prior unaddressed findings mislabeled 'Verdict: APPROVE'", () => {
    const result = validateReviewVerdict({
      selfReview: false,
      unaddressedFindings: false,
      currentPassHasBlockingFindings: true,
      body: "Verdict: APPROVE — looks fine to me.",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/APPROVE/);
    expect(result.error).toMatch(/COMMENT/);
  });

  it("returns valid:false with a clear error when the body has no Verdict label at all", () => {
    const result = validateReviewVerdict({
      selfReview: false,
      unaddressedFindings: false,
      currentPassHasBlockingFindings: false,
      body: "Looks good, approved.",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/Verdict/i);
  });

  it("matches case-insensitively and tolerates markdown bold markers around the verdict word", () => {
    const result = validateReviewVerdict({
      selfReview: false,
      unaddressedFindings: false,
      currentPassHasBlockingFindings: false,
      body: "verdict: **approve** — all checks pass.",
    });
    expect(result).toEqual({ valid: true });
  });

  // Regression test for the empirical mismatch found in PR #2515 review round 3:
  // the label regexes here must match agent/src/check-helpers.ts's
  // VERDICT_APPROVE_LABEL (`/verdict\**\s*:\s*\**approve\b/i`) exactly. A body
  // with bold markers wrapping "Verdict:" (colon included, e.g. "**Verdict:**")
  // is NOT matched by the canonical pattern — only bold markers around the
  // verdict word itself are. If this file's regex ever diverges again (e.g. by
  // reintroducing `\s*` between the colon and `\**`), this body would be
  // wrongly treated as a valid "Verdict: APPROVE" label here while
  // agent/src/check-patch.ts's isSelfCleanApprove (canonical pattern) would NOT
  // recognize it as a clean self-approve — reintroducing DRO-1.1's motivating
  // bug via a different code path.
  it("does not match when bold markers wrap the colon itself, matching the canonical check-helpers.ts pattern exactly", () => {
    const result = validateReviewVerdict({
      selfReview: false,
      unaddressedFindings: false,
      currentPassHasBlockingFindings: false,
      body: "**Verdict:** approve — all checks pass.",
    });
    expect(result.valid).toBe(false);
  });

  it("matches a Verdict label embedded with surrounding narrative text", () => {
    const result = validateReviewVerdict({
      selfReview: true,
      unaddressedFindings: true,
      currentPassHasBlockingFindings: false,
      body: "Some preamble.\n\nVerdict: COMMENT — still one unresolved thread on error handling.\n\nMore trailing notes.",
    });
    expect(result).toEqual({ valid: true });
  });
});

describe("VERDICT_APPROVE_LABEL / VERDICT_COMMENT_LABEL regex parity with check-helpers.ts", () => {
  // This file's label regexes are duplicated (not imported) from
  // agent/src/check-helpers.ts's VERDICT_APPROVE_LABEL, per the module
  // comment above their definitions — plugins/shipwright is a separate,
  // repo-agnostic package that can't import from agent/src. A prior review
  // round on PR #2515 found the two had silently diverged (an extra `\**`
  // after the colon here). Extract both regex sources directly and assert
  // they're identical so the two can never drift apart again undetected.
  const CHECK_HELPERS_PATH = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "agent",
    "src",
    "check-helpers.ts",
  );
  const THIS_FILE_PATH = join(import.meta.dir, "compute-review-verdict.ts");

  it("VERDICT_APPROVE_LABEL here matches check-helpers.ts's canonical pattern exactly", () => {
    const checkHelpersSource = readFileSync(CHECK_HELPERS_PATH, "utf-8");
    const tsMatch = checkHelpersSource.match(
      /export const VERDICT_APPROVE_LABEL =\s*\/(.*)\/i;/,
    );
    expect(tsMatch).not.toBeNull();
    const canonicalPattern = tsMatch?.[1] ?? "";
    expect(canonicalPattern.length).toBeGreaterThan(0);

    const thisFileSource = readFileSync(THIS_FILE_PATH, "utf-8");
    const localMatch = thisFileSource.match(
      /const VERDICT_APPROVE_LABEL = \/(.*)\/i;/,
    );
    expect(localMatch).not.toBeNull();
    const localPattern = localMatch?.[1] ?? "";

    expect(localPattern).toBe(canonicalPattern);
  });

  it("VERDICT_COMMENT_LABEL here mirrors the same approve/comment structure as the canonical pattern (approve substring swapped for comment)", () => {
    const checkHelpersSource = readFileSync(CHECK_HELPERS_PATH, "utf-8");
    const tsMatch = checkHelpersSource.match(
      /export const VERDICT_APPROVE_LABEL =\s*\/(.*)\/i;/,
    );
    expect(tsMatch).not.toBeNull();
    const canonicalApprovePattern = tsMatch?.[1] ?? "";
    const expectedCommentPattern = canonicalApprovePattern.replace(
      /approve\\b$/,
      "comment\\b",
    );
    expect(expectedCommentPattern).not.toBe(canonicalApprovePattern);

    const thisFileSource = readFileSync(THIS_FILE_PATH, "utf-8");
    const localMatch = thisFileSource.match(
      /const VERDICT_COMMENT_LABEL = \/(.*)\/i;/,
    );
    expect(localMatch).not.toBeNull();
    const localPattern = localMatch?.[1] ?? "";

    expect(localPattern).toBe(expectedCommentPattern);
  });
});

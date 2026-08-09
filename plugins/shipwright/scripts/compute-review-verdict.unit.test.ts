// Unit tests for compute-review-verdict.ts — pure logic, no I/O.
//
// Covers the Case 1/Case 2 truth table documented in
// plugins/shipwright/commands/review.md Step 10 (lines ~604-618) plus the
// non-self-review clean-approve path further down that step. See review.md's
// "Worked example" for the recurring production incident this mechanical
// gate exists to prevent.

import { describe, expect, it } from "bun:test";
import {
  computeVerdict,
  validateReviewVerdict,
} from "./compute-review-verdict";

describe("computeVerdict", () => {
  it("selfReview=true, unaddressedFindings=false -> Case 1: event COMMENT (self-review override), label APPROVE", () => {
    const result = computeVerdict({
      selfReview: true,
      unaddressedFindings: false,
    });
    expect(result).toEqual({ event: "COMMENT", verdictLabel: "APPROVE" });
  });

  it("selfReview=true, unaddressedFindings=true -> Case 2 self-review variant: event COMMENT, label COMMENT", () => {
    const result = computeVerdict({
      selfReview: true,
      unaddressedFindings: true,
    });
    expect(result).toEqual({ event: "COMMENT", verdictLabel: "COMMENT" });
  });

  it("selfReview=false, unaddressedFindings=false -> normal clean approve: event APPROVE, label APPROVE", () => {
    const result = computeVerdict({
      selfReview: false,
      unaddressedFindings: false,
    });
    expect(result).toEqual({ event: "APPROVE", verdictLabel: "APPROVE" });
  });

  it("selfReview=false, unaddressedFindings=true -> Case 2: event COMMENT, label COMMENT", () => {
    const result = computeVerdict({
      selfReview: false,
      unaddressedFindings: true,
    });
    expect(result).toEqual({ event: "COMMENT", verdictLabel: "COMMENT" });
  });
});

describe("validateReviewVerdict", () => {
  it("returns valid:true when the body's Verdict label matches the computed label (Case 1, correctly labeled)", () => {
    const result = validateReviewVerdict({
      selfReview: true,
      unaddressedFindings: false,
      body: "Verdict: APPROVE — Clean conversion, all routes verified, no blocking issues.",
    });
    expect(result).toEqual({ valid: true });
  });

  it("returns valid:true when the body's Verdict label matches the computed label (Case 2, correctly labeled)", () => {
    const result = validateReviewVerdict({
      selfReview: false,
      unaddressedFindings: true,
      body: "Verdict: COMMENT — missing error handling on the retry path.",
    });
    expect(result).toEqual({ valid: true });
  });

  it("catches the exact production mismatch: Case 1 (selfReview=true, unaddressedFindings=false) mislabeled 'Verdict: COMMENT'", () => {
    const result = validateReviewVerdict({
      selfReview: true,
      unaddressedFindings: false,
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
      body: "Looks good, approved.",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/Verdict/i);
  });

  it("matches case-insensitively and tolerates markdown bold markers around the label", () => {
    const result = validateReviewVerdict({
      selfReview: false,
      unaddressedFindings: false,
      body: "**Verdict:** approve — all checks pass.",
    });
    expect(result).toEqual({ valid: true });
  });

  it("matches a Verdict label embedded with surrounding narrative text", () => {
    const result = validateReviewVerdict({
      selfReview: true,
      unaddressedFindings: true,
      body: "Some preamble.\n\nVerdict: COMMENT — still one unresolved thread on error handling.\n\nMore trailing notes.",
    });
    expect(result).toEqual({ valid: true });
  });
});

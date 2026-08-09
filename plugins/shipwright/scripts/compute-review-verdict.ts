#!/usr/bin/env bun
// Mechanical review-verdict computation gate (DRO-1.1).
//
// Extracts the Case 1/Case 2 verdict truth table documented in
// plugins/shipwright/commands/review.md Step 10 (see the "Worked example"
// there for the recurring production incident this gate exists to prevent)
// into a pure function, plus a validation entrypoint that checks a
// constructed review body's `Verdict: ...` label against the computed
// expected label before the review is posted.
//
// CLI:
//   bun run plugins/shipwright/scripts/compute-review-verdict.ts '{"selfReview":true,"unaddressedFindings":false,"currentPassHasBlockingFindings":false}'
//   bun run plugins/shipwright/scripts/compute-review-verdict.ts '{"selfReview":true,"unaddressedFindings":false,"currentPassHasBlockingFindings":false,"body":"Verdict: APPROVE — ..."}'
// or pipe the same JSON blob via stdin.

// ─── Types ────────────────────────────────────────────────────────────────────

export type Verdict = "APPROVE" | "COMMENT";

export type ComputeVerdictInput = {
  selfReview: boolean;
  unaddressedFindings: boolean;
  currentPassHasBlockingFindings: boolean;
};

export type ComputeVerdictResult = {
  event: Verdict;
  verdictLabel: Verdict;
};

export type ValidateReviewVerdictInput = ComputeVerdictInput & {
  body: string;
};

export type ValidateReviewVerdictResult = {
  valid: boolean;
  error?: string;
};

// ─── computeVerdict ───────────────────────────────────────────────────────────
//
// The 8-row truth table (2^3 boolean combinations; review.md Step 10, "Worked
// example" + "Event selection"):
//
// | selfReview | unaddressedFindings | currentPassHasBlockingFindings | event                            | verdictLabel |
// |------------|----------------------|--------------------------------|-----------------------------------|--------------|
// | true       | false                | false                          | COMMENT (self-review override)   | APPROVE      |  Case 1
// | true       | false                | true                           | COMMENT (self-review override)   | COMMENT      |  Case 1 + fresh blocking finding
// | true       | true                 | false                          | COMMENT (self-review override)   | COMMENT      |  Case 2 (self-review variant)
// | true       | true                 | true                           | COMMENT (self-review override)   | COMMENT      |  Case 2 (self-review variant)
// | false      | false                | false                          | APPROVE                          | APPROVE      |  normal clean approve
// | false      | false                | true                           | COMMENT                          | COMMENT      |  fresh blocking finding, no prior unaddressed
// | false      | true                 | false                          | COMMENT                          | COMMENT      |  Case 2
// | false      | true                 | true                           | COMMENT                          | COMMENT      |  Case 2
//
// `event` is COMMENT whenever selfReview is true (GitHub rejects self-APPROVE
// via the API) OR unaddressedFindings is true (Step 9.5's hard gate) OR
// currentPassHasBlockingFindings is true (Step 8's threshold-filtered
// findings for THIS review pass contain an important/critical severity
// finding) — any one condition alone is sufficient, matching Step 9.5/Step
// 10's "not mutually exclusive" note. `verdictLabel` reflects the *actual*
// quality verdict: COMMENT whenever there is a genuine unaddressed finding
// (prior, per Step 9.5) OR a genuine blocking finding in the current pass
// (per Step 8), regardless of why `event` was forced to COMMENT. This
// restores the old "Event selection" behavior ("any finding at
// important/critical severity remains after threshold filtering: COMMENT —
// no exceptions") that a purely selfReview/unaddressedFindings computation
// cannot express — without currentPassHasBlockingFindings, an any-author PR
// with no prior unresolved GitHub review threads but a fresh critical
// finding in this pass would silently compute as APPROVE.
export function computeVerdict(
  input: ComputeVerdictInput,
): ComputeVerdictResult {
  const hasBlockingSignal =
    input.unaddressedFindings || input.currentPassHasBlockingFindings;
  const event: Verdict =
    input.selfReview || hasBlockingSignal ? "COMMENT" : "APPROVE";
  const verdictLabel: Verdict = hasBlockingSignal ? "COMMENT" : "APPROVE";
  return { event, verdictLabel };
}

// ─── Verdict label matching ───────────────────────────────────────────────────
//
// Mirrors agent/src/check-helpers.ts's VERDICT_APPROVE_LABEL convention
// (`/verdict\**\s*:\s*\**approve\b/i`) — case-insensitive, optional markdown
// bold markers around "verdict", the colon, and/or the verdict word, not
// anchored to end-of-line since review bodies trail reasoning after the
// verdict on the same line. Duplicated here (rather than imported) because
// plugins/shipwright is a separate, repo-agnostic package from agent/src —
// see plugins/shipwright/CLAUDE.md.

const VERDICT_APPROVE_LABEL = /verdict\**\s*:\s*\**approve\b/i;
const VERDICT_COMMENT_LABEL = /verdict\**\s*:\s*\**comment\b/i;

function extractVerdictLabel(body: string): Verdict | null {
  if (VERDICT_APPROVE_LABEL.test(body)) return "APPROVE";
  if (VERDICT_COMMENT_LABEL.test(body)) return "COMMENT";
  return null;
}

// ─── validateReviewVerdict ────────────────────────────────────────────────────
//
// Computes the expected verdictLabel via computeVerdict(), extracts the
// actual `Verdict: ...` label from `body`, and returns a structured
// {valid, error} result — never throws — so review.md's Step 10 procedure
// gets a clean hard-gate signal: a mismatch or a missing label both abort
// the post-review step and force a fix rather than silently proceeding.
export function validateReviewVerdict(
  input: ValidateReviewVerdictInput,
): ValidateReviewVerdictResult {
  const { verdictLabel: expected } = computeVerdict(input);
  const actual = extractVerdictLabel(input.body);

  if (actual === null) {
    return {
      valid: false,
      error: `No "Verdict: APPROVE" or "Verdict: COMMENT" label found in the review body. Expected "Verdict: ${expected}" (selfReview=${input.selfReview}, unaddressedFindings=${input.unaddressedFindings}, currentPassHasBlockingFindings=${input.currentPassHasBlockingFindings}). Add the literal "Verdict: ${expected}" phrase to the body before posting.`,
    };
  }

  if (actual !== expected) {
    return {
      valid: false,
      error: `Verdict label mismatch: body reads "Verdict: ${actual}" but the computed verdict for selfReview=${input.selfReview}, unaddressedFindings=${input.unaddressedFindings}, currentPassHasBlockingFindings=${input.currentPassHasBlockingFindings} is "Verdict: ${expected}". Fix the body to read "Verdict: ${expected}" before posting — do not post with a mismatched label (this is the exact production bug DRO-1.1 guards against).`,
    };
  }

  return { valid: true };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

type CliInput = {
  selfReview: boolean;
  unaddressedFindings: boolean;
  currentPassHasBlockingFindings: boolean;
  body?: string;
};

function parseCliInput(raw: string): CliInput {
  const parsed = JSON.parse(raw) as Partial<CliInput>;
  if (typeof parsed.selfReview !== "boolean") {
    throw new Error('Input JSON must have a boolean "selfReview" field');
  }
  if (typeof parsed.unaddressedFindings !== "boolean") {
    throw new Error(
      'Input JSON must have a boolean "unaddressedFindings" field',
    );
  }
  if (typeof parsed.currentPassHasBlockingFindings !== "boolean") {
    throw new Error(
      'Input JSON must have a boolean "currentPassHasBlockingFindings" field',
    );
  }
  return {
    selfReview: parsed.selfReview,
    unaddressedFindings: parsed.unaddressedFindings,
    currentPassHasBlockingFindings: parsed.currentPassHasBlockingFindings,
    body: parsed.body,
  };
}

if (import.meta.main) {
  const arg = process.argv[2];
  const raw = arg && arg.length > 0 ? arg : await Bun.stdin.text();
  const input = parseCliInput(raw);

  if (typeof input.body === "string") {
    const result = validateReviewVerdict({
      selfReview: input.selfReview,
      unaddressedFindings: input.unaddressedFindings,
      currentPassHasBlockingFindings: input.currentPassHasBlockingFindings,
      body: input.body,
    });
    console.log(JSON.stringify(result));
    if (!result.valid) process.exit(1);
  } else {
    const result = computeVerdict(input);
    console.log(JSON.stringify(result));
  }
}

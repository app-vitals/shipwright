// Unit tests for compute-unresolved-comment-check.ts — pure logic, no I/O.
//
// Mechanizes review.md's Step 5 "Unresolved Comment Check" freehand judgment
// (UCC-1.1). Before this extraction, review.md instructed the LLM to
// freehand-decide whether a human's mid-conversation feedback should defer a
// review pass — a decision that never excluded a comment/review/thread the
// PR author had already replied to and addressed, even though Step 9.5's
// mechanized `hasUnaddressedFindings` gate (compute-unaddressed-findings.ts)
// already handles that exact case via its exported
// isAddressedByAuthorReply/isThreadAddressedByAuthorReply helpers. Because
// Step 5 runs earlier and stops the pipeline on a match, its wrong answer won
// even when the later, correct, mechanized gate would say the finding was
// resolved. This module reuses those two helpers directly rather than
// duplicating their logic (see this file's import).

import { describe, expect, test } from "bun:test";
import {
  type UnresolvedCommentCheckInput,
  computeUnresolvedCommentCheck,
  parseCliInput,
} from "./compute-unresolved-comment-check.ts";

function makeInput(
  overrides: Partial<UnresolvedCommentCheckInput> = {},
): UnresolvedCommentCheckInput {
  return {
    currentUser: "the-agent",
    headRefOid: "current-head-sha",
    lastPushDate: "2026-05-26T09:00:00Z",
    reviews: { nodes: [] },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    ...overrides,
  };
}

describe("computeUnresolvedCommentCheck", () => {
  // ─── Core positive case ──────────────────────────────────────────────────

  test("returns true for a CHANGES_REQUESTED review from a human reviewer at current head with no author reply", () => {
    const input = makeInput({
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please fix the retry logic.",
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: true,
    });
  });

  test("returns true for a substantive unresolved top-level comment posted after the last push", () => {
    const input = makeInput({
      comments: {
        nodes: [
          {
            author: { login: "reviewer1" },
            body: "This still looks broken to me, can you take another look?",
            createdAt: "2026-05-26T10:00:00Z",
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: true,
    });
  });

  test("returns true for an unresolved inline review thread flagged by a human", () => {
    const input = makeInput({
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            comments: {
              nodes: [
                {
                  author: { login: "reviewer1" },
                  body: "Missing null check here.",
                  createdAt: "2026-05-26T10:00:00Z",
                },
              ],
            },
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: true,
    });
  });

  test("returns false when there is no reviewer feedback at all", () => {
    const input = makeInput();
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  // ─── Bot/CI exclusion ───────────────────────────────────────────────────

  test("excludes a CHANGES_REQUESTED review from a [bot]-suffixed author", () => {
    const input = makeInput({
      reviews: {
        nodes: [
          {
            author: { login: "coderabbitai[bot]" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please fix the retry logic.",
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  test("excludes a top-level comment from a known CI account", () => {
    const input = makeInput({
      comments: {
        nodes: [
          {
            author: { login: "github-actions" },
            body: "This build failed, please investigate.",
            createdAt: "2026-05-26T10:00:00Z",
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  test("excludes an unresolved inline thread whose first comment is from a bot", () => {
    const input = makeInput({
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            comments: {
              nodes: [
                {
                  author: { login: "dependabot[bot]" },
                  body: "Bump this dependency.",
                  createdAt: "2026-05-26T10:00:00Z",
                },
              ],
            },
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  test("excludes an unresolved inline thread whose first comment is from CURRENT_USER", () => {
    const input = makeInput({
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            comments: {
              nodes: [
                {
                  author: { login: "the-agent" },
                  body: "Note to self: revisit this.",
                  createdAt: "2026-05-26T10:00:00Z",
                },
              ],
            },
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  // ─── Trivial-acknowledgement exclusion ─────────────────────────────────

  test.each(["LGTM", "+1", "thanks", "approved", "lgtm", "Thanks"])(
    "excludes a trivial acknowledgement comment: %s",
    (body) => {
      const input = makeInput({
        comments: {
          nodes: [
            {
              author: { login: "reviewer1" },
              body,
              createdAt: "2026-05-26T10:00:00Z",
            },
          ],
        },
      });
      expect(computeUnresolvedCommentCheck(input)).toEqual({
        hasSubstantiveUnresolvedFeedback: false,
      });
    },
  );

  test("excludes an emoji-only comment", () => {
    const input = makeInput({
      comments: {
        nodes: [
          {
            author: { login: "reviewer1" },
            body: "\u{1F44D}\u{1F44D}",
            createdAt: "2026-05-26T10:00:00Z",
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  test("does NOT exclude a comment that merely contains 'thanks' amid substantive feedback", () => {
    const input = makeInput({
      comments: {
        nodes: [
          {
            author: { login: "reviewer1" },
            body: "Thanks for the PR, but this still needs a fix for the retry logic.",
            createdAt: "2026-05-26T10:00:00Z",
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: true,
    });
  });

  // ─── Recency-vs-last-push check ─────────────────────────────────────────

  test("excludes a top-level comment posted BEFORE the most recent push (already superseded)", () => {
    const input = makeInput({
      lastPushDate: "2026-05-26T12:00:00Z",
      comments: {
        nodes: [
          {
            author: { login: "reviewer1" },
            body: "This still looks broken to me, can you take another look?",
            createdAt: "2026-05-26T10:00:00Z", // before lastPushDate
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  test("excludes a CHANGES_REQUESTED review posted at an older commit (new commits pushed since)", () => {
    const input = makeInput({
      headRefOid: "new-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "old-head-sha" },
            body: "Please fix the retry logic.",
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  test("does NOT gate an unresolved inline thread on recency-vs-last-push (isResolved is authoritative)", () => {
    const input = makeInput({
      lastPushDate: "2026-05-26T12:00:00Z",
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            comments: {
              nodes: [
                {
                  author: { login: "reviewer1" },
                  body: "Missing null check here.",
                  createdAt: "2026-05-26T10:00:00Z", // before lastPushDate
                },
              ],
            },
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: true,
    });
  });

  // ─── Head-moved override ────────────────────────────────────────────────

  test("skips the check entirely (returns false) when lastReviewedCommit is set and differs from headRefOid, even with an otherwise-blocking review", () => {
    const input = makeInput({
      headRefOid: "new-head-sha",
      lastReviewedCommit: "old-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "new-head-sha" },
            body: "Please fix the retry logic.",
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  test("runs the full check when lastReviewedCommit equals headRefOid (head has not moved)", () => {
    const input = makeInput({
      headRefOid: "same-head-sha",
      lastReviewedCommit: "same-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "same-head-sha" },
            body: "Please fix the retry logic.",
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: true,
    });
  });

  test("runs the full check when lastReviewedCommit is absent (first review)", () => {
    const input = makeInput({
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please fix the retry logic.",
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: true,
    });
  });

  // ─── Author-reply-addressed exclusion (the regression case for this incident) ──
  //
  // Step 9.5's compute-unaddressed-findings.ts already excludes a review, a
  // top-level comment, or an inline thread the PR author has already replied
  // to/rebutted. Before this fix, Step 5's freehand judgment never applied
  // that exclusion, so a review/comment/thread the author had already
  // addressed could still force a defer here, even though the later,
  // mechanized Step 9.5 gate would say it's resolved.

  test("excludes a CHANGES_REQUESTED review the PR author has already replied to (top-level comment case)", () => {
    const input = makeInput({
      prAuthor: "pr-author",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please fix the retry logic.",
          },
        ],
      },
      comments: {
        nodes: [
          {
            author: { login: "pr-author" },
            body: "Fixed in the latest push — the retry logic now backs off correctly.",
            createdAt: "2026-05-26T11:00:00Z", // after the review's submittedAt
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  test("excludes a substantive top-level comment the PR author has already replied to (top-level comment case)", () => {
    const input = makeInput({
      prAuthor: "pr-author",
      comments: {
        nodes: [
          {
            author: { login: "reviewer1" },
            body: "This still looks broken to me, can you take another look?",
            createdAt: "2026-05-26T10:00:00Z",
          },
          {
            author: { login: "pr-author" },
            body: "Good catch — pushed a fix, please re-check.",
            createdAt: "2026-05-26T11:00:00Z", // after the flagging comment
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  test("excludes an unresolved inline thread the PR author has already replied to within it (inline thread case)", () => {
    const input = makeInput({
      prAuthor: "pr-author",
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            comments: {
              nodes: [
                {
                  author: { login: "reviewer1" },
                  body: "Missing null check here.",
                  createdAt: "2026-05-26T10:00:00Z",
                },
                {
                  author: { login: "pr-author" },
                  body: "Added the null check in the latest push.",
                  createdAt: "2026-05-26T11:00:00Z",
                },
              ],
            },
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });

  test("does NOT exclude a CHANGES_REQUESTED review when the author's reply predates it (stale reply)", () => {
    const input = makeInput({
      prAuthor: "pr-author",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please fix the retry logic.",
          },
        ],
      },
      comments: {
        nodes: [
          {
            author: { login: "pr-author" },
            body: "Unrelated earlier comment.",
            createdAt: "2026-05-26T09:00:00Z", // before the review's submittedAt
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: true,
    });
  });

  test("prAuthor defaults to currentUser when absent", () => {
    const input = makeInput({
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please fix the retry logic.",
          },
        ],
      },
      comments: {
        nodes: [
          {
            author: { login: "the-agent" }, // currentUser, no explicit prAuthor
            body: "Fixed.",
            createdAt: "2026-05-26T11:00:00Z",
          },
        ],
      },
    });
    expect(computeUnresolvedCommentCheck(input)).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
  });
});

// ─── parseCliInput ──────────────────────────────────────────────────────────

describe("parseCliInput", () => {
  function validInput(overrides: Record<string, unknown> = {}) {
    return {
      currentUser: "the-agent",
      headRefOid: "current-head-sha",
      lastPushDate: "2026-05-26T09:00:00Z",
      reviews: { nodes: [] },
      comments: { nodes: [] },
      reviewThreads: { nodes: [] },
      ...overrides,
    };
  }

  test("parses valid input", () => {
    const result = parseCliInput(JSON.stringify(validInput()));
    expect(result.currentUser).toBe("the-agent");
    expect(result.headRefOid).toBe("current-head-sha");
    expect(result.lastPushDate).toBe("2026-05-26T09:00:00Z");
    expect(result.lastReviewedCommit).toBeUndefined();
    expect(result.prAuthor).toBeUndefined();
  });

  test("passes lastReviewedCommit and prAuthor through when present", () => {
    const result = parseCliInput(
      JSON.stringify(
        validInput({ lastReviewedCommit: "old-sha", prAuthor: "pr-author" }),
      ),
    );
    expect(result.lastReviewedCommit).toBe("old-sha");
    expect(result.prAuthor).toBe("pr-author");
  });

  test("throws when currentUser is missing", () => {
    const input = validInput();
    (input as Record<string, unknown>).currentUser = undefined;
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON must have a string "currentUser" field',
    );
  });

  test("throws when headRefOid is missing", () => {
    const input = validInput();
    (input as Record<string, unknown>).headRefOid = undefined;
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON must have a string "headRefOid" field',
    );
  });

  test("throws when lastPushDate is missing", () => {
    const input = validInput();
    (input as Record<string, unknown>).lastPushDate = undefined;
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON must have a string "lastPushDate" field',
    );
  });

  test("throws when reviews is missing", () => {
    const input = validInput();
    (input as Record<string, unknown>).reviews = undefined;
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON must have a "reviews" field shaped { nodes: [...] }',
    );
  });

  test("throws when comments is missing", () => {
    const input = validInput();
    (input as Record<string, unknown>).comments = undefined;
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON must have a "comments" field shaped { nodes: [...] }',
    );
  });

  test("throws when reviewThreads is missing", () => {
    const input = validInput();
    (input as Record<string, unknown>).reviewThreads = undefined;
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON must have a "reviewThreads" field shaped { nodes: [...] }',
    );
  });

  test("throws when lastReviewedCommit is present but not a string", () => {
    const input = validInput({ lastReviewedCommit: 123 });
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON "lastReviewedCommit" field, when present, must be a string',
    );
  });

  test("throws when prAuthor is present but not a string", () => {
    const input = validInput({ prAuthor: 123 });
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON "prAuthor" field, when present, must be a string',
    );
  });
});

// ─── CLI entrypoint (argv/stdin JSON parsing) ──────────────────────────────

const SCRIPT_PATH = new URL(
  "./compute-unresolved-comment-check.ts",
  import.meta.url,
).pathname;

describe("CLI entrypoint", () => {
  test("reads input from argv and prints {hasSubstantiveUnresolvedFeedback: true} for a qualifying review", async () => {
    const input = JSON.stringify({
      currentUser: "the-agent",
      headRefOid: "current-head-sha",
      lastPushDate: "2026-05-26T09:00:00Z",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please fix this.",
          },
        ],
      },
      comments: { nodes: [] },
      reviewThreads: { nodes: [] },
    });
    const proc = Bun.spawn(["bun", "run", SCRIPT_PATH, input], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      hasSubstantiveUnresolvedFeedback: true,
    });
    expect(stderr).toBe("");
  });

  test("reads input from stdin when no argv arg is provided, and prints {hasSubstantiveUnresolvedFeedback: false} for a clean PR", async () => {
    const input = JSON.stringify({
      currentUser: "the-agent",
      headRefOid: "current-head-sha",
      lastPushDate: "2026-05-26T09:00:00Z",
      reviews: { nodes: [] },
      comments: { nodes: [] },
      reviewThreads: { nodes: [] },
    });
    const proc = Bun.spawn(["bun", "run", SCRIPT_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(input);
    await proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      hasSubstantiveUnresolvedFeedback: false,
    });
    expect(stderr).toBe("");
  });

  test("exits non-zero with an error when required fields are missing", async () => {
    const proc = Bun.spawn(
      ["bun", "run", SCRIPT_PATH, '{"currentUser":"the-agent"}'],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [_stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });
});

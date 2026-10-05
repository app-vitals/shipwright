// MGI-1.2: own-login comparisons must match a bot's own reviews regardless of
// which of the three observed login forms each side uses.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type PrReviewData,
  type ReviewNode,
  hasUnaddressedFindings,
  isSelfCleanApprove,
  isSupersededBySelfReview,
} from "./compute-unaddressed-findings.ts";
import { computeUnresolvedCommentCheck } from "./compute-unresolved-comment-check.ts";

// GraphQL viewer, `gh pr view` author, GraphQL review/PR author.
const FORMS = ["my-app[bot]", "app/my-app", "my-app"] as const;
const PAIRS = FORMS.flatMap((author) =>
  FORMS.map((user) => ({ author, user })),
);

function review(
  login: string,
  body: string,
  submittedAt: string,
  state = "COMMENTED",
): ReviewNode {
  return {
    author: { login },
    state,
    submittedAt,
    commit: { oid: "head" },
    body,
  };
}

describe("bot reviewing a bot-authored PR", () => {
  describe.each(PAIRS)("review author $author / currentUser $user", ({ author, user }) => {
    test("isSelfCleanApprove matches", () => {
      expect(
        isSelfCleanApprove({ author: { login: author }, body: "APPROVE" }, user),
      ).toBe(true);
    });

    test("isSupersededBySelfReview matches", () => {
      const first = review(author, "Verdict: COMMENT — issue", "2026-05-26T10:00:00Z");
      const later = review(author, "Verdict: APPROVE", "2026-05-27T10:00:00Z");
      expect(isSupersededBySelfReview(first, [first, later], user)).toBe(true);
    });

    test("hasUnaddressedFindings gate treats the bot's own reviews as self", () => {
      const first = review(author, "Verdict: COMMENT — issue", "2026-05-26T10:00:00Z");
      const later = review(author, "Verdict: APPROVE", "2026-05-27T10:00:00Z");
      const data: PrReviewData = {
        headRefOid: "head",
        reviews: { nodes: [first, later] },
        reviewThreads: { nodes: [] },
        comments: { nodes: [] },
        prAuthor: user,
      };
      expect(hasUnaddressedFindings(data, user)).toBe(false);
    });
  });

  test("a different bot is not treated as self", () => {
    expect(
      isSelfCleanApprove(
        { author: { login: "other-app" }, body: "APPROVE" },
        "app/my-app",
      ),
    ).toBe(false);
  });

  test("unresolved-comment check ignores the bot's own comments in every form", () => {
    for (const { author, user } of PAIRS) {
      const result = computeUnresolvedCommentCheck({
        currentUser: user,
        prAuthor: user,
        headRefOid: "head",
        lastReviewedCommit: null,
        lastPushDate: "2026-05-26T09:00:00Z",
        reviews: { nodes: [] },
        reviewThreads: { nodes: [] },
        comments: {
          nodes: [
            {
              author: { login: author },
              body: "Please rework the retry logic substantially.",
              createdAt: "2026-05-26T10:00:00Z",
            },
          ],
        },
      });
      expect(result.hasSubstantiveUnresolvedFeedback).toBe(false);
    }
  });
});

describe("review.md live-review pre-check jq", () => {
  test("canonicalizes both sides of the own-login comparison", () => {
    const md = readFileSync(
      new URL("../commands/review.md", import.meta.url),
      "utf8",
    );
    expect(md).toContain('def canon: sub("^app/"; "") | sub("\\\\[bot\\\\]$"; "") | ascii_downcase;');
    expect(md).toContain("(.author.login | canon) != ($currentUser | canon)");
    expect(md).not.toContain("select(.author.login != $currentUser");
  });
});

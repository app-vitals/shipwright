// Unit tests for filter-bot-comments.ts — pure logic, no I/O.
//
// Covers the bot/CI comment-filtering decision shared between review.md's
// Unresolved Comment Check (via compute-unresolved-comment-check.ts's
// exported isBotOrCiAuthor, RBD-1.1) and patch.md's Step 5a.5 item 4 — "Include
// all non-bot comments as additional context" (PBD-1.1), which was previously
// pure freehand LLM judgment with zero defined criteria. This module reuses
// isBotOrCiAuthor directly rather than re-deriving the bot/CI heuristic.

import { describe, expect, it } from "bun:test";
import { filterBotComments, type CommentLike } from "./filter-bot-comments";

function comment(
  author: { login: string; __typename?: string },
  body = "a comment",
): CommentLike {
  return { author, body };
}

describe("filterBotComments — __typename-first classification", () => {
  it("excludes an author with __typename 'Bot' even when its login carries no [bot] suffix or KNOWN_CI_ACCOUNTS match", () => {
    const comments = [
      comment({ login: "some-custom-app", __typename: "Bot" }),
    ];
    expect(filterBotComments(comments)).toEqual([]);
  });

  it("includes an author with __typename explicitly 'User'", () => {
    const comments = [comment({ login: "a-human", __typename: "User" })];
    expect(filterBotComments(comments)).toEqual(comments);
  });
});

describe("filterBotComments — login-string fallback when __typename is absent", () => {
  it("excludes a [bot]-suffixed login", () => {
    const comments = [comment({ login: "dependabot[bot]" })];
    expect(filterBotComments(comments)).toEqual([]);
  });

  it("excludes a KNOWN_CI_ACCOUNTS login (e.g. github-actions)", () => {
    const comments = [comment({ login: "github-actions" })];
    expect(filterBotComments(comments)).toEqual([]);
  });

  it("excludes a KNOWN_CI_ACCOUNTS login (e.g. renovate)", () => {
    const comments = [comment({ login: "renovate" })];
    expect(filterBotComments(comments)).toEqual([]);
  });

  it("includes an ordinary human login with no __typename", () => {
    const comments = [comment({ login: "dan" })];
    expect(filterBotComments(comments)).toEqual(comments);
  });
});

describe("filterBotComments — mixed arrays and edge cases", () => {
  it("filters a mixed array down to only non-bot/non-CI entries, preserving order and extra fields", () => {
    const human = comment({ login: "dan" }, "looks good");
    const bot = comment({ login: "renovate" }, "bump deps");
    const typenameBot = comment({ login: "weird-app", __typename: "Bot" });
    const comments = [bot, human, typenameBot];
    expect(filterBotComments(comments)).toEqual([human]);
  });

  it("empty array -> empty array", () => {
    expect(filterBotComments([])).toEqual([]);
  });

  it("preserves extra fields on surviving entries (createdAt, path, line, etc.)", () => {
    const withExtra: CommentLike = {
      author: { login: "dan" },
      body: "nice catch",
      createdAt: "2026-05-26T09:00:00Z",
    };
    expect(filterBotComments([withExtra])).toEqual([withExtra]);
  });
});

#!/usr/bin/env bun
// Shared bot/CI comment filter (PBD-1.1).
//
// Extracts patch.md's Step 5a.5 item 4 ("Include all non-bot comments as
// additional context") — previously pure freehand LLM judgment, with zero
// defined criteria (not even a string heuristic) — into a pure, exported
// function plus a CLI entrypoint, mirroring is-ci-green.ts's (CIG-1.1) CLI
// pattern exactly. Reuses compute-unresolved-comment-check.ts's exported
// isBotOrCiAuthor (RBD-1.1) directly rather than re-deriving the bot/CI
// heuristic here — the same classifier review.md's Unresolved Comment Check
// already uses.
//
// Deliberately has no dependency on @shipwright/lib or any other workspace
// package — plugins/shipwright must stay installable standalone into other
// repos (see plugins/shipwright/CLAUDE.md).
//
// CLI:
//   bun run plugins/shipwright/scripts/filter-bot-comments.ts '[{"author":{"login":"dependabot[bot]"},"body":"..."}]'
// or pipe the same JSON array via stdin.

import { isBotOrCiAuthor } from "./compute-unresolved-comment-check.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CommentLike = {
  author: {
    login: string;
    __typename?: string;
  };
  [key: string]: unknown;
};

// ─── filterBotComments ─────────────────────────────────────────────────────────
//
// Keeps only entries whose author is NOT a bot/CI account, per
// isBotOrCiAuthor's `__typename === "Bot"`-first, `[bot]`-suffix/
// KNOWN_CI_ACCOUNTS-fallback classification. Order and extra fields on
// surviving entries are preserved untouched.
export function filterBotComments<T extends CommentLike>(comments: T[]): T[] {
  return comments.filter((c) => !isBotOrCiAuthor(c.author));
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseCliInput(raw: string): CommentLike[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Input JSON must be an array of comment objects");
  }
  return parsed as CommentLike[];
}

if (import.meta.main) {
  const arg = process.argv[2];
  const raw = arg && arg.length > 0 ? arg : await Bun.stdin.text();
  const comments = parseCliInput(raw);
  const result = filterBotComments(comments);
  console.log(JSON.stringify(result));
}

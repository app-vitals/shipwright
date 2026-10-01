# Plan Session: review-bot-detection-fix

Repo: app-vitals/shipwright

## Input

No `PRODUCT-SPEC.md` existed for this session. The spec was a verbal
description from a repo-wide sweep for bot-detection sites, prompted by a
question about whether GitHub's `is_bot` signal was in use everywhere it
should be:

`plugins/shipwright/scripts/compute-unresolved-comment-check.ts`'s
`isBotOrCiAuthor()` classifies review/comment authors by string-matching
(`login.includes("[bot]")` + a hardcoded `KNOWN_CI_ACCOUNTS` set), and the
GraphQL query feeding it (`review.md` Step 5: Gather Context) never fetches a
real bot signal.

**Related, not blocking:** `POF-1.1`/`POF-1.2` (deployed, session
`pr-origin-classification-fix`) fixed the identical fragility in
`deriveOrigin()`/`classifyPrOrigin()` using REST's `is_bot`. This gate is
GraphQL-fed, which has no `is_bot` field — the equivalent signal is
`__typename` on the `Actor` interface (`"Bot"` for GitHub Apps/bots).
Different subsystem (`plugins/shipwright/`, not `task-store`/`agent/src`),
no dependency edge needed.

**Also related, not blocking:** `plugins/shipwright/commands/patch.md`'s
`### Step 3a: Check for Unaddressed Review Findings` (line 259) issues a
separate GraphQL query with the identical shape — three `author { login }`
fields (lines 272, 284, 294), no `__typename` — feeding Step 5a item 4's
"Include all non-bot comments as additional context" (`patch.md:1000`),
which has no backing function at all (pure freehand judgment, unlike
`isBotOrCiAuthor()`). Same fix shape would apply there, but it's a separate
query/call site in a separate command — out of scope for this 2-hour task.
Worth a follow-up task once RBD-1.1 lands and the pattern is proven.

## Design

`plugins/shipwright/commands/review.md`'s Step 5: Gather Context single
GraphQL query (fetches `reviews`, `reviewThreads`, `comments` in one call)
currently requests `author { login }` in all three places (lines 276, 289,
300). None of it carries `__typename`, so `isBotOrCiAuthor()` in
`plugins/shipwright/scripts/compute-unresolved-comment-check.ts` (lines
92-93) has no real signal and falls back entirely to string heuristics.

Fix, scoped to `plugins/shipwright/` only:

1. **review.md Step 5: Gather Context** — add `__typename` alongside `login`
   in all three `author { }` blocks (lines 276, 289, 300).
2. **`compute-unaddressed-findings.ts`** (owns the shared `ReviewNode`/
   `ReviewThread`/`IssueCommentNode` types both scripts import) — widen
   `author: { login: string }` to `author: { login: string; __typename?:
   string }`. Optional field, additive — `compute-unaddressed-findings.ts`'s
   own logic never reads it, so its behavior is unchanged.
3. **`compute-unresolved-comment-check.ts`** — change
   `isBotOrCiAuthor(login: string)` to take the whole `author` object: check
   `author.__typename === "Bot"` first (authoritative), fall back to the
   existing `login.includes("[bot]") || KNOWN_CI_ACCOUNTS.has(login)`
   heuristic when `__typename` is absent (old fixtures, or a caller that
   hasn't upgraded its query). Update the 3 call sites.
4. **review.md prose** — the "Unresolved Comment Check" section already
   says "computed mechanically, not freehand" (UCC-1.1); add a line noting
   the `__typename`-first / string-fallback precedence so the doc matches
   the code.

`isBotOrCiAuthor` is not exported and has no external callers — the
signature change is internal-only and safe.

**Breaking-change scan:** all additive (new optional field, new query
field, internal-only function signature). Safe to deploy standalone: yes.

**Tests:**
- `compute-unresolved-comment-check.unit.test.ts`: add a case where
  `__typename: "Bot"` catches a bot author that the string heuristic would
  miss (no `[bot]` suffix, not in `KNOWN_CI_ACCOUNTS`) — proves the real
  signal now does something the old code couldn't. Existing `[bot]`-suffix/
  `KNOWN_CI_ACCOUNTS` tests are kept unchanged (fallback path, still
  exercised when `__typename` is absent).
- `review.content.test.ts:1056` currently asserts the query literally
  contains `"author { login }"` — updated to match the new
  `"author { login __typename }"` shape.

## HITL Scan

No tasks flagged — no keyword or judgment matches (no infra, no secrets, no
`.claude/**` paths, no web-UI-only actions).

## Task Breakdown

| Field | Value |
|---|---|
| ID | RBD-1.1 |
| Title | Use GraphQL `__typename` for bot detection in Unresolved Comment Check |
| Layer | CLI |
| Branch | `feat/rbd-1-1-typename-bot-detection` |
| Hours | 2 |
| Complexity | 3 → `sonnet` |
| HITL | no |
| Dependencies | none |

Acceptance criteria:
- review.md's Step 5: Gather Context GraphQL query fetches `__typename`
  alongside `login` on all three `author` blocks (reviews, review-thread
  comments, top-level comments)
- `ReviewNode`/`ReviewThread`/`IssueCommentNode` author types gain optional
  `__typename?: string`
- `isBotOrCiAuthor` checks `__typename === "Bot"` first, falls back to the
  existing string heuristic when absent
- Unit test proves a `__typename: "Bot"` author with a non-`[bot]`,
  non-`KNOWN_CI_ACCOUNTS` login is now correctly excluded (case the old
  heuristic would miss); existing fallback-path tests still pass unchanged
- `review.content.test.ts`'s `"author { login }"` assertion updated to the
  new query shape

Dependency map: `[START] → RBD-1.1 (no deps)`

Approved by Dan (Slack), 2026-09-29.

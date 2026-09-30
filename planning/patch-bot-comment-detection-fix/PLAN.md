# Plan Session: patch-bot-comment-detection-fix

Repo: app-vitals/shipwright

## Input

No `PRODUCT-SPEC.md` existed for this session. Follow-up to the
`review-bot-detection-fix` session: PR #3757's review (dodizzle) flagged
that the bot-detection sweep missed an identical gap in `patch.md`. A
second, more thorough sweep confirmed it and ruled out several other
candidate sites.

## Sweep Results

**Confirmed gap:** `patch.md`'s `### Step 3a: Check for Unaddressed Review
Findings` (line 331) runs the same three-`author { login }` GraphQL query
(lines 344/356/366, no `__typename`) as review.md had before RBD-1.1,
feeding `Step 5a.5` item 4's *"Include all non-bot comments as additional
context"* (line 1077) — pure freehand LLM judgment, no backing function at
all (unlike review.md, which at least had a string-heuristic
`isBotOrCiAuthor` to fix).

**Ruled out:** `agent/src`'s four other `fetchPrReviews` GraphQL sites
(`check-review.ts`, `check-patch.ts`, `check-deploy.ts`,
`pr-state-reconciler.ts`) — all compare `author.login` only against
`currentUser`/`prAuthor` for self-identity checks (self-approve,
self-reply), never classify "is this a bot" generically, so no
`__typename` need there. All 28 other command `.md` files checked — no
other real bot-detection logic (only incidental "bot" substring matches
like "robot"/"both"). All `plugins/shipwright/scripts/*.ts` checked — no
other hardcoded bot-login matching. `work-selector.ts`/`loop-orchestrator.ts`
confirmed correctly forwarding POF-1.1/1.2's `authorIsBot` end-to-end
(already deployed).

## Design

Unlike `review.md`, `patch.md`'s Step 3a "unaddressed findings" logic is
entirely freehand prose (clean-APPROVE exclusion, third-party-reply
exclusion, self-review-supersession) — not backed by
`compute-unaddressed-findings.ts` (that TS module is only used by
`agent/src/check-patch.ts`'s separate automated candidate-selection path).
So Step 5a.5 item 4's "non-bot" has zero defined criteria today, not even
a string heuristic.

Scope decision (discussed with Dan): share the bot/CI classifier between
review.md and patch.md rather than either (a) leaving patch.md as
undefined freehand prose, or (b) mechanizing all of Step 3a's other
freehand judgment (bigger, separate scope — untouched here).

Concretely:
1. Export `isBotOrCiAuthor` from `compute-unresolved-comment-check.ts`
   (RBD-1.1 gives it the `{login, __typename?}`-aware signature; this task
   only adds the `export` keyword).
2. New `plugins/shipwright/scripts/filter-bot-comments.ts` — imports
   `isBotOrCiAuthor`, filters a JSON array of `{author: {login,
   __typename?}, ...}` down to non-bot/non-CI entries. Mirrors
   `is-ci-green.ts`'s established pattern exactly: pure exported function +
   `if (import.meta.main)` CLI entrypoint taking JSON via arg or stdin.
3. `patch.md` Step 3a's GraphQL query (lines 344/356/366) gains
   `__typename` alongside `login`.
4. `patch.md` Step 5a.5 item 4 pipes `COMMENTS_JSON` (already fetched in
   Step 3a) through the new script instead of freehand judgment.

Step 3a's other freehand logic (clean-APPROVE, reply-exclusion,
self-review-supersession) is explicitly out of scope — untouched.

**Dependency:** this needs RBD-1.1's object-shaped `isBotOrCiAuthor` to
exist first (RBD-1.1 is `pr_open` as of this writing, PR #3813) — depends
on RBD-1.1 rather than risk two PRs racing the same function signature.

**Breaking-change scan:** none — `isBotOrCiAuthor` export is additive (was
private, no external callers before); new script; patch.md prose/query
edit. Safe to deploy standalone: yes (once RBD-1.1 is merged).

**Tests:**
- New `filter-bot-comments.unit.test.ts` covering the `__typename`-first /
  string-fallback cases, mirroring RBD-1.1's test additions.
- Extend `patch.content.test.ts` asserting the Step 3a query contains
  `__typename` and Step 5a.5 item 4 invokes the new script. No existing
  tests removed.

## HITL Scan

No tasks flagged — no keyword or judgment matches.

## Task Breakdown

| Field | Value |
|---|---|
| ID | PBD-1.1 |
| Title | Share bot/CI comment filter between review.md and patch.md |
| Layer | CLI |
| Branch | `feat/pbd-1-1-patch-bot-comment-filter` |
| Hours | 3 |
| Complexity | 3 → `sonnet` |
| HITL | no |
| Dependencies | RBD-1.1 |

Acceptance criteria:
- `isBotOrCiAuthor` exported from `compute-unresolved-comment-check.ts`,
  signature unchanged (already takes `{login, __typename?}` once RBD-1.1
  lands)
- New `filter-bot-comments.ts`: exported pure function + CLI entrypoint
  (arg or stdin), filters a JSON comment array by `isBotOrCiAuthor`
- `patch.md` Step 3a's GraphQL query fetches `__typename`; Step 5a.5 item 4
  calls the new script instead of freehand judgment
- Test decision: new `filter-bot-comments.unit.test.ts` covering the
  `__typename`-first / string-fallback cases (mirrors RBD-1.1's test
  additions); extend `patch.content.test.ts` asserting the query change and
  the new script invocation; no existing tests removed

Dependency map: `[START] → RBD-1.1 (pr_open) → PBD-1.1`

Approved by Dan (Slack), 2026-09-30.

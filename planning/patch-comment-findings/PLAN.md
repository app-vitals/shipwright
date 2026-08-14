# Plan Session: patch-comment-findings

**Repo:** app-vitals/shipwright
**No PRODUCT-SPEC.md** — bug-fix session, scoped in Slack with Dan McAulay before planning.

## Problem

Another Shipwright-deployed agent (not App Vitals') reported that a reviewer's blocking
feedback on a PR, posted as a plain GitHub PR comment (not a formal "Review changes"
submission), was never picked up by the automated patch loop no matter how many cron
cycles ran.

Root cause, confirmed directly against `app-vitals/shipwright` source:
`hasUnaddressedFindings()` in `plugins/shipwright/scripts/compute-unaddressed-findings.ts`
(the single source of truth `agent/src/check-patch.ts`'s `getPatchCandidates` imports)
only treats formal GitHub review objects (`reviews.nodes` with
`state === "COMMENTED" || "CHANGES_REQUESTED"`) as a source of qualifying findings. It
does fetch `comments.nodes` (plain PR-level comments), but only to check whether the PR
author replied *after* an existing qualifying *review* — a plain comment can never itself
become a finding.

## Design decision: fix at the review layer, not the patch layer

Initial design (discussed and abandoned in favor of this one, see Slack thread) proposed
teaching `patch` to treat any non-self comment as a fix candidate directly, with the LLM
bailing out + posting an acknowledgment reply on non-actionable ones (bot noise etc.) for
dedup.

Dan's question — "should we retrigger review instead, and how do we know if it's a patch
or a review when an agent could do either for a PR?" — surfaced the better design:
**patch's job is executing fixes for already-judged findings; review's job is judging.**
Teaching patch to independently judge raw comments would duplicate review's
already-hardened judgment machinery (self-review exclusion, supersession,
`compute-review-verdict.ts`) with a weaker copy, and never produces a tracked
`reviewState`/`reviewedCommitSha` for a comment-sourced finding.

Instead: broaden review's own re-trigger condition so a plain third-party comment causes
a **re-review**, not a direct patch action. Review's LLM pass then either judges the
comment a real finding (posts a formal GitHub review — which flows into patch's existing,
*unmodified* `hasUnaddressedFindings` logic automatically) or judges it not actionable
(posts nothing, same as a clean pass today). This resolves the "patch vs review"
ambiguity entirely: a plain comment is *always* review's remit first; patch only ever
acts on formal review objects, exactly as it does today.

**Result: zero changes needed to `patch.md`, `check-patch.ts`, or
`compute-unaddressed-findings.ts`.**

### The mechanism

`check-review.ts`'s terminal-skip (`record.reviewedCommitSha === pr.headRefOid &&
record.reviewState !== "pending"`) has exactly one override today:
`hasFreshAuthorReply`, which only checks comments from `pr.author.login`. A third-party
reviewer's comment (the bug case — the reviewer isn't the PR author) never trips it, so
review stays skipped forever. `review.md`'s RVD-1.2 pre-check has an identical
author-only jq filter — the same two-copies-of-one-behavior pattern already found in
`patch.md`/`check-patch.ts`.

Broadening the filter from "fresh reply from the PR author" to "fresh comment from
anyone other than the reviewing agent itself" in both places:
- Covers the third-party-comment bug case.
- Naturally gives "respond once" semantics for free: once review re-runs and posts, its
  new `reviewedAt`/`reviewedCommitSha` watermark advances past every comment that existed
  before that pass, so none of them look "fresh" afterward.
- Naturally covers "N comments before review gets a turn → 1 response covering all N":
  the trigger is a boolean (does *any* qualifying fresh comment exist), and Step 5's
  context-gathering in `review.md` already fetches all 50 most recent comments on every
  pass, not just the one that triggered dispatch.
- No mechanical bot filtering needed — review's LLM pass already judges content; a bot
  status comment just produces a no-op pass, same as any other non-finding today.

## Design (approved)

**Layer:** Shared/CLI logic only — no DB, API, or frontend changes.

1. **`agent/src/check-review.ts`** — extract the inline fresh-reply computation
   (currently in `buildProductionDeps`, ~lines 528-546) into a named, exported pure
   function; broaden its author filter from `=== pr.author.login` to
   `!== currentUser`. Apply at both call sites: the `hasAnyReviewAtHead` exclusion
   (~line 209) and the RCO-1.2 terminal-skip exclusion (~line 246).
2. **`plugins/shipwright/commands/review.md`'s RVD-1.2 Live-Review Pre-Check** — mirror
   the same broadening in its jq program (~line 1047) and surrounding prose
   (~lines 1052-1070), so the LLM-executed dispatch-time re-validation matches the TS
   candidacy logic. Must land in the same PR as (1) — shipping (1) alone would let a PR
   newly qualify for dispatch and then immediately no-op at this now-stale check, wasting
   a dispatch cycle for zero effect.

## Task Breakdown

### RCT-1.1 — Broaden fresh-reply detection to any non-agent commenter, in `check-review.ts`

**Description:** Extract the inline fresh-reply OR computation into a named, exported
pure function; broaden the author filter from `pr.author.login` to `currentUser` (any
commenter except the reviewing agent itself). Apply at both call sites.

**Acceptance criteria:**
- New exported function (e.g. `hasFreshNonAgentComment`) replaces the inline
  computation; both call sites (`hasAnyReviewAtHead` exclusion, RCO-1.2 terminal-skip)
  use it.
- Test decision: extend `check-review.unit.test.ts` — invert the existing "reply from
  someone other than the PR author... does not flip" test (line 1878) to assert it now
  *does* flip; add a new test confirming a reply from `currentUser` itself does *not*
  flip it (prevents the agent's own comments from self-triggering endless re-review);
  replace the test file's local `computeHasFreshAuthorReply` mirror (line 1865) with an
  import of the real exported function, removing that test/production duplication. All
  existing RFR-1.1/RVG-2.1 scenarios still pass.
- Safe to deploy standalone: no — see RCT-1.2.

**Layer:** Shared · **Branch:** `feat/rct-comment-triggers-review` · **Hours:** 3 ·
**Complexity:** 3 (sonnet) · **HITL:** no · **Dependencies:** none

### RCT-1.2 — Mirror the broadened condition in `review.md`'s dispatch-time pre-check

**Description:** Broaden the RVD-1.2 jq program's author filter the same way, and
update the surrounding prose, so the dispatch-time re-validation matches RCT-1.1.

**Acceptance criteria:**
- jq program's author filter broadened to match RCT-1.1's semantics; prose updated to
  describe "anyone but the reviewing agent," not just the PR author.
- Test decision: extend `review.content.test.ts` to assert the RVD-1.2 section reflects
  the broadened condition. No existing terminal-review detection logic removed.
- Safe to deploy standalone: no — must land with RCT-1.1 in the same PR.

**Layer:** Shared · **Branch:** `feat/rct-comment-triggers-review` (bundled with
RCT-1.1) · **Dependencies:** RCT-1.1 · **Hours:** 1.5 · **Complexity:** 3 (sonnet,
bundle-inherited) · **HITL:** no

### Dependency Map

```
[START]
  └─ RCT-1.1: Broaden fresh-reply detection (check-review.ts) (no deps)
        └─ RCT-1.2: Mirror in review.md's RVD-1.2 (needs 1.1, same branch)
```

```
Task     | Depends on | Blocks | HITL
RCT-1.1  | —          | 1.2    |
RCT-1.2  | 1.1        | —      |
```

**HITL scan:** no tasks require human steps.

## Out of scope

- `check-review.ts`'s change is scoped to review only — `patch.md`/`check-patch.ts`/
  `compute-unaddressed-findings.ts` are unmodified. Dan confirmed this scope explicitly.
- Whether to mechanically filter bot comments was raised and deliberately rejected —
  review's own LLM judgment handles non-actionable comments (bot noise etc.) without any
  special-cased filtering.

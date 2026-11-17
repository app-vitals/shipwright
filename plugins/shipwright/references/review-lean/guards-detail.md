# review-lean: guard details

Reading material for `commands/review-lean.md`'s guards, for when a guard's result looks wrong. Every guard's trigger,
deciding command and stop rule lives in the spine; nothing here is a required step.

## Live-Review Pre-Check (RVD-1.2)

The pre-check exists because the task-store claim only dedups agents on the same task-store instance. It is blind to a
review posted by an agent on a different instance, or by a human running the command directly, so it queries GitHub for a
terminal review at the current head before any record fetch, claim or checkout — even with a pre-claim marker, which only
proves the orchestrator's own instance had the PR queued.

- The `select(...)` predicate (`(.body | test(...)) or .state == "APPROVED"`) mirrors `agent/src/check-helpers.ts`'s
  exported `isTerminalReviewLabel()`: a literal `Verdict:` label match (`VERDICT_TERMINAL_LABEL`) OR a live
  `state === "APPROVED"`. The `Verdict:` half covers this command's own postings; the `APPROVED` half catches a plain
  human or bot UI approval with no `Verdict:` text. There is no author filter on the terminal review itself.
- The fresh-reply exception mirrors `hasFreshNonAgentComment` in `agent/src/check-review.ts`: any comment by someone other
  than `$CURRENT_USER` after the latest terminal review's `submittedAt` makes `terminal` false.
- `gh api`'s own `--jq`/`-q` flag does not support `--arg` (`unknown flag: --arg`); pipe the raw response to the real `jq`.
- The pre-check's query needs `comments(last: 50)` to match `check-review.ts`'s `fetchPrReviews`; it is deliberately not
  merged with Step 5.5's query (different timing and fields; the head could move between them).
- The terminal write-back sets `reviewedCommitSha` only, not `commitSha` (the claim-lock field; this path takes no claim).
- **CHU-2.4 reconciler caveat (safe here).** `agent/src/pr-state-reconciler.ts`'s `reconcilePostedReviewStateRecord()`
  reverts a `posted` record to `pending` only when `hasAnyReviewAtHead()` finds no review object at head. `terminal == true`
  means one exists, so the reconciler takes its no-op branch.

## Unresolved Comment Check (UCC-1.1)

- `compute-unresolved-comment-check.ts` reuses `compute-unaddressed-findings.ts`'s `isAddressedByAuthorReply` /
  `isThreadAddressedByAuthorReply` (CPF-2.3/URT-1.1), so feedback the PR author already answered is not substantive.
- Bot/CI authors never count (RBD-1.1): `isBotOrCiAuthor` checks `author.__typename === "Bot"` first (the query requests
  `__typename` on every `author`), falling back to the login heuristic (`[bot]` suffix or `KNOWN_CI_ACCOUNTS`) only when
  `__typename` is absent.
- **Reconciler caveat.** The write-back only reliably holds when the feedback came from a formal
  `CHANGES_REQUESTED`/`COMMENTED` review object at head. `reconcilePostedReviewStateRecord()` heals a `posted` record back to
  `pending` once `hasAnyReviewAtHead()` finds no formal review at head (it does not inspect issue-level comments), so a
  plain-comment trigger becomes re-selectable after the next reconcile pass (every 30-60 min). Not a regression versus the
  old release-based skip; the churn just resumes later.

## Settle-and-stop

All three stop paths (unresolved feedback, terminal review at head, already reviewed at this commit) write one atomic
PATCH. The task store clears `claimedBy`/`claimedAt`/`heartbeatAt`/`phase` server-side when `reviewState` becomes `posted`,
so an inherited pre-claim is released by the same write; a separate `release` call would leave a window where the PR sits
unclaimed but still `pending` (fixed in commit `dca470d37`). Advancing `reviewedAt` is what keeps
`hasFreshNonAgentComment`'s watermark from treating the triggering comment as perpetually fresh (RCT-1.1/RVG-1.1). The
tagged `[skip-reason:review:deferred:{reason}:{pr}]` keeps the loop orchestrator's generic `[silent]` handling from
counting a legitimate defer toward `SKIP_BLOCK_THRESHOLD` (see `agent/src/loop-orchestrator.ts`).

## Stale-head re-check (RHR-1.1)

The review-writing phase can take long enough for the author to push. Compare a freshly fetched `currentHeadRefOid` with
the canonical `headRefOid` captured at claim time; never overwrite `headRefOid`. On a mismatch the review was built against
a commit that is no longer HEAD (often the very fix it was about to flag), so it is not posted, the claim is released back
to `pending`, and `reviewState` never transitions to posted for this pass (evidence: commit `668638a2d`).

## Post failure

A failed POST must not run Step 11b: marking the record posted would let `check-review.ts`'s `commitSha`/`reviewState`
dedup hide the PR from candidacy although no review exists on GitHub. Release instead. Never re-run the POST: GitHub does
not allow deleting or dismissing a COMMENTED review via the API, so a retry leaves a permanent duplicate.

## Staged path

`auto_post_reviews: false` stages instead of posting: the PATCH persists the verdict (`approved` for APPROVE, `posted` for
COMMENT) so `/shipwright:review-staged`'s APPROVE-first sort works, and clears the claim fields to `null` (mirroring
`pull-request-service.ts`'s `patch()`). Step 11b is skipped.

# review-lean: findings ledger and unaddressed findings

Mechanics for the ledger writes in `commands/review-lean.md` (Step 5 PFL-2.1, Step 7 attestations, Step 11 PFL-5.2) and
a human-readable summary of what Step 9.5's `compute-unaddressed-findings.ts` excludes. The script and its unit tests are
the behavioral spec; this summary never overrides the script's output.

## The one POST form

Every ledger write uses the spine's single form, built with `jq -n --arg` so subagent-authored free text cannot break the
JSON:

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}/findings" \
  -d "$(jq -n --arg ref "$REF" --arg disposition "$DISPOSITION" --arg evidence "$EVIDENCE" \
        '{ref: $ref, disposition: $disposition, source: "review", evidence: $evidence}')" \
  >/dev/null 2>&1 || echo "⚠ ledger POST failed for $REF — continuing (non-fatal)"
```

A failed POST (non-2xx, timeout, any curl error) is non-fatal: log the warning and continue. Issuing it is not optional,
and every ledger POST of the pass **must complete before Step 11b's `/prs/:id/complete` call**. A ledger entry landing
after `/complete` stamps `reviewedAt` makes `agent/src/check-review.ts`'s `hasFreshLedgerFinding` (PFL-3.1) treat it as new
information and re-claim the PR on the next tick (evidence: commit `345521154`).

## Call sites

| Site | When | `REF` | `DISPOSITION` | `EVIDENCE` |
|---|---|---|---|---|
| Step 5, PFL-2.1 | A `CURRENT_USER` review before head excluded by `isSelfCleanApprove(review, CURRENT_USER)` | `reviewRef(review)` | `resolved` | `Self-review is a clean APPROVE with no blocking findings.` |
| Step 5, PFL-2.1 | Excluded by `isSupersededBySelfReview(review, allReviews, CURRENT_USER)` | `reviewRef(review)` | `superseded` | `Superseded by a later clean self-review submitted at {laterReview.submittedAt}.` |
| Step 7, PFL-2.1 | Each parsed `priorFindingsStatus[]` entry with `resolved: true` | `entry.ref` | `resolved` | `entry.evidence`, verbatim |
| Step 11, PFL-5.2 | Direct post succeeded, `SELF_REVIEW=true`, `UNADDRESSED_FINDINGS=false`, `CURRENT_PASS_HAS_BLOCKING_FINDINGS=false`, `SUBMITTED_AT` set | `${headRefOid}@${SUBMITTED_AT}` | `resolved` | `Self-review is a clean APPROVE with no blocking findings (recorded at post time, PFL-5.2).` |

The PFL-2.1 writes persist judgments already made; they do not change `priorQualifyingReviews` or any decision. Entries
with `resolved: false` are not posted. PFL-5.2 exists because a PR whose only review is a clean self-approve never gets a
later pass, so PFL-2.1 would never ledger it and `isResolvedByLedger` would stay false forever. It fires only on the
direct-post path (`/shipwright:review-staged` does not populate `SUBMITTED_AT`).

## Prior qualifying reviews (PVD-1.2)

A review is a prior qualifying review when ALL hold: `state` is `COMMENTED` or `CHANGES_REQUESTED`; `body` is non-empty;
`author.login === CURRENT_USER`; `commit.oid !== headRefOid` (before head — the opposite of Step 9.5's at-head filter);
and NOT excluded by `isSelfCleanApprove` or `isSupersededBySelfReview` (DRO-1.2), reused exactly as exported from
`compute-unaddressed-findings.ts`. It intentionally does not apply Step 9.5's unresolved-thread branching or
`isAddressedByAuthorReply`: the subagent makes its own resolved/not-resolved call per entry.

`ref` comes from the exported `reviewRef(review)`: the review's FULL `commit.oid` plus `submittedAt`, joined by `@`
(`${review.commit.oid}@${review.submittedAt}`) — never a short SHA, because `isResolvedByLedger` (PFL-3.2) does an exact
string match on this format.

## What Step 9.5 counts as unaddressed (summary)

A PR has unaddressed findings when either holds:

- An unresolved review thread (`isResolved == false`), unless a later PR-author reply within it addressed it (URT-1.1,
  `isThreadAddressedByAuthorReply`).
- A `COMMENTED`/`CHANGES_REQUESTED` review with a non-empty `body` at head, unless it is:
  - a clean self-APPROVE (`isCleanApproveBody`, CPF-2.1: body starts with `APPROVE` or carries a `Verdict: APPROVE` label);
  - addressed by a later PR-author PR-level comment with every inline thread resolved (CPF-2.3, author scoped to the real
    `prAuthor`, RAS-1.1);
  - an earlier self-review superseded by a later, genuinely clean self-review (DRO-1.2);
  - attested `resolved`/`superseded` in the findings ledger by a `source: "review"` entry whose `ref` matches
    (`isResolvedByLedger`, PFL-3.2; not gated on self-authorship); or
  - rejected by a patch-source ledger entry (`isRejectedByPatchLedger`, PHS-1.2: `reviewRef` for review bodies,
    `threadRef` for inline threads).

Each ledger entry is judged independently: a fresh, unrelated blocking finding elsewhere does not prevent an
already-verified resolution from being excluded (that fresh finding still forces `COMMENT` via
`currentPassHasBlockingFindings`). The gate is computed live from the Step 5.5 GraphQL data at post time; it is not
persisted as a dedup field.

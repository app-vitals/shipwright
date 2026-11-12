# Plan: review-allowlist-multi-agent

## Problem
check-review.ts gates reviewAuthorAllowlist on `record == null` (AAL-3.2). The PullRequest record is account-wide, so once any agent engages a PR, every other agent skips its allowlist for it.

## Design
- Fetch `reviewData` (fetchPrReviews) once, before the allowlist gate; reuse below.
- `reviewedByMe` = any non-PENDING review authored by currentUser (canonicalLogin compare).
- Gate: `!reviewedByMe && !isAuthorAllowed(author) && !isRequestedReviewer`.
- Fetch failure fails closed (allowlist applies).
- Drop record/queryPrRecordFailed from the gate; log reviewedByMe in the not-allowlisted skip.
- check-patch: no change (patchAuthorAllowlist is an additive source, not a record-gated filter).
- Assumes agents use separate GitHub logins (confirmed by Dan).

## Tasks
| Task | Depends | HITL |
|---|---|---|
| RAM-1.1 fix: gate review allowlist on agent's own prior review | — | no |

Safe to deploy standalone: yes.

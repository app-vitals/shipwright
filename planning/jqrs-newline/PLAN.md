# Plan: jqrs-newline

Repo: app-vitals/shipwright

## Problem
`jq -Rs . <<< "$X"` appends a trailing newline via the here-string, so jq emits `"abc\n"`.
- `patch.md:455`, `review.md:1001` (`HEAD_REF_OID`): the value reaches `compute-unaddressed-findings.ts`, which compares `r.commit.oid === headRefOid` (line 623). It never matches, so `qualifyingReviews` is empty and `unaddressedFindings` is always `false`.
- `review.md:1256` (`BODY`): `compute-review-verdict.ts` only runs regexes over the body, so the newline is harmless, but the call site is fixed for consistency.
- No other `jq -Rs` here-string uses exist in plugins/, scripts/ or agent/.

## Design
Prompt-markdown only; no script changes.
- patch.md / review.md headRefOid: pass `--arg headRefOid "$HEAD_REF_OID"` to the enclosing `jq -n`, dropping the nested `$(jq -Rs ...)`.
- review.md:1256: build the payload with `jq -n --arg body "$BODY" --argjson selfReview ... '{...}'` instead of interpolating JSON.
- Tests: content assertions in patch/review content tests (no `jq -Rs . <<<`, `--arg headRefOid` present) plus a behavioral test that a review at the matching oid is detected.

Safe to deploy standalone: yes.

## Tasks
| Task | Depends on | HITL |
|------|-----------|------|
| JNL-1.1 fix: pass headRefOid and review body to jq with --arg instead of jq -Rs here-strings | — | |

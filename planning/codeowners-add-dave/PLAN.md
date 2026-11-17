# Plan: codeowners-add-dave

## Problem

`app-vitals/shipwright` `main` enforces `require_code_owner_review: true` (1 approving review).
`.github/CODEOWNERS` is `* @dodizzle @dmcaulay`, so approvals from `daveodell-vgs` (write access,
org member) display as APPROVED on the PR but do not satisfy the rule. PRs authored by dmcaulay
that Dave approves (e.g. #5240, #5224) stay `REVIEW_REQUIRED` and need a manual merge.

## Design

Add `@daveodell-vgs` to the catch-all rule. No other layer is touched.

```
* @dodizzle @dmcaulay @daveodell-vgs
```

Safe to deploy standalone: yes (additive; widens the set of valid approvers only).

Side effect to be aware of: CODEOWNERS also auto-requests review from every listed owner, so Dave
will start getting review requests on all PRs.

## Tasks

| Task | Title | Depends on | HITL |
|------|-------|------------|------|
| CDO-1.1 | chore: add daveodell-vgs to CODEOWNERS | — | |

## Decision Log

- Scope: defaulted to editing CODEOWNERS only (not relaxing `require_code_owner_review`) — Dan chose the CODEOWNERS fix; the branch-rule change remains an alternative.
- Agent repo: not changed — it does not enforce code-owner review, so Dave's approvals already count.

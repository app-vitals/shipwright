# Plan: patch-prose-lock-release

Repo: `app-vitals/shipwright`

## Problem

Two defects keep a clean, self-approved PR cycling through patch dispatches and, since PHS-3.1, get it blocked as "patch dispatch made no progress":

1. **Prose drift.** `plugins/shipwright/commands/patch.md` Step 3a classifies List A from freehand prose that still lists the clean-APPROVE and superseded-self-review exclusions. `compute-unaddressed-findings.ts` dropped both (PFL-4.1, PFL-5.4); only the task-store ledger, `isSupersededBySameHeadApproval`, and the author-reply exclusions settle a review. For a self-review posted before PFL-5.2 (#3052) there is no ledger entry, so the code treats the PR as a List A candidate while the prose says "no findings". The run exits `[silent]`, writes no settle entry, and is re-dispatched every time the claim lapses.
2. **Unreleased pre-claim.** The loop orchestrator pre-claims the PR (CBD-1.3) before dispatch. Step 3d's empty-lists exit happens before any of patch's claim sites, so nothing releases it; it only clears at TTL. The orchestrator has no release call, and `blockPr` (PHS-3.1 escalation) does not release the claim either.

## Design

- Replace the freehand List A prose with the mechanical script, as `review.md` already does (`compute-unaddressed-findings.ts` returns `{"unaddressedFindings": bool}`), fed with the PR's ledger findings. Update the places that quote the old exclusions.
- Fixing the classification has a useful side effect: a clean self-approve with no ledger entry becomes a List A item and is settled by Step 5c.5's settle-with-rejected path, which writes a `rejected` ledger entry. Legacy PRs heal on their next dispatch. A separate ledger backfill is out of scope.
- Release the pre-claim in two layers: a precise release at Step 3d (prose) and a mechanical safety net in the orchestrator after a silent patch dispatch (same "holds for any exit" invariant as PHS-3.1).
- Reconcile the Step 3d design note: candidacy needs no write-back (it is re-derived live each tick), but the pre-claim is persisted state the run must give back.

## Tasks

| Task | Title | Depends on | Branch | Model |
|---|---|---|---|---|
| PRL-1.1 | Make patch.md Step 3a classify List A via compute-unaddressed-findings.ts | — | feat/prl-patch-prose-sync | sonnet |
| PRL-1.2 | Release the orchestrator pre-claim on patch's empty-lists exit | — | feat/prl-patch-prose-sync | sonnet |
| PRL-1.3 | Orchestrator releases a still-held patch pre-claim after a silent dispatch | — | feat/prl-orchestrator-release | sonnet |

PRL-1.1 and PRL-1.2 are bundled (shared `patch.md` and `patch.content.test.ts`). Same-branch tasks are serialized automatically.

## Dependency Map

```
[START]
  ├─ PRL-1.1 (no deps)  ┐ bundle: feat/prl-patch-prose-sync
  ├─ PRL-1.2 (no deps)  ┘
  └─ PRL-1.3 (no deps)
```

## Breaking Change Safety

No renames, removals, or constraint additions. `POST /prs/:id/release` already exists. The methodology-contract doc change is wording only. Every task: Safe to deploy standalone: yes.

## HITL scan

No task requires human steps.

## Out of scope

Backfill or self-heal of pre-PFL-5.2 ledger entries (partly covered by the settle-with-rejected side effect of PRL-1.1).

## Decision Log

- Mechanical script over corrected prose: defaulted to script invocation — prose duplication of `hasUnaddressedFindings` is what drifted.
- Two-layer release (Step 3d + orchestrator): defaulted to both — prose release depends on the model following instructions on every silent exit; the orchestrator layer enforces it mechanically.

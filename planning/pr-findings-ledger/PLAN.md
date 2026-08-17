# Plan Session: pr-findings-ledger

**Repo:** app-vitals/shipwright
**No PRODUCT-SPEC.md** — scoped in Slack with Dan McAulay before planning.

## Problem

Started from a review/patch candidacy-check complexity audit (`check-review.ts` has grown
~14 exclusion checks, `check-patch.ts`/`compute-unaddressed-findings.ts` four heuristic
exclusions), but the concrete pain point that emerged: patch's *only* signal that a
third-party review's finding was "addressed" is `isAddressedByAuthorReply` (CPF-2.3) — a
subsequent PR-level comment from the PR author (in patch's case, the agent itself) posted
after the review. This is a hard GitHub API constraint (only a review's own author can edit
its body), not an arbitrary choice — but it means "flip the internal disposition bit" and
"communicate to the human" are forced into the same action. The team has had to post
GitHub comments purely to create a timestamp signal for automation to detect, even for
low-stakes "no action needed" dispositions, and the task-store `PullRequest` record has no
field to record "we evaluated finding X and here's what we decided" independent of whether
a comment was posted.

A related, separate gap surfaced in the same discussion: `patch.md`'s RPF-1.1 rebuttal flow
needs to re-trigger `review` when the agent (as PR author) posts a rebuttal with no new
commit — but the generic "fresh comment" detector (`hasFreshNonAgentComment`, RCT-1.1)
deliberately excludes the current user's own comments (to prevent the agent from
self-triggering on its own replies). So RPF-1.1 has its own bespoke workaround: manually
`PATCH`ing `reviewState` back to `"pending"` — a fourth, one-off code path doing the same
job ("tell review something changed") a different way.

## Root cause

Disposition of a review finding (resolved / superseded / rejected) is currently *inferred*
after the fact from raw GitHub signals — review body regex matching (`isSelfCleanApprove`),
timestamp adjacency (`isAddressedByAuthorReply`), text-pattern chasing a later review
(`isSupersededBySelfReview`) — rather than *recorded* explicitly at the moment a
review or patch pass actually makes the decision. There's a close existing precedent for
explicit recording — `priorFindingsStatus[]` (PVD-1.3), a structured
`{ref, resolved, evidence}` attestation from the code-reviewer subagent — but it's scoped
only to self-authored review supersession during a single review.md pass, and it's
ephemeral (recomputed fresh each pass, never persisted).

## Design

### Ledger: `PrFinding`

A new table, not a JSON blob on `PullRequest` — findings entries are written incrementally
and potentially concurrently (review and patch can both write around the same time), and a
JSON-array read-modify-write PATCH is not race-safe for that; a plain `INSERT` is. Fields:
`id, prRecordId (FK → PullRequest), ref, disposition (resolved | superseded | rejected),
source (review | patch), evidence, at, createdAt`. Indexed on `(prRecordId, ref)` and
`(prRecordId, source)`.

### Authority rule (source matters, not just for observability)

`source: "review"` — written by the code-reviewer subagent during a review pass, which
independently re-reads the diff. Only this source may write `disposition: "resolved"` or
`"superseded"` — a verified judgment, not self-report.

`source: "patch"` — written when patch posts a rebuttal. May only write
`disposition: "rejected"` — a proposal, not a resolution. It doesn't close the loop itself;
it flags "I disagree, here's why" and its write is what re-triggers review.

This mirrors the existing PVD-1.3 guardrail ("the agent cannot unilaterally resolve
someone else's review via its own subagent's word... that path stays governed by the
author-reply exclusion") and is enforced **server-side** (400 on a disallowed
source+disposition combination), matching this codebase's existing pattern of allowlist
enforcement at the API layer (`PATCH_ALLOWED_FIELDS` in `routes/prs.ts`) rather than
trusting command prose alone.

### Consumers

- **`check-review.ts` candidacy**: a PR becomes eligible for review when `headRefOid`
  changed (existing) OR any `PrFinding.at` for the PR is newer than `record.reviewedAt`
  (new) — replaces the need for RPF-1.1's manual `reviewState: "pending"` reset once
  PFL-3.1 lands.
- **`compute-unaddressed-findings.ts`**: a qualifying finding is also excluded when a
  `source: "review"` ledger entry marks it resolved/superseded — added *alongside* the
  existing four heuristics (`isSelfCleanApprove`, `isAddressedByAuthorReply`,
  `isSupersededBySelfReview`, `isResolvedByPriorFindingsStatus`), not replacing them yet.

### Scoping decisions (things this session explicitly does NOT do)

- **Does not replace `check-review.ts`'s existing `reviewedCommitSha`/`reviewedAt` scalar
  watermark** with a generic "last GitHub `updatedAt`" signal — that was an earlier
  hypothesis in this same conversation, rejected because the task-store `PullRequest`
  record is a deliberately-chosen source of truth (`plugins/shipwright/CLAUDE.md` principle
  #2), not something to unwind in favor of live-polling a superset GitHub field.
- **Does not remove the four existing `compute-unaddressed-findings.ts` heuristics or
  patch.md's manual `reviewState` reset in this batch.** Removing inference-based coverage
  before the explicit-ledger coverage has run in production would be removing safety net on
  a guess. See PFL-4.1 below — filed now (so it isn't lost) but `hitl: true` and gated on a
  human judgment call about bake time, not a fixed schedule.
- **Does not extend the ledger to record general PR state-transition history** (reviewState/
  phase/claimedBy/heartbeatAt changes). Raised in the same discussion — a durable
  state-transition audit log is a real, separately-motivated idea (several past incidents —
  CHU-2.3, CHU-2.4, the `/prs/:id/release`-always-resets-`reviewState` root cause — are
  exactly "a scalar field got clobbered and nobody could reconstruct why or when") but has a
  different access pattern (current-value reads vs. per-ref lookups) and a much higher write
  frequency (heartbeat pings) than the findings ledger. Mixing them would make the common
  case (read current `reviewedAt`) strictly more expensive for consumers that never needed
  history. Worth its own future plan session, scoped against its own motivating incidents —
  not filed as a task here.

## Breaking Change Scan

All six executable tasks are additive: new table, new endpoint, new optional response
field, new exclusion/trigger checks layered alongside existing ones. No existing consumer
loses a field or a code path in this batch. PFL-2.2 was originally scoped to *replace*
patch.md's manual `reviewState: "pending"` reset in the same task as adding the ledger
write — corrected during planning: removing the old trigger before `check-review.ts`
(PFL-3.1) knows to read the ledger would create a real window where a patch rebuttal
triggers no re-review by any mechanism. Fixed to add-and-keep; removal of the old reset
moves to PFL-4.1, sequenced after PFL-3.1 is confirmed live. Safe to deploy standalone: yes,
for all of PFL-1.1 through PFL-3.2. PFL-4.1 is a removal-only task with no external
consumers, gated on human sign-off rather than a technical dependency.

## Tasks

| ID | Title | Layer | Depends on | Hours | Complexity | Model | HITL |
|---|---|---|---|---|---|---|---|
| PFL-1.1 | Add `PrFinding` schema + migration | Database | — | 2 | 3 | sonnet | |
| PFL-1.2 | Add `POST /prs/:id/findings` + `findings[]` on GET, server-side source/disposition authority enforcement | API | 1.1 | 3 | 3 | sonnet | |
| PFL-2.1 | `review.md` persists resolved/superseded ledger entries alongside existing `priorFindingsStatus` computation | Shared | 1.2 | 3 | 3 | sonnet | |
| PFL-2.2 | `patch.md` writes rejected ledger entry on rebuttal, **keeps** existing manual `reviewState:"pending"` reset for now | Shared | 1.2 | 3 | 3 | sonnet | |
| PFL-3.1 | `check-review.ts`: ledger-timestamp candidacy trigger, additive to existing `headRefOid` check | Shared | 1.2, 2.2 | 4 | 4 | sonnet | |
| PFL-3.2 | `compute-unaddressed-findings.ts`: ledger-based resolved/superseded exclusion, additive to existing four | Shared | 1.2, 2.1 | 4 | 4 | sonnet | |
| PFL-4.1 | Remove superseded heuristics (`isSelfCleanApprove`, `isSupersededBySelfReview`, ephemeral `isResolvedByPriorFindingsStatus` path) + patch.md's manual `reviewState` reset, once ledger coverage is confirmed in production | Shared | 3.1, 3.2 | 3 | 3 | sonnet | ⚠ HITL |

### Dependency Map

```
[START]
  └─ PFL-1.1
        └─ PFL-1.2
              ├─ PFL-2.2
              │     └─ PFL-3.1
              │           └─ PFL-4.1 (⚠ HITL — human unblocks after bake period)
              └─ PFL-2.1
                    └─ PFL-3.2
                          └─ PFL-4.1 (⚠ HITL — human unblocks after bake period)
```

### Test Decisions (per task)

- **PFL-1.1**: integration test (real Postgres via Docker) round-tripping a `PrFinding` row.
  Wholly new surface — no existing test retired.
- **PFL-1.2**: smoke test for the new route's HTTP contract, including the 400
  source/disposition-authority-violation case; integration test for the service-layer
  append method. No existing test retired.
- **PFL-2.1**: content test asserting `review.md` instructs the ledger POST at the right
  step, correct `source`/`disposition` values. No existing test retired — new instructed
  behavior alongside existing.
- **PFL-2.2**: content test asserting the new ledger POST is instructed *alongside* (not
  instead of) the existing manual reset — explicit assertion the old reset step is still
  present, to guard against a future edit dropping it early. No existing test retired.
- **PFL-3.1**: unit tests in `check-review.unit.test.ts` — ledger entry newer than
  `reviewedAt` → eligible; no new entry → existing terminal-skip behavior unchanged; confirm
  existing RCT-1.1/RVG-1.1 fresh-comment tests still pass unmodified. No existing test
  retired — additive trigger.
- **PFL-3.2**: unit tests for the new `isResolvedByLedger` exclusion in isolation and
  combined with the existing four. No existing test retired — additive exclusion.
- **PFL-4.1**: remove the now-dead unit tests for the three removed heuristics; the
  ledger-based tests from PFL-3.1/PFL-3.2 already cover the equivalent behavior, so no new
  tests are added beyond confirming those still pass post-removal.

Safe to deploy standalone: yes for PFL-1.1 through PFL-3.2. PFL-4.1: yes (removal-only, no
external consumers), gated on human sign-off via `hitl: true` rather than a technical
dependency.

# Patch Methodology Contract

The interface any subagent plugged into the "patch" pipeline phase's classification/fix-strategy
step must satisfy — whether that's the built-in behavior (Steps 3 through 6 of
`plugins/shipwright/commands/patch.md`) or a custom, operator-supplied subagent. The
`/shipwright:patch` command is the caller: it owns resolving the target PR and re-validating it's
still in scope (Steps 1-2), classifying the PR into Lists A/C/D — unresolved review findings,
merge conflicts, and failing CI, respectively (Step 3) — worktree setup and toolchain detection
(Steps 4a/5a/6a), model-tier resolution (Step 2.1), the pre-work claim lock on the PR record, and
the post-fix commit-bump handback to the task store — none of that is delegated. For each
qualifying list, the caller dispatches the patch-phase classification/fix-strategy subagent with
the inputs below and parses the output shape below regardless of which concrete agent produced
it. A drop-in replacement for the built-in classification/fix-strategy step must accept exactly
these inputs and return exactly this output shape — the caller has no other integration point and
does no phase-specific adaptation.

> **Subagent selection is wired up (PTM-1.2).** A per-agent, per-phase `AgentPhaseMethodology`
> record (`{phase, subagentType | null}`, with `patch` as a valid phase key) exists as a Prisma
> model plus CRUD service in `admin/src/agent-phase-methodology.ts`. `commands/patch.md`'s Step
> 2.2 reads `phaseMethodology.patch` off `GET /agents/{id}/config` once per run and resolves
> `PATCH_SUBAGENT_TYPE` — falling back to the built-in `general-purpose` when no override is
> configured, or on any lookup failure (fail-closed, never fail-open). All three of
> `commands/patch.md`'s dispatch sites (Steps 4b, 5b, and 6c) dispatch `PATCH_SUBAGENT_TYPE`
> instead of a hardcoded literal. This contract specifies the wire shape any subagent plugged in
> this way — built-in or operator-configured — must satisfy.

`plugins/shipwright/commands/patch.md`'s Steps 3 through 6 are the **reference implementation**
this contract was extracted from — classifying a PR into Lists A (unaddressed review findings),
C (DIRTY/merge-conflicted), and D (failing CI), the mechanical `compute-unaddressed-findings.ts`
List A gate (ledger, same-head-approval, and author-reply exclusions) that keeps List A from
looping forever, the dependency-risk detection and
remediation protocol, and the per-list fix-dispatch/validate/commit/push sequence. Consult it for
the full built-in classification and fix logic; this doc only specifies the wire shape, not
classification or fix-strategy policy.

## Inputs

Up to four kinds of input accompany a dispatch, but **not every dispatch carries all four** — a
PR can independently qualify for List A (findings), List C (conflicts), and/or List D (CI
failures) in the same cycle, and the built-in caller dispatches the classification/fix-strategy
step once per qualifying list (List C first, then List A, then List D), so a given invocation's
input reflects only the list(s) that triggered it, not the PR's full state across all three. This
is a distinct shape nuance from the deploy-phase contract, which always carries a single, uniform
input shape per dispatch.

- **PR metadata** — always present, on every dispatch regardless of which list(s) qualified:
  - **`repo`** (`org/repo`)
  - **`number`**
  - **`title`**
  - **`headRefName`** (the branch)
  - **`headRefOid`** — the PR's current HEAD SHA at classification time

- **unresolved findings** — present only when this PR qualifies for **List A**:
  - **`reviewThreads`** — the unresolved inline review threads, each with `id` (needed to
    resolve the thread via the `resolveReviewThread` mutation once fixed), `path`, `line`,
    `body`, and the commenting author's login.
  - **review bodies** — non-excluded COMMENTED/CHANGES_REQUESTED review submissions (author
    login, submission timestamp, body). Reviews settled by a task-store ledger entry, superseded
    by the same reviewer's later same-head `APPROVED`, or addressed by a subsequent author reply
    are excluded by the caller (via `compute-unaddressed-findings.ts`) before this input is ever
    assembled — the subagent never sees those. A clean self-`APPROVE` with no ledger entry is
    NOT excluded: it reaches the subagent and is settled as `rejected` (no actionable finding).
  - **PR-level comments** — non-inline comments that may need a reply.
  - **`DEPENDENCY_RISK_FINDING`** (optional) — a nullable `{recommendation, flags, reasoning}`
    shape (per `references/dependency-risk-analysis.md`), present only when the PR also carries
    a dependency-bump risk flag the caller derived from the diff. `recommendation` is one of
    `"merge"` / `"review"` / `"hold"`; a `"merge"` recommendation has nothing to remediate.

- **mergeability state** — present only when this PR qualifies for **List C**:
  - **`mergeStateStatus`** — e.g. `"DIRTY"`. The caller has already confirmed this is the only
    state that routes a PR into List C — merely being `"BEHIND"` with no conflict is not
    patch-worthy on its own.

- **CI status** — present only when this PR qualifies for **List D**:
  - Failing/timed-out/cancelled workflow run details — the failing job names, the failed step
    names within each job, and a truncated log excerpt (the reference implementation caps this
    at the last 200 lines of `gh run view --log --failed` output) sufficient to diagnose the
    failure without re-fetching full logs.

## Output

A single report with these fields:

```
STATUS: DONE / DONE_WITH_CONCERNS / BLOCKED

{fix actions taken}

CONCERNS: (if DONE_WITH_CONCERNS)
BLOCKER: (if BLOCKED)
```

- **`status`** — one of `DONE` / `DONE_WITH_CONCERNS` / `BLOCKED`.
- **fix actions taken** — free text describing what was fixed and pushed, present whenever
  `status` is not `BLOCKED`. Mirrors the reference implementation's per-list report-back framing
  — e.g. Step 5b's `FINDINGS_ADDRESSED` (a bullet list of each finding addressed and how) and
  `TESTS_ADDED`, Step 4b's `CONFLICTS_RESOLVED`, and Step 6c's `FAILURES_FIXED` and
  `TESTS_ADDED`. A compliant subagent is not required to reproduce these exact field names, but
  must report, in free text, what it changed, what it pushed (including the resulting commit),
  and what test coverage it added or why none was needed.
- **`concerns`** — free text, present when `status` is `DONE_WITH_CONCERNS`. Covers correctness
  gaps that didn't block completion — e.g. a REJECTed review finding (with confirmation that a
  rebuttal comment was posted and the finding's inline thread resolved), a pre-existing or flaky
  local-validation failure, or a failure attributed to something outside the fix's scope.
- **`blocker`** — free text, present when `status` is `BLOCKED`. **BLOCKED is the
  escalate-to-HITL decision** — but the subagent itself does not perform the actual escalation
  mechanics. It does not PATCH the task or PR record `blocked`, does not post the PR comment
  explaining the escalation, and does not release its own claim on the PR record. It only reports
  BLOCKED with a `blocker` explanation of what could not be completed and why. The caller (
  `/shipwright:patch`) is the one that runs `references/escalation-pattern.md`'s shared
  PATCH/comment/release sequence in response to a BLOCKED report — the same "caller performs the
  actual side effect, subagent only reports a verdict" pattern the deploy-phase contract uses for
  its own task-store status transitions.

## Scope

This contract covers only the wire shape between the caller and the patch-phase
classification/fix-strategy subagent — what goes in, what comes back. It says nothing about how
the subagent internally decides which findings to accept/modify/reject, how it resolves a merge
conflict, or how it diagnoses a CI failure; those are the concrete implementation's concern (see
`commands/patch.md` for the reference implementation's classification and fix logic).

It also says nothing about what the caller does with the output afterwards, and several
responsibilities stay entirely with the caller, never delegated to the subagent:

- **PR resolution and classification into Lists A/C/D** (Steps 2-3) — the caller alone decides
  which list(s) a PR qualifies for and assembles the corresponding input above; the subagent does
  not re-run this qualification.
- **Worktree setup and toolchain detection** (Steps 4a/5a/6a) — the caller prepares the worktree
  and resolves the lint/test commands before dispatch; the subagent works inside an
  already-prepared worktree.
- **Model-tier resolution** (Step 2.1) — the caller resolves which model tier the dispatch runs
  at; the subagent does not choose its own tier.
- **The commit-bump handback to the PR record** — `POST /prs/{id}/patch`, updating `commitSha`
  (and, for a List D fix, `ciFailureSignature`) on the task-store PR record after any successful
  fix — happens regardless of which list (A/C/D) produced the fix. This is caller-owned
  bookkeeping the subagent never touches directly; the subagent's only responsibility toward it
  is pushing the fix commit and reporting it in its output.
- **HITL escalation mechanics** — as described in the Output section above, reporting BLOCKED is
  as far as the subagent's responsibility goes; the caller performs the actual PATCH/comment/
  release sequence.

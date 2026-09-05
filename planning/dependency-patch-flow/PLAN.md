# Plan Session: dependency-patch-flow

Repo: `app-vitals/shipwright`

## Background

Triggered by investigating `vitals-os` PR #5121 (a Renovate js-yaml v4→v5 bump): the
Shipwright review pipeline correctly detected and reported a real, specific
dependency-risk finding — a transitive-dependency clash breaking a named build script,
invisible to CI — via `references/dependency-risk-analysis.md` (Step 5.8, DBR-3.2) folded
into the posted review body. But `/shipwright:patch` has no dependency-specific handling
at all: the finding just looks like an ordinary third-party `COMMENTED` review to patch,
which can't mechanically resolve it, so three separate patch claims across ~3 hours each
skipped without action (`skipCount` incrementing, no commit).

The retired `triage-dependency-bot-prs` skill (removed #3133/DBR-3.4, superseded by
review's Step 5.8) was confirmed to have been **read-only** even before retirement — it
only posted a merge/review/hold recommendation comment, never attempted a code fix. So
this is not a regression from that retirement; the "patch should try to fix a breaking
dependency change" capability has never existed.

## Design

**Constraint (from Dan):** the dependency-risk analysis is not guaranteed to be available
to whichever agent/session runs `patch` — any agent can claim `review` or `patch`
independently of which agent ran the other phase, and the analysis result from a review
pass is not persisted anywhere structured (no task-store field, no artifact) — only as
free text folded into the GitHub-posted review body. So patch cannot assume a shared
in-memory value from a prior review step; it must treat GitHub as the source of truth
(Independence Principle #1), the same as every other patch input.

**Detection (cheap, no new API calls):** patch's existing Step 3a already fetches every
review's `body` via one GraphQL query before classifying findings. Parse those already
fetched bodies for the `"dependency risk: {recommendation} — {reasoning}"` clause that
review.md's Step 10 folds in verbatim. When found, that `{recommendation, flags,
reasoning}` is used directly — no recomputation, and correct regardless of which agent or
session posted the review.

**Fallback (when no fetched review body contains the clause):** independently re-run the
same detection review.md's Step 5.8 uses — build the repo's watched-path set via the
existing `resolve-dependency-watched-paths.ts` script, compare against the PR's changed
files, and if triggered, apply `references/dependency-risk-analysis.md`'s heuristics
against the current diff. This covers a PR that hasn't been reviewed by Shipwright yet, or
whose manifest changed after the last review.

**New reference file** `references/dependency-patch.md` — mirrors
`dependency-risk-analysis.md`'s reusable-heuristics format (pure analysis, no opinion on
how the caller fetched/persists anything). Given a parsed `{recommendation, flags,
reasoning}` plus the PR's worktree/diff, it defines:
- A **reproduce-before-fixing** protocol: if `reasoning` names a concrete, runnable
  verification command (e.g. a build/codegen script), run it first to confirm the break
  actually reproduces in the worktree before attempting anything.
- A bounded catalog of remediation strategies scoped to what's mechanically safe to
  attempt: a package-manager override/resolution pinning an incompatible transitive
  dependency to a working version; updating first-party call sites for a
  removed/renamed API named in the reasoning.
- A re-verify step: only treat the finding as fixed if the same reproduction command now
  passes clean.
- An explicit "no safe strategy applies" exit: if the reasoning doesn't name a verifiable
  command, or no catalog strategy fits, or the fix can't be verified, leave it as a
  genuine hold — never fabricate a speculative fix.

**patch.md wiring:** the detection above feeds Step 5b's fix-subagent dispatch. When the
finding being addressed is a dependency-risk finding, the subagent prompt gets
`references/dependency-patch.md`'s protocol injected (reproduce → attempt catalog fix →
re-verify) ahead of the existing generic ACCEPT/MODIFY/REJECT classification in [A.5] —
this is additive to [A.5], not a replacement: a finding that reproduces with no catalog
strategy, or that doesn't reproduce as described, falls through to the existing
classification unchanged. Outcome reuses the existing [D]/[E] commit/push/resolve-thread
machinery, and the already-working reply-comment route for third-party reviewer findings
(a third party's review body can never be rewritten, dependency or not — patch already
handles this via a PR-author reply per CPF-2.3).

**No breaking changes.** Purely additive: a new reference file, a new detection step, and
an additive branch inside an existing dispatch step. Safe to deploy standalone.

## Tasks

### DBP-1.1 — Add dependency-patch remediation reference file

**Description:** Add `plugins/shipwright/references/dependency-patch.md`, a reusable
reference (mirroring `references/dependency-risk-analysis.md`'s format) that takes a
`{recommendation, flags, reasoning}` dependency-risk analysis result plus a PR's
worktree/diff and defines: the reproduce-before-fixing protocol, the bounded remediation
strategy catalog (transitive-dependency override/resolution pin; removed/renamed
first-party API call-site update), the re-verify step, and the explicit no-safe-strategy
exit. Pure reference content — no caller wiring in this task.

**Acceptance Criteria:**
- `references/dependency-patch.md` exists, documents Inputs/Output/protocol sections
  matching `dependency-risk-analysis.md`'s structure and cross-references it directly
  (this file consumes that file's output shape)
- The reproduce-before-fixing protocol explicitly requires running the reasoning's named
  verification command before attempting any fix, and re-running it after, before
  claiming the finding fixed
- The remediation catalog is explicitly bounded (lists exactly which strategies are
  in-scope) and states that anything outside the catalog, or an unreproducible/unverifiable
  claim, exits to "leave as hold" rather than attempting a speculative fix
- **Test decision:** add `references/dependency-patch.content.test.ts` (content layer,
  per CLAUDE.md's `*.content.test.ts` convention) asserting the file contains the
  Inputs/Output/protocol sections and the bounded-catalog/no-fabrication language, mirroring
  the existing `references/dependency-risk-analysis.content.test.ts`'s assertion style; no
  unit/integration tests apply since this is prompt content with no executable logic

**Dependencies:** none
**Branch:** `feat/dbp-1-1-add-dependency`
**Layer:** Shared
**Hours:** 2
**Complexity:** 3 (judgment-heavy prose authoring mirroring an existing pattern; no new
code, but the strategy catalog and reproduce/re-verify protocol need care to keep it
correctly bounded)
**Model:** sonnet
**Safe to deploy standalone:** yes

---

### DBP-1.2 — Wire dependency-risk detection and remediation into patch.md

**Description:** Add an independent dependency-risk detection step to
`commands/patch.md` (parses the `"dependency risk: ..."` clause out of the review bodies
Step 3a already fetches; falls back to independently re-running
`resolve-dependency-watched-paths.ts` + `references/dependency-risk-analysis.md`'s
heuristics when no fetched body contains the clause) and wire its result into Step 5b's
fix-subagent dispatch so a dependency-risk finding gets
`references/dependency-patch.md`'s reproduce → attempt-catalog-fix → re-verify protocol
injected, additive to the existing [A.5] ACCEPT/MODIFY/REJECT classification.

**Acceptance Criteria:**
- New step added to `patch.md` (numbered to fit the existing Step 3 sequence, e.g. Step
  3a.5) that: (a) scans the review bodies already fetched by Step 3a's GraphQL query for
  the dependency-risk clause and parses `{recommendation, flags, reasoning}` from it when
  present; (b) when absent, independently invokes
  `resolve-dependency-watched-paths.ts` against the PR's changed files and, if triggered,
  applies `references/dependency-risk-analysis.md` against the current diff — mirroring
  review.md's Step 5.8 exactly, with no dependency on any review-session state
  ever having existed
- Step 5b's fix-subagent prompt includes `references/dependency-patch.md`'s protocol as
  an explicit, clearly-labeled section when the finding being addressed is the
  dependency-risk one, ahead of (not replacing) the existing [A.5] verify/classify
  instructions
- A dependency-risk finding that the subagent verifies as fixed follows the existing [D]
  commit/push path and existing [E] thread-resolution / reply-comment route unchanged —
  no new resolution mechanism introduced
- A dependency-risk finding with no safe catalog strategy, or that fails to reproduce as
  described, falls through to the existing [A.5] classification unchanged (verify this by
  not modifying [A.5] itself)
- **Test decision:** extend `commands/patch.content.test.ts` (content layer) with
  assertions that the new detection step exists, references both
  `resolve-dependency-watched-paths.ts` and `references/dependency-risk-analysis.md` by
  name, and that Step 5b's prompt template references `references/dependency-patch.md`;
  no unit/integration tests apply — this is prompt content, no executable logic changes

**Dependencies:** DBP-1.1
**Branch:** `feat/dbp-1-2-wire-dependency`
**Layer:** Shared
**Hours:** 5
**Complexity:** 4 (cross-cutting edit to a large, heavily cross-referenced command file;
must integrate cleanly with existing Step 3a exclusion logic and Step 5b's prompt
template without disturbing either)
**Model:** sonnet
**Safe to deploy standalone:** yes

## Dependency Map

```
[START]
  └─ DBP-1.1: Add dependency-patch remediation reference file (no deps)
        └─ DBP-1.2: Wire dependency-risk detection and remediation into patch.md (needs 1.1)
```

```
Task     | Depends on | Blocks | HITL
DBP-1.1  | —          | 1.2    |
DBP-1.2  | 1.1        | —      |
```

## HITL Scan

HITL tasks detected: 0
HITL scan: no tasks require human steps — both tasks are plugin prompt/reference content
changes with no infra, secrets, or console actions involved.

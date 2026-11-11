# Plan: pr-origin-classification-fix

Repo: `app-vitals/shipwright`

## Background

The merged-PR metrics dashboard's `human` origin bucket is dominated by mislabeled
Shipwright/CI automation, not real human-authored PRs. Live data pulled from the task
store (`/prs?repo=...&state=merged`) showed, in the most recent 200 merged PRs per repo:

- **vitals-os**: 174/200 classified `human`; 172 were actually vitals-os's own
  infra-bump automation (`bump-shipwright-chart.yml`, `bump-vitals-agent.yml`,
  `update-agent-base-tag.yml`, the changelog-sync step in `deploy.yml`) plus a handful
  of Renovate PRs. 0 genuinely human PRs in the sample.
- **shipwright**: 35/200 classified `human`; 33 were Shipwright's own docs-freshness /
  test-readiness-refresh / plan-session output PRs plus Renovate PRs. 2 genuine human
  PRs (Dave's chart podLabels/security-group work).

## Root causes and design

`deriveOrigin()` (`task-store/src/pr-origin-derivation.ts`) and `classifyPrOrigin()`
(`agent/src/pr-census.ts`) both classify by inference (author-login string matching,
branch-name regex) whenever no task row links the PR. Three distinct gaps drive the
miscount:

1. **Bot-login string drift.** `gh pr list --json author` normalizes bot authors to
   `app/<slug>` (e.g. `app/renovate`) and separately returns `is_bot: true` on the same
   object — confirmed live (`{"login":"app/renovate","is_bot":true}`). The classifier's
   literal `authorLogin === "renovate[bot]"` check can never match what `gh` actually
   returns. Fix: key off `is_bot` first (format-independent), demoting login-string
   matching to "which bot" disambiguation (Renovate/Dependabot vs. other).
2. **No generic signal for a repo's own CI/build automation.** vitals-os's four bump
   workflows already apply `--label automated` to their own `gh pr create` calls (a
   convention Shipwright's own `auto-bump-chart.yml`/`sync-plugin-version.yml` also
   use) — confirmed live in `bump-shipwright-chart.yml:152`, `bump-vitals-agent.yml:141`,
   `update-agent-base-tag.yml:136`, `deploy.yml:353`. The classifier never reads this
   label. Fix: treat the `automated` label as a first-class `ci` signal. This is fully
   generic — any repo's own automation opts in with one flag on a call it's already
   making — and requires zero hardcoded, org-specific branch-name strings.
3. **No signal at all for Shipwright's own doc-automation output.** docs-freshness
   (`research-docs --auto`), test-readiness-refresh, and plan-session's own PR-adding
   step never link a task row (their own `/tasks/bulk` calls file *separate* follow-up
   work items, not a task for their own PR) and never apply any label — confirmed live
   on PRs #3707, #3548, #3575 (`labels: []` on all three). Fix: apply a new `shipwright`
   label at these three PR-open call sites specifically, since none of them otherwise
   talk to the task-store to track themselves (see decision below).

**Historical note:** a prior attempt at a `shipwright` label (`feat/pom-1-3-shipwright-pr-label`,
PR #3462) was closed by the repo owner in favor of direct task-store stamping — but that
was scoped to `dev-task.md`/`deploy.md`, both of which already hold task-store
credentials and write task/PR state as their core job. Docs-freshness/test-readiness-refresh/
plan-session have no such relationship — minting task-store auth and a second,
independently-failing network call for a cron that otherwise never touches `/prs/*` is
more fragile than one `--label` flag on a `gh pr create` call it already makes. Direct
stamping remains the right call wherever the caller already writes task-store state
(hence task 6 below, closing the still-open `deploy.md` canary-revert gap the same way
the original ruling intended).

**Reconciling with `pr-census.ts`'s own rejection:** `classifyPrOrigin()`'s docstring
(`agent/src/pr-census.ts` lines 4-11, 90-103) separately documents a function-level
decision to ship "WITHOUT the GitHub-label approach that was rejected" — narrower than,
and independent of, the PR #3462 ruling above: it reasoned that the task-row match
already identifies shipwright's own PRs, so a label added nothing. That reasoning holds
for the PRs `classifyPrOrigin()` was built against, but the live census data in root
cause #3 shows a bucket it didn't anticipate — docs-freshness/test-readiness-refresh/
plan-session PRs that are neither task-linked nor bot/branch-pattern-matched. POF-1.2
supersedes only that narrower claim: the `shipwright` label becomes an additive signal
checked after the existing task-row match, which stays authoritative and unchanged, and
fills exactly the gap the original "no label arm" design left uncovered. POF-1.2 should
update this docstring's framing (and the "first match wins, NO label arm" line) to
reflect that when it lands.

## Origin taxonomy (final)

1. **shipwright** — linked task row, or `shipwright` label
2. **dependency_bot** — `is_bot` + Renovate/Dependabot login
3. **ci** — `automated` label, or `is_bot` (any other bot)
4. **human** — non-empty author login, none of the above
5. **unknown** — no signal at all

## Decisions

- `is_bot` and the `automated`/`shipwright` labels are additive signals layered onto
  the existing precedence — no removal of the existing task-row-match or login-string
  checks (the latter stay as "which bot" disambiguation once `is_bot`/label say
  "some automation").
- No org-specific branch-name regex additions. vitals-os's bump-workflow branch names
  (`chore/shipwright-chart-bump`, etc.) are that repo's own convention, not something
  Shipwright's generic classifier should hardcode.
- Label vs. direct task-store stamping is decided per caller: stamp directly when the
  caller already holds task-store credentials and writes task/PR state as part of its
  normal job (`deploy.md`); use a label when it doesn't (the three doc-automation crons).

## Tasks

| ID | Title | Layer | Complexity | Model | Deps | HITL |
|---|---|---|---|---|---|---|
| POF-1.1 | Add `is_bot` + `automated`/`shipwright` label signals to task-store's `deriveOrigin()` | API | 3 | sonnet | — | no |
| POF-1.2 | Same in agent's `classifyPrOrigin()`; forward signals from check-review's existing fetch | Shared | 3 | sonnet | POF-1.1 | no |
| POF-2.1 | Script the PR-open step in docs-freshness with `--label shipwright` | CLI | 2 | haiku | — | no |
| POF-2.2 | Script the PR-open step in test-readiness-refresh with `--label shipwright` | CLI | 2 | haiku | — | no |
| POF-2.3 | Script the PR-open step in plan-session with `--label shipwright` | CLI | 2 | haiku | — | no |
| POF-3.1 | Stamp `origin=shipwright` directly via `/prs/census` on deploy.md's canary-revert PR | CLI | 3 | sonnet | — | no |

All additive — no renames/removals, safe to deploy standalone.

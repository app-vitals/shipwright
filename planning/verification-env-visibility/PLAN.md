# Plan Session: verification-env-visibility

**Repo:** app-vitals/shipwright

## Origin

Feature request from Dan (2026-09-29): extend the agent detail page's "Recent
Verification Activity" card so users can see when agents can't actually run
verification checks in their environment (missing tool/secret/dependency, not
configured, timeouts, resource limits) — the goal is visibility into
environment health, not code-failure triage, so the environment can be fixed
and the agent's feedback loop improved.

Scope, per Dan's explicit clarification:
- Only **environmental causes** — i.e. `reasonCategory` on `skipped`/`timed_out`
  `VerificationCheck` rows.
- Explicitly **out of scope**: `ran_failed` rows / "tests failed naturally
  during implementation, debugging or iterations". `reasonCategory` is
  guardrailed by `task-store/src/verification-check-service.ts` to never be
  set on a `ran_failed` row, and there is no other field capturing why a check
  actually failed — no schema/write-path change is needed or wanted here.
- Add a repo breakdown, since an agent can span multiple repos and
  environment issues are often repo-specific.

## Technical Design

**Business logic** — `admin/src/admin-ui.ts`, `buildVerificationActivityRollup()`

Extend the existing per-check reduce loop (already iterates every fetched
`VerificationCheckItem`, which carries `repo` and `reasonCategory`) to
populate two new maps, same shape as the existing `byCheckName`:
- `byRepo: Record<string, Record<string, number>>` — repo → status → count
- `environmentalByRepo: Record<string, Record<string, number>>` — repo →
  reasonCategory → count, built only from rows where `reasonCategory` is
  non-null (the write-path guardrail already restricts non-null
  `reasonCategory` to `skipped`/`timed_out` rows — no extra filtering needed)

No new fetches — purely widening an aggregation that already iterates the
right data.

**Views/UX** — `admin/src/admin-ui-pages.ts`, `VerificationActivitySummary` +
`renderVerificationActivityCard()`

- Add the two optional fields to the `VerificationActivitySummary` interface.
- Render a per-repo status breakdown (same `renderStatusCountBadges` pattern
  as the existing per-checkName rows), skipped when the agent only has one
  repo represented in the rollup.
- Add an "Environmental issues" sub-section rendering `environmentalByRepo` as
  labeled badges — new `VERIFICATION_REASON_CATEGORY_LABEL` map, mirroring
  the existing `VERIFICATION_STATUS_LABEL` pattern, covering all 8
  `reasonCategory` values (`check_timeout`, `install_timeout`,
  `resource_limit`, `missing_tool`, `missing_secret`, `missing_dependency`,
  `not_configured`, `learned_skip`). When there are zero
  skipped/timed_out-with-reason checks, render an explicit "no environmental
  issues in recent runs" line rather than omitting the section — that's the
  actionable all-clear signal.

**APIs / DB** — none. `GET /verification-checks` already returns `repo` and
`reasonCategory` per row (`task-store/src/openapi-schemas.ts`'s
`VerificationCheckSchema`).

**Complexity risks noted, not blocking:**
- The open `agent-landing-page-redesign` session (`AGA-1.1/1.2/1.3`, still
  pending at plan time) also restructures the same agent-detail page
  (accordion grouping, stat strip) in `admin/src/admin-ui-pages.ts`. No
  functional overlap found (that plan doesn't mention verification activity),
  but both land near the same card layout — soft rebase-collision risk
  between the two sessions, not a hard dependency.

## Task Breakdown

Single self-contained task — additive only, no renames/removals/constraints.

| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| VEA-1.1 | — | — | |

**Safe to deploy standalone: yes**

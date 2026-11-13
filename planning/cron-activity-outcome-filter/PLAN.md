# Plan: cron-activity-outcome-filter

## Background

Specialist agents have no `preCheck` script, so their skipped cron ticks flood the
activity log. Fix by filtering, not by changing what is recorded: a multi-select outcome
filter whose default view hides skipped runs. Skipped runs are still one click away.

## Findings

- Skipped runs carry `skipped = true` and `outcome = NULL` (prod sample, 1,012 runs on one
  agent: `completed` 675, `failed` 12, null non-skipped 53, skipped 271). The UI badge is
  `cronRunOutcomeLabel`: `skipped ? "skipped" : (outcome ?? "unknown")`.
- `AgentCronRunService.listForAgent` / `listAcrossAgents` live in the published
  `@app-vitals/agent-admin` package (`app-vitals/agent`, `admin/src/agent-cron-runs.ts`).
  They take a single `outcome`: `"skipped"` maps to `skipped = true`, any other value to
  `skipped = false AND outcome = value`. `unknown` is not representable, and only one value
  can be passed.
- Shipwright pins `@app-vitals/agent-admin` 1.37.0 (= latest tag). Pages:
  per-agent `/admin/agents/:id/queue-activity` (hardcoded stale dropdown: posted, dm,
  silent, skipped, error) and fleet `/admin/queue-activity` (no filters at all).

## Design

Filter options mirror the badge: `completed`, `skipped`, `failed`, `unknown`.
Query semantics (OR across selected values):

- `skipped` -> `skipped = true`
- `unknown` -> `skipped = false AND outcome IS NULL`
- any other value -> `skipped = false AND outcome = value`

Default with no `outcome` param: everything except `skipped`. Filtering happens in the
query so pagination totals stay correct. Stats endpoints are unchanged. A legacy single
`outcome=x` URL keeps working. No repo or specialist-type filter; the per-agent cron
filter stays as is.

Outcomes outside the four (none seen in the one-agent sample; specialists unchecked) are
unfilterable by design. Revisit with an "other" bucket if one shows up.

## Tasks

| Task | Repo | Depends on | HITL |
|------|------|-----------|------|
| COF-1.1 | app-vitals/agent | — | |
| COF-1.2 | app-vitals/shipwright | COF-1.1 | |
| COF-2.1 | app-vitals/shipwright | COF-1.2 | |
| COF-2.2 | app-vitals/shipwright | COF-2.1 | |

Producer -> release gate -> consumer, because the list queries ship in a published package.
COF-1.1 is additive (new optional `outcomes`, old `outcome` untouched), so it is safe to
deploy alone. Minimum version 1.38.0 assumes the next minor release after 1.37.0.

## Decision Log

- Default-hide implemented in the query, not the UI: keeps pagination counts right.
- `failed`, not `error`, in the filter: matches the badge and prod data.

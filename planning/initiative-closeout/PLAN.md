# Plan: initiative-closeout

Repo: app-vitals/shipwright · Session: `initiative-closeout` · Requested by Dan

## Summary
When a `prd` or `plan-session` run is started from an `initiative` (or `idea`) task in the task
store, close that task out (`status: done`) once the run completes. Starting either command
means the work is in progress and dev tasks will be queued, so closing at whichever finishes
first (prd spec finalized, or plan-session tasks queued) is intended.

## Design
**Id passing** — add an optional `--initiative {task-id}` flag to `plugins/shipwright/commands/prd.md`
and `plan-session.md`. The caller (Slack/dispatcher) passes the id; no slug-based detection.
The admin "promote" actions are unchanged — passing the id is sufficient.

**Validation** — before closing, `GET /tasks/{id}`; proceed only if `kind` is `initiative` or
`idea` and status is not already closed (`done`/`cancelled`/etc). Wrong kind, closed, or
missing → print a warning and continue. A bad id never fails the session.

**Close-out** — `PATCH /tasks/{id} {"status":"done","source":"planning/{session}/{artifact}"}`
where artifact is `PRODUCT-SPEC.md` (prd, end of Phase 5 after the spec is finalized) or
`PLAN.md` (plan-session, after Step 6b's bulk POST succeeds, alongside Step 6c). Covers both the
built-in and configured-methodology paths since they converge on those steps. A failed PATCH
warns and continues. With no `--initiative` flag, behavior is unchanged.

**Not in scope** — task-store changes (none needed); admin UI changes.

## Tasks
| Task | Title | Layer | Depends on | Model | Branch |
|---|---|---|---|---|---|
| ICO-1.1 | feat: close out initiative on plan-session completion | CLI | — | sonnet | feat/ico-initiative-closeout |
| ICO-1.2 | feat: close out initiative on prd completion | CLI | — | sonnet | feat/ico-initiative-closeout |

Bundled (same branch/PR) so the two commands stay consistent. Same-branch siblings serialize
automatically.

## Breaking Change Safety
Additive optional flag only. Safe to deploy standalone: yes.

## Decision Log
- Close at whichever of prd/plan-session completes first (Dan): work is in progress and dev tasks will be queued.
- Status: `done`; applies to both `initiative` and `idea` kinds (Dan).
- Id passing: explicit `--initiative` flag only; no admin promote-action changes (Dan).

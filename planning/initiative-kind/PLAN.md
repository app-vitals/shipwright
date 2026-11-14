# Plan: initiative-kind

Repo: app-vitals/shipwright · Session: `initiative-kind` · Requested by Dan

## Summary
Add two new task kinds so the team can capture upcoming work on the admin tasks page without
auto-dispatching it:

- `initiative` — a rough, possibly incomplete work item the team intends to do soon
  (e.g. "review: add risk score"). Flow: initiative → plan-session (human/HITL) or promote to
  `prd` (auto-planning) → `dev` tasks.
- `idea` — unprioritized thoughts. Hidden by default so it creates no noise.

`prd` stays reserved for the `--autonomous` auto-planning flow. Neither new kind is ever ready
for the execution loop (`ready.ts` already excludes `prd`; extended to the new kinds).

## Design
**task-store** — add `initiative` and `idea` to `TaskKind` (additive enum migration), the
create/filter zod enums in `openapi-schemas.ts`, allow `kind` on PATCH (promotion), and exclude
both from `ready.ts`.

**admin** (`admin/src/coding/admin-ui-work-item-pages.ts`) — `bucketTaskColumn` gets a first rule:
`kind === "initiative"` (not closed) → new `planning` column, rendered before Queued; `idea` →
`ideas` column, rendered only when `?ideas=1` (toggle in the filter bar). Table view gets
kind badges and a kind filter. A quick-add form creates `initiative`/`idea` tasks; promote
actions: idea → initiative → prd. `task-store-types.ts` regenerated.

## Tasks
| Task | Title | Layer | Depends on | Model | Branch |
|---|---|---|---|---|---|
| INI-1.1 | feat: add initiative and idea task kinds to task-store | Database | — | sonnet | feat/ini-task-kinds |
| INI-1.2 | feat: render planning and hidden ideas columns on admin tasks page | Frontend | INI-1.1 | sonnet | feat/ini-admin-planning-columns |
| INI-1.3 | feat: quick-add and promote initiative/idea tasks from admin | Frontend | INI-1.1, INI-1.2 | sonnet | feat/ini-admin-planning-columns |
| INI-1.4 | chore: seed initial shipwright initiatives (SWI-1..5) | Shared | INI-1.1 | haiku (HITL) | feat/ini-seed-initiatives |

INI-1.2 and INI-1.3 are bundled (same branch/PR). All tasks are additive — safe to deploy
standalone. INI-1.1 must ship first (admin consumes the new enum values).

## Breaking Change Safety
Enum additions only; no renames or removals. Existing `dev`/`prd` behavior unchanged.

## Decision Log
- Kind name: `initiative` (Dan chose over plan/idea/backlog/epic/feature/proposal).
- Fields: no new schema; owner/multi-repo/linked-markdown stay in the description body (follow-up).
- Hidden column: `idea` via URL toggle `?ideas=1`, off by default.
- System-crons feature from the source list is out of scope.

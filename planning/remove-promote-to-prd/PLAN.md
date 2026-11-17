# Plan: remove-promote-to-prd

Repo: app-vitals/shipwright

## Design
Promotion to PRD should happen by running `/shipwright:prd` or `/shipwright:plan-session`, which close the initiative via `--initiative {task-id}` (already implemented in both commands). So the admin "Promote to PRD" button is redundant.

- `admin/src/coding/admin-ui-work-item-pages.ts`: `promoteTargetKind` maps only `idea` -> `initiative`; `renderPromoteForm` renders only "Promote to initiative"; initiative detail hint shows `/shipwright:prd <session> --initiative <id>` and `/shipwright:plan-session <session> --initiative <id>` and says the initiative closes when the run finishes.
- `admin/src/coding/admin-ui-coding.ts`: `POST /admin/tasks/:id/promote` rejects initiative (promote_invalid); message copy updated.
- Tests: `admin-ui-work-item-pages.unit.test.ts`, `admin-ui-tasks.smoke.test.ts`.
- No change to prd/plan-session commands.

## Tasks
| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| RPB-1.1 | — | — | |

RPB-1.1 is additive-free removal; the only consumer of the initiative->prd route is the removed button. Safe to deploy standalone: yes.

## Decision Log
- Kept "Promote to initiative" on ideas: Dan only asked to remove the PRD button.

# Plan: Planning upgrade (session `planning-upgrade`, initiative SWI-1)

**Date**: 2026-11-16 · **Spec**: `planning/planning-upgrade/PRODUCT-SPEC.md` · **Design**: `docs/superpowers/specs/2026-11-16-planning-documents-owner-multi-repo-design.md` · **Repo**: `app-vitals/shipwright` · **Task prefix**: `PLU`

## Technical design (by layer)

- **DB**: one additive Prisma migration: `PlanDocument` table (unique on account, session, kind, number); nullable `Session.owner/homeRepo/declaredRepos` plus lock holder and expiry; nullable `Task.owner/planDocumentId/specDocumentId/originKind/originRef`. No constraint on existing rows.
- **API (task-store)**: shared unknown-query-parameter guard derived from the zod query schemas (PLU-1.1, reused by `GET /documents`); `POST/GET/PATCH /documents`; session fields, `repos` as the union of task and declared repos, document-based scoped visibility; lock acquire/release; scope preflight; task owner, document links and a single shared origin-kind list that validates both writes and filters.
- **Background**: nightly reconciler in the existing sweeper pattern; only touches `state`, `prUrl`, `commitSha`; no-op without a GitHub credential; injected `Clock` and recorded GitHub fixtures.
- **Plugin**: one shared registration module under `plugins/shipwright/scripts/` (rules implemented once; used by lazy registration in the commands and by the operator script); `/prd` and `/plan-session` command, template and both contract changes; task-filing skills write `originKind: skill`.
- **Admin UI**: Documents block, owner columns and filters, Mine / All switch, `source` as a link; no GitHub call at render time.
- **Autonomous path**: `check-plan.ts` and `loop-orchestrator.ts` are read-only references; the `{repo} {session} --autonomous {task-id}` form is handled inside the command.

### Complexity risks flagged

- ⚠ `plan-session.md` is edited by three tasks (PLU-4.1 contract, 4.2, 4.3); they are chained by dependency edges to avoid conflicting PRs.
- ⚠ The foundation tasks all touch `openapi-schemas.ts` and generated artifacts; PLU-2.2 → 2.3 → 2.4 → 2.5 are chained for the same reason.
- ⚠ PLU-5.2 edits the same initiative pages as pending task RPB-1.1, so it depends on it.
- ⚠ Scoped-token visibility (PLU-2.3) changes an authorization rule; it only widens reads and keeps write rules, and has explicit negative tests.

### Breaking Change Scan

- The only deliberate behaviour change is PLU-1.1 (400 on unknown query parameters on `GET /tasks` and `GET /sessions`). Callers found in this repo are fixed in the same PR (atomic update); external callers are covered by the `docs/migration.md` note. `GET /documents` is new and rejects unknown parameters from day one.
- Everything else is additive: one new table, nullable columns, new endpoints and optional fields. No rename, removal or constraint on existing rows. Safe to deploy standalone: yes for every task except PLU-1.1 (yes, once its audit fixes land in the same PR).
- `source` is kept and still written; `status` filter drift is avoided by the shared origin-kind list.
- Contract changes (`specs[]`, `homeRepo`, `repos[]`) are plugin-internal prompt contracts, updated together with the command in the same sequence (PLU-4.1 → 4.2).

## Tasks

| Task | Title | Layer | Hrs | Cx | Model | Depends on | HITL |
|---|---|---|---|---|---|---|---|
| PLU-1.1 | reject unknown query parameters on list endpoints (with caller audit) | API | 6 | 4 | sonnet | — | |
| PLU-2.1 | add planning document schema migration | Database | 3 | 5 | opus | 1.1 | |
| PLU-2.2 | add planning documents service and routes | API | 6 | 4 | sonnet | 2.1 | |
| PLU-2.3 | add session owner, home repo and document visibility | API | 5 | 4 | sonnet | 2.2 | |
| PLU-2.4 | add planning lock and scope preflight endpoints | API | 4 | 3 | sonnet | 2.3 | |
| PLU-2.5 | add task owner, document links and typed origin | API | 6 | 4 | sonnet | 2.4 | |
| PLU-2.6 | add nightly planning document reconciler | Background | 5 | 4 | sonnet | 2.2 | |
| PLU-2.7 | wait for planning foundation deployed on the live store (gate) | Background | 1 | 1 | haiku | 2.2–2.6 | |
| PLU-3.1 | add shared planning document registration module | Shared | 5 | 4 | sonnet | 2.7 | |
| PLU-3.2 | update prd command for numbered specs and repos | CLI | 6 | 4 | sonnet | 3.1 | |
| PLU-4.1 | update plan-session contract for specs and repos | Shared | 3 | 3 | sonnet | 3.2 | |
| PLU-4.2 | update plan-session command for sessions and repos | CLI | 6 | 4 | sonnet | 4.1, 3.1 | |
| PLU-4.3 | add plan-session lock, append-only passes and docs PR | CLI | 6 | 4 | sonnet | 4.2 | |
| PLU-4.4 | set origin kind in task-filing skills | CLI | 4 | 3 | sonnet | 2.7, 3.2 | |
| PLU-5.1 | show documents, owner and Mine view on sessions | Frontend | 6 | 4 | sonnet | 2.7, 4.3 | |
| PLU-5.2 | show owner, origin and Mine view on tasks | Frontend | 5 | 4 | sonnet | 5.1, RPB-1.1 | |
| PLU-6.1 | add planning session registration script | CLI | 4 | 3 | sonnet | 5.2, 3.1 | |
| PLU-6.2 | run registration script against the live install | CLI | 2 | 2 | haiku | 6.1, 2.7 | ⚠ HITL |

Every task is its own branch and PR (no bundles). Full descriptions, acceptance criteria and test decisions are on the task records.

## Dependency map

```
[PRIOR SESSIONS]
  └─ RPB-1.1: remove Promote to PRD from admin [pending]  (session: remove-promote-to-prd)

[START]
  └─ PLU-1.1  reject unknown query params (ships alone, first)
        └─ PLU-2.1  schema migration
              └─ PLU-2.2  documents service + routes
                    ├─ PLU-2.3  session fields + visibility
                    │     └─ PLU-2.4  lock + preflight
                    │           └─ PLU-2.5  task owner / links / origin
                    └─ PLU-2.6  reconciler
        (2.2–2.6) └─ PLU-2.7  GATE: foundation deployed on the live store
              ├─ PLU-3.1  registration module
              │     └─ PLU-3.2  /prd
              │           ├─ PLU-4.1  contract ── PLU-4.2 ── PLU-4.3  /plan-session
              │           └─ PLU-4.4  task-filing skills (also needs 2.7)
              ├─ PLU-5.1  admin sessions (needs 2.7, 4.3) ── PLU-5.2 admin tasks (needs RPB-1.1)
              └─ PLU-6.1  script (needs 5.2, 3.1) ── PLU-6.2  HITL live run (needs 2.7)
```

| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| PLU-1.1 | — | 2.1 | |
| PLU-2.1 | 1.1 | 2.2 | |
| PLU-2.2 | 2.1 | 2.3, 2.6, 2.7 | |
| PLU-2.3 | 2.2 | 2.4, 2.7 | |
| PLU-2.4 | 2.3 | 2.5, 2.7 | |
| PLU-2.5 | 2.4 | 2.7 | |
| PLU-2.6 | 2.2 | 2.7 | |
| PLU-2.7 | 2.2–2.6 | 3.1, 4.4, 5.1, 6.2 | |
| PLU-3.1 | 2.7 | 3.2, 4.2, 6.1 | |
| PLU-3.2 | 3.1 | 4.1, 4.4 | |
| PLU-4.1 | 3.2 | 4.2 | |
| PLU-4.2 | 4.1, 3.1 | 4.3 | |
| PLU-4.3 | 4.2 | 5.1 | |
| PLU-4.4 | 2.7, 3.2 | — | |
| PLU-5.1 | 2.7, 4.3 | 5.2 | |
| PLU-5.2 | 5.1, RPB-1.1 | 6.1 | |
| PLU-6.1 | 5.2, 3.1 | 6.2 | |
| PLU-6.2 | 6.1, 2.7 | — | ⚠ HITL |

The ready-filter treats `merged` as satisfying a dependency, so "foundation deployed" is enforced by the PLU-2.7 gate (a live-store check), not by the merge of 2.2–2.6. The `/prd`, `/plan-session`, admin UI and registration tasks all depend on that gate directly or transitively.

## HITL scan

HITL tasks detected: 1. PLU-6.2: runs the registration script against the live install (Type A; judgment: reads and writes live production data from a checkout outside the agent's normal path, plus a live-data check of distinct `source` values). No task touches `.claude/**`, no CI workflow secrets are added.

## Not carried

- "`task ci` passes" (Success Criteria): enforced by the repo's merge gate on every PR.
- "Every session and task that existed before still opens, and every existing `source` value still resolves": carried as acceptance criteria of PLU-2.1 (additive migration, existing suites unchanged) and PLU-5.x (source stays plain text without a link); no separate task.
- Out of scope per the spec and not planned: owner-driven behaviour, multi-repo single tasks, a planning repo, file-per-pass, server-allocated ids / cursor pagination / user ids / teams (tracked as SWI-7), `originKind` backfill, changes to dev-task/review/patch/merge.

## Decision Log

- Approval: the spec was approved by the requester before this pass and the task queue was requested directly; this breakdown was produced in one pass and is reviewed through the plan PR.
- Session prefix: defaulted to `PLU` — no existing prefix collides (checked against the live store).
- Gate over merge: foundation "deployed" requirement is a live-store gate task (PLU-2.7) because dependencies close on `merged`.
- Sequence enforcement: Feature 5 (`/prd`) before Feature 6, Feature 7 after Feature 6, and Feature 8 after Feature 7 are encoded as dependency edges, per the spec's Priorities & Sequence, even where code does not strictly require them.
- Shared registration module: lives in `plugins/shipwright/scripts/` so the repo-agnostic commands and the operator script use one implementation; the operator script (PLU-6.1) is a thin wrapper, the module is built first (PLU-3.1) because `/prd` needs lazy registration.
- Docs, OpenAPI, generated types and MCP docs are regenerated inside each foundation task rather than in a trailing task, so each PR passes the repo's generation checks on its own.
- Owner: never written to a committed file; acceptance criteria use the placeholder `a@example.com` only.

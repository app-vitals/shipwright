# Planning Upgrade: Owners, Document Records, Multi-Repo Sessions — Product Specification

**Date**: 2026-11-16
**Session**: planning-upgrade
**Status**: Approved
**Initiative**: SWI-1
**Design reference**: `docs/superpowers/specs/2026-11-16-planning-documents-owner-multi-repo-design.md` (authoritative for any detail not repeated here)

## Overview

`/shipwright:prd` and `/shipwright:plan-session` produce a product spec, a plan and a task
queue, but the link between the person who asked, the documents, the session and the tasks
is a free-text line and one path string. This work makes owners and planning documents real
records, lets a session receive more specs and planning passes, and lets one spec or plan
cover several repos, without breaking anything that exists today.

## Problem Statement

- The requester of a piece of work is recorded as prose in a plan header or an initiative
  description. Nothing can filter or act on it.
- `/prd` commits nothing. Of 119 committed sessions in this repo, 118 have a `PLAN.md` and
  only 14 have a spec.
- Re-running `/plan-session` on a session overwrites `PLAN.md`, and the plan PR step then
  skips because a PR for the branch already exists, so the new plan is never committed.
- A session is locked to one repo in three places (the argument, the preflight, the task
  validation rule), although tasks are per-repo and task ids are global. 96 of 747 live
  sessions already have tasks in more than one repo, arranged by hand.
- Task `source` is one unvalidated string holding nine different shapes of value. Several
  pending initiatives point at a plan that has nothing to do with them.
- List endpoints silently ignore query parameters they do not recognise, so a filter on a
  field an older store lacks returns the whole store.

## Users & Context

- **Engineers and product owners** who request work and need to find, read and steer their
  own sessions among hundreds.
- **Agents** that run `/prd` and `/plan-session` (interactively on someone's behalf, or
  autonomously from a `kind: prd` task) and need a non-ambiguous, repeatable write path.
- **Operators** who run the task store and admin UI for many repos and many people.

---

## Features

### Feature 1: Reject unknown query parameters

**Priority**: High
**Description**: List endpoints return 400 for a query parameter they do not recognise, so a
filter can never silently widen to "everything".

**User Stories**:
- As an agent, I want an unsupported filter to fail loudly so that I never act on tasks I
  did not ask for.

**Requirements**:
- `GET /tasks`, `GET /sessions` and `GET /documents` return 400 naming the unknown parameter.
- Every caller in this repo (plugin commands and skills, agent, admin, metrics, MCP server)
  is audited for stray parameters in the same change.
- The change is recorded in `docs/migration.md`.

**Acceptance Criteria**:
- [ ] `GET /tasks?bogus=1` returns 400 with a body naming `bogus`; the same for `/sessions`.
- [ ] Every documented parameter of each endpoint is still accepted (smoke test enumerates them from the OpenAPI schema).
- [ ] A repo-wide audit test or script finds no caller sending an undocumented parameter.
- [ ] Smoke tests added for both the reject path and the accept path.

**Technical Considerations**: This is the one deliberate behaviour change to existing
endpoints. It ships alone, first. The parameter allow-list should derive from the same zod
schemas that generate the OpenAPI document so they cannot drift.

**Source Map**:
- `task-store/src/routes/tasks.ts` — list handler
- `task-store/src/routes/sessions.ts` — list handler
- `task-store/src/openapi-schemas.ts` — query schemas
- `docs/migration.md` — breaking-change note

**Testing Strategy**: Layer: smoke — HTTP route contract via in-process `app.request()`.

---

### Feature 2: Planning document records

**Priority**: High
**Description**: Each spec and plan is a row in the task store, linked to its session and to
the tasks it produced, with a state that tracks its docs PR.

**User Stories**:
- As an engineer, I want a session to show its specs and plan with working links so that I
  can read what a task was built from.
- As an agent, I want to ask "which specs in this session are not planned yet?" in one call.

**Requirements**:
- New `PlanDocument` table: session, kind (`spec` | `plan`), number, home repo, path, title,
  owner, target repos, PR url, state (`draft` | `pr_open` | `merged` | `abandoned`), commit
  SHA, `plannedAt`, origin task id. Unique on account, session, kind, number.
- `Session` gains `owner`, `homeRepo`, `declaredRepos`. The existing session `repos` response
  field keeps its name and filters and becomes task repos plus declared repos.
- `Task` gains `planDocumentId` and `specDocumentId`. `source` is unchanged and still written.
- `POST /documents` (idempotent on the unique key), `GET /documents` with `session`, `kind`,
  `owner`, `planned` filters, `PATCH /documents/:id`.
- Registering a document ensures the session row exists.
- Scoped tokens see a document, and its session, when its home repo or any target repo is in
  scope, in addition to today's task-based rule. Registering requires the home repo in scope.
- A read-only scope preflight endpoint reports which of a list of repos the calling token
  may write to.
- A nightly reconciler moves `draft` and `pr_open` documents to `merged` or `abandoned` from
  GitHub state. It changes only `state`, `prUrl` and `commitSha`, and is a no-op without a
  GitHub credential.
- OpenAPI, generated types and generated MCP tool docs are regenerated.

**Acceptance Criteria**:
- [ ] Migration is additive only; existing rows are untouched and all new columns are nullable.
- [ ] `POST /documents` twice with the same session, kind and number yields one row with the later `prUrl`.
- [ ] `GET /documents?session=x&kind=spec&planned=false` returns only specs with no `plannedAt` and excludes `abandoned` ones.
- [ ] A scoped token whose scope includes a document's target repo can read that document and its session even when the session has no tasks.
- [ ] The preflight endpoint returns the uncovered repos for a token that lacks one of the repos asked about.
- [ ] The reconciler, given a recorded GitHub fixture of a merged PR and a closed-unmerged PR, sets `merged` and `abandoned` respectively and touches no other field.
- [ ] Integration tests cover the service; smoke tests cover each route; the reconciler uses an injected clock and a recorded GitHub fixture.

**Technical Considerations**: Session rows are created today as a side effect of task writes
(`session-service.ts`). Follow the existing sweeper pattern for the reconciler.

**Source Map**:
- `task-store/prisma/schema.prisma` — new model and columns
- `task-store/src/session-service.ts` — session fields, visibility, repos union
- `task-store/src/task-service.ts` — document ids on create, bulk and patch
- `task-store/src/openapi-schemas.ts`, `task-store/src/app.ts` — schemas and route mount
- `docs/task-store.md`, `docs/mcp-tools.md` — reference docs

**Testing Strategy**: Layer: integration — real database behaviour for the service; smoke for routes.

---

### Feature 3: Owner

**Priority**: High
**Description**: The person who requested the work is a real, optional field, inherited
from initiative to spec to plan to session to tasks.

**User Stories**:
- As a requester, I want my sessions and tasks to carry my identity so that I can filter to
  my own work.

**Requirements**:
- `owner` is a nullable email on `Task`, `PlanDocument` and `Session`. It is never written
  into a committed file.
- Interactive default is `git config user.email`, shown in the command's opening summary.
  `--owner {email}` overrides.
- With `--initiative {id}` the initiative's owner is used when set. A plan inherits its
  spec's owner. A session's owner is set by its first document and not overwritten. Tasks
  inherit the owner of the plan that created them.
- Autonomous runs use the originating `prd` task's owner. A missing owner never blocks; it is
  noted in the Decision Log.
- `GET /tasks`, `GET /sessions` and `GET /documents` filter on `owner`.
- The admin quick-add form for initiatives and ideas sets owner to the signed-in user's
  email, editable.

**Acceptance Criteria**:
- [ ] Tasks created by `/plan-session` for a spec with owner `a@example.com` all carry that owner.
- [ ] A session whose first document has owner A keeps owner A after a second document with owner B is registered.
- [ ] `GET /tasks?owner=a@example.com` returns only that owner's tasks.
- [ ] An autonomous run from a `prd` task with no owner completes and its plan contains a Decision Log line saying owner was left empty.
- [ ] No committed planning file contains an email address (content test on the file header template).
- [ ] Unit tests cover the inheritance rules; integration tests cover the filters.

**Technical Considerations**: The existing `assignee` and `claimedBy` fields identify agents,
not people; do not reuse them. The admin side already identifies people by email.

**Source Map**:
- `task-store/prisma/schema.prisma`, `task-store/src/task-service.ts`, `task-store/src/session-service.ts`
- `plugins/shipwright/commands/prd.md`, `plugins/shipwright/commands/plan-session.md`
- `admin/src/coding/admin-ui-work-item-pages.ts` — quick-add form

**Testing Strategy**: Layer: integration — filters and inheritance against a real database; content tests for the command text.

---

### Feature 4: Typed origin

**Priority**: Medium
**Description**: Every task can say what produced it (a document, a skill, a cron or a
human) through a validated field, separate from owner.

**User Stories**:
- As an operator, I want to tell scanner-filed tasks from planned ones without parsing a
  free-text field.

**Requirements**:
- `Task` gains nullable `originKind` and `originRef`.
- `originKind` comes from one registered list: `document`, `skill`, `cron`, `human`. The
  same list validates writes and filters.
- `/plan-session` writes `originKind: document` with the plan's document id. Skills and
  system crons that file tasks write their own kind and name.
- `source` is still written as today and is not migrated.

**Acceptance Criteria**:
- [ ] A write with `originKind: "bogus"` is rejected with 400; `GET /tasks?originKind=bogus` is rejected with 400.
- [ ] A contract test asserts the write validator and the filter validator read the same list.
- [ ] Tasks written by `/plan-session` carry `originKind: document` and the plan document id.
- [ ] Each task-filing skill's command text sets `originKind` (content tests).

**Technical Considerations**: The status filter has drifted from the values rows can hold
before; the single shared list plus contract test exists to prevent a repeat.

**Source Map**:
- `task-store/src/openapi-schemas.ts`, `task-store/src/task-service.ts`
- `task-store/src/system-cron-service.ts` — cron-filed tasks
- `plugins/shipwright/skills/*-fix/SKILL.md`, `plugins/shipwright/commands/*-fix.md` — task-filing skills

**Testing Strategy**: Layer: integration — validation and filtering; content tests for skill text.

---

### Feature 5: `/shipwright:prd` — numbered specs, repos, always committed

**Priority**: High
**Description**: `/prd` writes the session's next numbered spec, records the repos it covers
and its owner, registers it, and opens a docs PR.

**User Stories**:
- As a requester, I want to add a second spec to a running session without inventing a file
  name or losing the first.

**Requirements**:
- Form: `/shipwright:prd {session} [--repos a,b] [--owner email] [--initiative id]`.
- New specs are `planning/{session}/SPEC-{NNNN}.md`. A legacy `PRODUCT-SPEC.md` is spec 1 and
  keeps its name; the next spec in that session is `SPEC-0002.md`.
- The home repo is the repo the command runs in. If the session already has a different home
  repo, stop and say where its documents live.
- Each new file starts with a header line giving session, repos and spec number. No owner.
- The spec template gains a required `Repos` line and a repo per Source Map entry.
- After approval: write the file, register the document, open a docs PR (reusing an open
  `docs/plan-{session}` PR, else `docs/plan-{session}-{n}`), record `prUrl` and state.
- What a session already has is decided by document rows; file content is read from git
  (open docs branch, then default branch, then local). A session with planning files in git
  but no rows is registered lazily first.
- `--initiative` keeps its close-out behaviour and also sets the initiative's
  `specDocumentId`.
- Handoff line becomes `NEXT: /plan-session {session}`.
- If the store lacks the document endpoints, warn once and continue with today's behaviour.

**Acceptance Criteria**:
- [ ] The command text specifies the next-number rule including the legacy `PRODUCT-SPEC.md` case (content test).
- [ ] The command text specifies the read order for existing content and the lazy-registration step (content test).
- [ ] The docs PR block reuses an open PR and opens a suffixed branch when the previous PR has merged; the existing secret-pattern scrub gate still runs (behaviour test on the shell block).
- [ ] The methodology contract `prd.md` lists `specPath`, `specNumber`, `repos`, `owner` as inputs and the `Repos` line as a required section; its content test is updated.
- [ ] The spec template content test asserts the `Repos` line.

**Technical Considerations**: `planning/` is commonly gitignored; keep `git add -f` on the
specific files and never edit a repo's `.gitignore`.

**Source Map**:
- `plugins/shipwright/commands/prd.md`, `plugins/shipwright/commands/prd.content.test.ts`
- `plugins/shipwright/references/product-spec-template.md`
- `plugins/shipwright/references/methodology-contracts/prd.md` and its content test

**Testing Strategy**: Layer: content — command and contract markdown; behaviour test for the docs PR shell block.

---

### Feature 6: `/shipwright:plan-session` — add to a session, multi-repo, one locked plan

**Priority**: High
**Description**: `/plan-session` plans a session's unplanned specs across their target
repos, appends a pass to the session's single `PLAN.md` under a lock, and links every task
to its plan and spec.

**User Stories**:
- As a requester, I want a second planning pass to add to my session without overwriting the
  first plan.
- As a requester, I want one plan to queue tasks in several repos.

**Requirements**:
- New form: `/shipwright:plan-session {session} [--repos a,b] [--owner email] [--initiative id]`.
  The two-argument form `{repo} {session}` (used by the autonomous dispatcher) keeps working:
  for a new session that repo is home and sole target; for an existing session the stored
  home repo wins and the named repo is added as a target.
- Plans the session's unplanned specs. With none and a human present, asks what to add.
- Target repos are the union of the specs' repos and `--repos`. Each is explored from its
  checkout under `SHIPWRIGHT_REPO_DIR`; a missing checkout stops the run naming the repo.
- The scope preflight runs before anything is written and stops with uncovered repos named.
  It is a credential check, not a permission model.
- Every task's `repo` must be one of the session's target repos (replaces "equals the
  argument" in the built-in path and the dispatch schema check).
- Best-effort warning when no agent has a target repo in scope. Never blocks.
- A planning pass takes a short-lived, self-expiring lock on the session before reading the
  plan and releases it after tasks are written and the plan is pushed. A second pass that
  finds the lock held stops and reports the holder and time.
- The session keeps one `PLAN.md`. The first pass writes it as today. Later passes append a
  section headed with pass number, date and the specs planned, and never rewrite earlier
  sections. A legacy `PLAN.md` is plan 1.
- Adding to a session keeps the existing task prefix and continues the milestone number.
- Tasks get `source` (unchanged), `planDocumentId`, `specDocumentId`, `owner`, `originKind`,
  `originRef`. Planned specs get `plannedAt`. The session's declared repos are widened.
- Autonomous path: dispatcher and `check-plan.ts` unchanged. A spec materialised from a `prd`
  task is written as the session's next spec and registered with the origin task id. An
  uncovered target repo is a hard contradiction that blocks the task with a named reason.
- `--initiative` keeps its close-out and also sets `planDocumentId` on the initiative, even
  when `/prd` already closed it.
- The methodology contract `plan-session.md`: `specContent` becomes `specs[]`, `repo` becomes
  `homeRepo` plus `repos[]`, each returned task carries `specNumber`, and `planMarkdown` is
  this pass only (the command appends).
- If the store lacks the document endpoints, warn once and continue with today's behaviour.

**Acceptance Criteria**:
- [ ] Lock: a second acquire on a held session lock is refused with the holder and timestamp; an expired lock can be re-acquired (integration test with injected clock).
- [ ] The command text specifies append-only passes and forbids rewriting earlier sections (content test).
- [ ] The command text specifies the two-argument form's behaviour for new and existing sessions (content test).
- [ ] The dispatch schema check accepts a task whose repo is in the target list and rejects one outside it (content test on the validation rules).
- [ ] The command text runs the scope preflight before Step 6a writes anything (content test).
- [ ] The docs PR block commits an updated `PLAN.md` on a second pass instead of skipping (behaviour test).
- [ ] The methodology contract and its content test reflect `specs[]`, `homeRepo`, `repos[]`, `specNumber`.
- [ ] Existing content tests for `--autonomous` and `--initiative` still pass unchanged in intent.

**Technical Considerations**: The lock lives in the task store (a nullable holder and expiry
on the session, with acquire and release endpoints). On the default branch 108 of 119
committed plans have a single commit, so contention is expected to be rare.

**Source Map**:
- `plugins/shipwright/commands/plan-session.md`, `plan-session.content.test.ts`, `plan-sesh.md`
- `plugins/shipwright/references/methodology-contracts/plan-session.md` and its content test
- `task-store/src/session-service.ts`, `task-store/src/routes/sessions.ts` — lock
- `agent/src/coding/check-plan.ts`, `agent/src/coding/loop-orchestrator.ts` — read-only reference; must not need changes
- `docs/task-store.md` — initiative close-out wording

**Testing Strategy**: Layer: content — command and contract markdown; integration for the lock; behaviour test for the docs PR block.

---

### Feature 7: Admin UI — documents, owner, "mine" by default

**Priority**: Medium
**Description**: The Sessions and Tasks pages show owners and planning documents and open on
the signed-in user's own work.

**User Stories**:
- As an engineer in a large install, I want my sessions first so that I am not scanning
  hundreds of rows.

**Requirements**:
- Session detail: a Documents block listing each spec and the plan with kind, number, owner,
  state, planned flag and a link (GitHub file URL from home repo and path, or the docs PR
  while unmerged). Owner and repos in the header.
- Sessions list: owner column and filter, and a compact documents cell (spec count, and a
  marker when any document is `draft`, `pr_open` or `abandoned`).
- Tasks pages: owner column and filter; `source` rendered as a link when the task has a
  linked document; origin shown; owner field on the quick-add form.
- A Mine / All switch on Sessions and Tasks, defaulting to Mine when the signed-in user owns
  anything, else All. The choice is kept in the URL.
- Rendering a session never calls GitHub.

**Acceptance Criteria**:
- [ ] Session detail renders a Documents block with a working link per document for a merged and an unmerged document (smoke test).
- [ ] Sessions list with `?owner=` shows only that owner's sessions; with no parameter and a user who owns sessions, the Mine view is selected (smoke test).
- [ ] A task with a linked plan document renders `source` as an anchor; one without renders plain text as today (smoke test).
- [ ] A session with no documents renders without a Documents block and without error.
- [ ] Browser-testable changes are verified locally with the repo's headless Chromium helper.

**Technical Considerations**: Reuse the existing table, filter-bar and badge patterns in the
work-item pages.

**Source Map**:
- `admin/src/coding/admin-ui-sessions-list.ts`, `admin-ui-session-detail` route and tests
- `admin/src/coding/admin-ui-work-item-pages.ts`
- `admin/src/coding/task-store-types.ts` — regenerated
- `docs/agent-web-ui.md`

**Testing Strategy**: Layer: smoke — server-rendered routes via in-process `app.request()`.

---

### Feature 8: Register existing sessions

**Priority**: Medium
**Description**: A re-runnable script registers the planning files that already exist so old
sessions show their documents and links.

**User Stories**:
- As an operator, I want existing sessions to gain document links without anyone editing
  old files or tasks.

**Requirements**:
- Walks `planning/*/` in a checkout. Registers each `PLAN.md` as plan 1 and each
  `PRODUCT-SPEC.md` as spec 1 (marked planned when a plan exists), sets the session's home
  repo, and links existing tasks to their plan by matching `source`.
- Idempotent: a second run changes nothing. Adds records; never edits a task's other fields.
  Owner is left empty.
- Non-standard files are reported and left alone.
- Has a dry-run mode that prints what it would do.

**Acceptance Criteria**:
- [ ] Run twice against a fixture tree: the second run reports zero creates and zero updates.
- [ ] A fixture task with `source: planning/x/PLAN.md` gains `planDocumentId` and has no other field changed.
- [ ] A non-standard file in a session folder appears in the report and produces no row.
- [ ] Dry-run writes nothing (integration test asserts no rows).

**Technical Considerations**: The commands' lazy registration uses the same rules, so
implement the rules once and call them from both places.

**Source Map**:
- `scripts/` — new script, wired into `Taskfile.yml`
- `docs/task-store.md` — operator instructions

**Testing Strategy**: Layer: integration — real database with a fixture planning tree.

---

## Technical Constraints

- Public repository: no personal names, client names, internal hostnames or org-specific
  identifiers in code, fixtures, docs, task text or planning files.
- The plugin stays repo-agnostic; assume nothing beyond the `planning/{session}/` convention.
- Schema changes are additive: nullable columns and one new table. No renames or removals.
- The autonomous dispatch form `/shipwright:plan-session {repo} {session} --autonomous {task-id}`
  must keep working unchanged; `check-plan.ts` and `loop-orchestrator.ts` must not need edits.
- Existing `PLAN.md`, `PRODUCT-SPEC.md` and task `source` values keep working. No existing
  planning file is renamed or moved.
- Document registration, linking and the docs PR are additive: a planning run must never
  fail because one of them failed.
- Commands must tolerate a task store that predates this work.
- Tests land with the code at the layer named per feature. No `mock.module()`, no global
  overrides; inject time via a `Clock`; use recorded fixtures for GitHub.

## Scope

**In Scope**:
- Rejecting unknown query parameters on the three list endpoints.
- Planning document records with state and a nightly reconciler.
- Owner (optional email) and typed origin.
- Session home repo, declared repos and a planning lock.
- `/prd` and `/plan-session` changes, both subagent contracts and the spec template.
- Admin UI documents block, owner columns and filters, Mine / All switch.
- A re-runnable registration script for existing sessions.

**Out of Scope**:
- Owner-driven behaviour: notification routing, auto-follow, approval rights, permissions.
- A single task that changes two repos.
- A dedicated planning repo per install, or copies of documents in every target repo.
- One plan file per pass.
- Server-allocated session or task ids, cursor pagination, stable user ids, team or group
  ownership. These are tracked separately as initiative SWI-7.
- Backfilling `originKind` on existing tasks.
- Changing how `dev-task`, `review`, `patch` or `merge` select or execute work.

## Priorities & Sequence

1. Feature 1 ships alone, first.
2. Feature 2, with the owner and origin columns from Features 3 and 4 and the lock from
   Feature 6, as the task-store foundation. Additive and safe to deploy alone.
3. Feature 5 (`/prd`).
4. Feature 6 (`/plan-session`), with the task-filing skills from Feature 4.
5. Feature 7 (admin UI).
6. Feature 8 (registration script). Running it against a live install is a human step.

Features 5 to 8 depend on the task-store work in step 2 being deployed.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| 1. Reject unknown query parameters | smoke | HTTP route contract |
| 2. Planning document records | integration + smoke | real database behaviour; route contracts; reconciler with injected clock and recorded GitHub fixture |
| 3. Owner | integration + content | filters and inheritance; command text |
| 4. Typed origin | integration + content | shared validation list; skill text |
| 5. `/prd` | content + behaviour | command, template and contract markdown; docs PR shell block |
| 6. `/plan-session` | content + integration + behaviour | command and contract markdown; session lock; docs PR shell block |
| 7. Admin UI | smoke | server-rendered routes in process |
| 8. Register existing sessions | integration | real database with a fixture tree |

## Resolved Decisions

- **Where document facts live**: a table in the task store. — Rationale: unvalidated JSON or file headers repeat the looseness that produced wrong `source` values, and the autonomous path starts from a task, not a file.
- **Owner identity**: the requester's email, optional. — Rationale: the store has no human identity; `assignee` and `claimedBy` identify agents; the admin side already uses email.
- **Owner in files**: never written into committed files. — Rationale: it would put an email in permanent history for every install, including public repos.
- **Plan file**: one `PLAN.md` per session with a lock. — Rationale: 108 of 119 committed plans have one commit; a file per pass solves a collision that is rare, and the lock handles it.
- **Standard place**: `planning/{session}/` in the session's home repo. — Rationale: matches the existing layout and needs no setup for a single-repo install.
- **Legacy files**: `PRODUCT-SPEC.md` is spec 1 and `PLAN.md` is plan 1; nothing is renamed. — Rationale: existing links must keep working.
- **Source of truth**: the store decides what a session contains; content is read from git. — Rationale: `planning/` is gitignored and a later pass may run on another machine.
- **Docs PRs**: no auto-merge. — Rationale: 134 of 139 planning PRs merged, median 1.3 hours; the reconciler covers the rare abandoned one.
- **Registration of existing sessions**: re-runnable script, with lazy registration as the safety net. — Rationale: the script must be idempotent because new sessions keep arriving before it runs.
- **Missing owner in autonomous runs**: proceed with none and log it. — Rationale: blocking would break existing PRD submitters that send no owner.
- **Unstaffed repo warning**: best-effort, never blocks. — Rationale: it needs the admin API, which a planning run may not reach.
- **Scale items**: server-allocated ids, cursor pagination, user ids and teams are deferred to SWI-7. — Rationale: each touches every caller of the task store and none of this work depends on them.

## Success Criteria

- A requester can run `/prd` twice and `/plan-session` twice on one session and end with two
  numbered specs, one `PLAN.md` holding two passes, both committed, and every task linked to
  its plan and spec.
- One planning pass can queue tasks in more than one repo, and stops before writing anything
  when its token cannot write to one of them.
- A signed-in user opens the Sessions page and sees their own sessions first, each with its
  documents and their state.
- A filter on an unknown parameter returns an error, not the whole store.
- Every session and task that existed before still opens, and every existing `source` value
  still resolves.
- `task ci` passes.

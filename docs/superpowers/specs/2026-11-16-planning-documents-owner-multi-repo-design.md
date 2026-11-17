# Planning upgrade: owners, documents, multi-repo sessions, adding to a session

Date: 2026-11-16 · Status: draft for approval · Fulfils initiative `SWI-1`

## Intent

Planning in Shipwright produces two markdown documents (a product spec from `/shipwright:prd`,
a plan from `/shipwright:plan-session`) and a queue of tasks. Today the link between the
person who asked, the documents, the session and the tasks is a free-text line and one
path string. That has already gone wrong in practice:

- "Requested by …" is prose in a plan header or an initiative description. Nothing can
  filter or act on it.
- `/prd` commits nothing. Of 119 committed sessions in this repo, 118 have a `PLAN.md` and
  only 14 have a spec.
- Re-running `/plan-session` on an existing session overwrites `PLAN.md`, and the plan PR
  step then skips because a PR for the branch already exists, so the new plan is never
  committed.
- A session is locked to one repo in three places, although tasks are per-repo and task ids
  are global.
- Task `source` is one unvalidated string. Four pending initiatives currently point at a
  plan that has nothing to do with them.
- One session already holds a hand-named second spec (`PRODUCT-SPEC-deploying-pass.md`)
  with no plan beside it.

The `initiative-kind` plan deferred exactly this: "owner/multi-repo/linked-markdown stay in
the description body (follow-up)".

## Goals

1. **Owner.** Every initiative, spec, plan, session and task can carry an owner. The owner is
   the person who requested the work. It is a real field, inherited down the chain
   initiative → spec → plan → session → tasks, and visible and filterable in the admin UI.
2. **Documents are records.** Each spec and plan is a row in the task store. Every session
   links to all of its documents. Every task links to the plan and the spec that produced it.
   All of this is optional: a session or task with no documents stays valid.
3. **Always committed, standard place.** Both commands commit their output to
   `planning/{session}/` in the session's home repo, through a docs PR.
4. **Add to an existing session.** A session can receive more specs and more planning passes
   without losing anything.
5. **Multiple repos.** A single spec or planning pass can cover changes in several repos.
6. **Nothing existing breaks.** Old `PLAN.md` and `PRODUCT-SPEC.md` files, existing task
   `source` values, and the current command forms keep working.

## Non-goals

- Owner-driven behaviour: notification routing, auto-follow, approval rights, permissions.
  The data is shaped so these can follow; none is built here.
- A single task that changes two repos. A task still targets exactly one repo.
- A dedicated planning repo per install, or copies of documents in every target repo.
- One plan file per spec. A session has one `PLAN.md`.
- Renaming or moving any existing planning file.
- Changing how `dev-task`, `review`, `patch` or `merge` select or execute work.
- **Deferred to a second initiative ("task store at scale"):** server-allocated session and
  task ids, cursor pagination with stated coverage on every list endpoint, stable user ids,
  and team or group ownership. Each is a real need at hundreds of engineers, each touches
  every caller of the task store, and none of the goals above depends on it. Session slugs
  and task prefixes stay hand-picked here, with the existing collision checks.

## Anti-goals

- A planning run that fails because document bookkeeping failed. Registration, linking and
  the docs PR are additive; the spec on disk and the tasks in the queue come first.
- Owner or document links that are required. Cron-filed tasks, verbal plans and the existing
  `submit-prd` style gateways must keep working with neither.
- The admin UI depending on GitHub calls to render a session.

## Constraints

- **Public repo.** No personal names, client names or internal hostnames in code, fixtures,
  docs or planning files.
- **Plugin stays repo-agnostic.** Nothing may assume this repo's layout beyond the
  `planning/{session}/` convention the commands already use.
- **`planning/` is commonly gitignored** (it is here). Commands keep staging the specific
  files with `git add -f`; they never edit a repo's `.gitignore`.
- **Autonomous dispatch form is fixed for now.** `loop-orchestrator.ts` dispatches
  `/shipwright:plan-session {repo} {session} --autonomous {task-id}`. That form must keep
  working unchanged.
- **Additive schema only.** New nullable columns and one new table. No renames, removals or
  constraints on existing rows.
- **Subagent contracts and content tests move with the commands.**
  `references/methodology-contracts/prd.md` and `plan-session.md` hardcode one repo and the
  two fixed file paths.
- Test conventions in `CLAUDE.md` apply: tests land with the code, at the right layer.

## Approaches

Three were considered. They differ in where the facts about a document live.

| | A. Documents table | B. Extra fields only | C. Markdown is the record |
|---|---|---|---|
| Document facts | New task-store table, one row per document | JSON list on the session, `spec` path on the task | Header block in each file |
| "Which specs are unplanned?" | One query | Interpret unvalidated JSON | Read files from GitHub |
| Admin shows documents | From the store | From the JSON | Only via GitHub |
| Visible before the PR merges | Yes | Yes | No |
| Autonomous PRDs (spec starts as a task) | Fits | Fits loosely | Does not fit |
| Task-store work | Most | Moderate | Least |

**Chosen: A**, with one idea from C: each committed file also carries a short header (session,
repos, spec number; never the owner) so it reads sensibly on GitHub. The table is the source of truth; the header
is a copy. B was rejected because unvalidated JSON repeats the looseness that produced the
wrong `source` values. C was rejected because it breaks the autonomous path and makes the
admin UI depend on GitHub.

## Design

### Data model (task store)

New table `PlanDocument`:

| Field | Notes |
|---|---|
| `id` | cuid |
| `accountId` | tenant scope, same pattern as `Task` and `Session` |
| `session` | session slug |
| `kind` | `spec` \| `plan` |
| `number` | specs: 1, 2, 3… within the session. Plans: always 1 |
| `repo` | home repo, `org/repo` |
| `path` | repo-relative path, e.g. `planning/{session}/SPEC-0002.md` |
| `title` | optional, first heading of the file |
| `owner` | nullable email |
| `repos` | target repos this document covers, `org/repo[]` |
| `prUrl` | docs PR that carries the file, nullable |
| `state` | `draft` \| `pr_open` \| `merged` \| `abandoned` |
| `commitSha` | the commit the file was last read or written at, nullable |
| `plannedAt` | specs only: set when a planning pass has consumed the spec |
| `originTaskId` | nullable: the `prd` or `initiative` task this document came from |
| `createdAt` / `updatedAt` | |

Unique on `[accountId, session, kind, number]`.

`Session` gains: `owner` (nullable email), `homeRepo` (nullable `org/repo`), `repos`
(`org/repo[]`, the declared target repos).

`Task` gains: `owner` (nullable email), `planDocumentId` and `specDocumentId` (nullable
references to `PlanDocument`). `source` is kept and still written exactly as today.

Session rows are created today as a side effect of writing a task. Registering a document
must also ensure the session row exists, because `/prd` runs before any task does.

**Naming: session repos.** Session responses already return a `repos` list derived from the
session's tasks, and the `repo` and `org` filters use it. That field keeps its name and its
filters, and its value becomes the union of task repos and declared repos. The new stored
column is `declaredRepos`.

### Document state and reconciliation

A document is registered before its PR merges, so its row needs to say where it stands.

- `draft`: registered, no PR yet. `pr_open`: a docs PR carries it. `merged`: the file is on
  the home repo's default branch. `abandoned`: its PR closed without merging and the file is
  not on the default branch.
- The commands set `draft` and `pr_open` as they go.
- A nightly reconciler in the task store's existing sweeper pattern checks every `draft` and
  `pr_open` document against GitHub and moves it to `merged` or `abandoned`. It only ever
  changes `state`, `prUrl` and `commitSha`. Where no GitHub credential is configured it does
  nothing and says so once.
- The measured base rate is low: of 139 planning PRs in this repo, 134 merged and none
  closed unmerged, with a median of 1.3 hours to merge. The reconciler is a safety net, not
  a hot path, and docs PRs do not need an auto-merge route.
- An `abandoned` spec is not offered to `/plan-session` as unplanned work.

### Source of truth

- **What a session has** (which specs, whether a plan exists, what is planned) is decided by
  document rows in the store, never by which files happen to be on the local disk.
- **File content** is read from git, in this order: the open docs branch for the session if
  there is one, else the home repo's default branch, else the local working copy. A later
  pass appends to that version, inside the docs worktree, so a stale or missing local
  `planning/` folder cannot drop an earlier pass.
- **Lazy registration.** When either command touches a session that has planning files in
  git but no document rows (a legacy session before the registration script has run), it
  registers those files first, using the same rules as the script, then carries on.

### API (task store)

- `POST /documents` registers a document. Idempotent on the unique key: re-registering
  updates `prUrl`, `title`, `owner`, `repos`.
- `GET /documents?session=&kind=&owner=&planned=` lists. `planned=false` returns specs with
  no `plannedAt`.
- `PATCH /documents/:id` sets `plannedAt`, `prUrl`, `owner`.
- `GET /sessions/:slug` and the session list include `owner`, `homeRepo`, `repos` and the
  session's documents. `PATCH /sessions/:slug` accepts `owner`, `homeRepo`, `repos`.
- Tasks accept `owner`, `planDocumentId`, `specDocumentId` on create, bulk create and PATCH,
  and `GET /tasks` filters on `owner`.
- **Scoped tokens, reads.** Today a scoped token cannot see a session with no tasks, which
  would hide a spec that `/prd` just registered. So a scoped token sees a document, and the
  session it belongs to, when the document's home repo or any of its target repos is in the
  token's scope, in addition to the existing task-based rule.
- **Scoped tokens, writes.** Registering a document requires its home repo in scope. Task
  writes keep today's rule: every task's repo must be in scope or the whole batch is
  rejected. Multi-repo planning therefore needs a token that covers every target repo.
- **Scope preflight.** A new read-only endpoint reports which of a given list of repos the
  calling token may write to. `/plan-session` calls it before writing anything and stops
  with the uncovered repos named, instead of discovering the problem from a rejected batch
  after the plan is on disk.
- OpenAPI, generated types and the generated MCP tool docs are regenerated.
- **Unknown query parameters are rejected.** Today the list endpoints silently ignore a
  parameter they do not recognise: `GET /tasks?bogus=1` returns 200 and the full list. Once
  `owner` is a filter, a caller asking an older store for "my tasks" would get everyone's
  and could act on them. `GET /tasks`, `GET /sessions` and `GET /documents` return 400
  naming the unknown parameter. This is the one deliberate behaviour change to existing
  endpoints; callers in this repo (plugin commands and skills, agent, admin, metrics, MCP
  server) are audited for stray parameters in the same change, and it is called out in
  `docs/migration.md`.
- The commands treat that 400 on `owner` or `originKind` as "this store predates the
  feature" and fall back as described under Rollout order.

### Owner

- **Format:** an email address, matching how the admin side already identifies people.
- **Interactive default:** `git config user.email`, shown in the command's opening summary so
  it can be corrected. `--owner {email}` overrides.
- **Inheritance:** with `--initiative {id}`, the initiative's owner is used when set. A plan
  inherits the owner of the spec it plans. A session's owner is set from its first document
  and is not overwritten by later ones. Tasks inherit the owner of the plan that created
  them.
- **Autonomous:** the originating `prd` task's `owner` is used. If it has none, owner is left
  empty and a line is logged in the Decision Log. It never blocks.
- **Initiatives and ideas:** the admin quick-add form sets owner to the signed-in user's
  email, editable.
- **Optional by design.** Owner is always nullable. Tasks filed by a scanner or a cron have
  no requester and so have no owner; nothing invents one for them.
- **Why email and not a user id.** The task store has no notion of a human. The existing
  `assignee` and `claimedBy` values identify agents (seven distinct values in the live
  store, each an agent id), and the admin side identifies people by email throughout. A
  stable user id and team ownership would need a user directory first; both are listed as
  follow-up work, not built here.

### Typed origin

Roughly a fifth of tasks are not produced by a plan at all, and `source` today holds nine
different shapes of value (plan paths, skill names, `gh:` references, free text, null).
Owner cannot explain where those tasks came from, so provenance gets its own field.

- `Task` gains `originKind` and `originRef`, both nullable.
- `originKind` comes from one registered list: `document`, `skill`, `cron`, `human`. The
  same list validates writes and filters, so a value a row can hold is always a value the
  filter accepts. Adding a kind is a one-place change with a contract test.
- `originRef` identifies the thing: a document id for `document`, the skill or cron name
  for `skill` and `cron`, empty for `human`.
- `/plan-session` writes `originKind: document` with the plan's document id. The scan-and-
  fix skills and system crons that file tasks write their own kind and name.
- `source` keeps being written exactly as today for existing readers. It is not migrated
  or reinterpreted; a backfill of `originKind` for existing rows is left as follow-up.

### File layout and naming

```
planning/{session}/
  SPEC-0001.md     first spec
  PLAN.md          the session's one plan
  SPEC-0002.md     a later spec added to the same session
```

- New specs are `SPEC-{NNNN}.md`, four digits, numbered per session.
- **Legacy rule:** an existing `PRODUCT-SPEC.md` is the session's spec number 1 and keeps its
  name. The next spec added to that session is `SPEC-0002.md`. Any reader that looks for a
  session's first spec checks `SPEC-0001.md`, then `PRODUCT-SPEC.md`.
- Each new file starts with a short header:

  ```
  > Session: {session} · Repos: {org/a}, {org/b} · Spec: SPEC-0002
  ```

  **The owner is never written into a committed file.** It would put a person's email into
  permanent git history for every install, including public repos. Owner lives in the task
  store only and is shown in the admin UI.

- The spec template gains a required `Repos` line in its Overview and, per feature, the repo
  each Source Map entry belongs to.

### `/shipwright:prd`

- Form: `/shipwright:prd {session} [--repos a,b] [--owner email] [--initiative id]`.
- The home repo is the repo the command runs in. If the session already exists with a
  different home repo, stop and say where its documents live.
- Target repos default to the home repo. `--repos` or the interview can widen the list.
- On an existing session it picks the next spec number and says so up front
  ("This session has SPEC-0001; writing SPEC-0002").
- After approval it writes the file, registers the document, and opens a docs PR.
- The handoff line becomes `NEXT: /plan-session {session}`.

### `/shipwright:plan-session`

- New form: `/shipwright:plan-session {session} [--repos a,b] [--owner email]
  [--initiative id]`. The existing two-argument form `{repo} {session}` still works, which
  is what the autonomous dispatcher sends. For a new session, that repo becomes the home
  repo and the only target. For a session that already has a home repo, the stored home
  repo wins for where documents and the docs PR go, and the named repo is added as a target.
- **What it plans:** the session's unplanned specs (`planned=false`). If there are none and a
  human is present, it asks what to add, as today's no-spec path does.
- **Multi-repo:** target repos are the union of the specs' `repos` and `--repos`. Each is
  explored from its checkout under `SHIPWRIGHT_REPO_DIR`. A missing checkout stops the run
  with the repo named. Every task's `repo` must be one of the session's target repos; this
  replaces the "equals the argument" rule in the built-in path and in the dispatch schema
  check.
- **Unstaffed repo warning:** best-effort. If the admin API is reachable and no agent has a
  target repo in scope, print a warning. Never blocks.
- **Adding to a session:** task ids keep the session's existing prefix and continue the
  milestone number (a session ending at `ABC-2.4` continues at `ABC-3.1`). New tasks may
  depend on existing ones.
- **`PLAN.md` grows.** The first pass writes the file as today. Each later pass appends a
  section and never rewrites earlier ones:

  ```
  ---
  ## Pass 2 · 2026-11-20 · SPEC-0002
  {design, task table, dependency map, breaking-change notes, decision log for this pass}
  ```

- **One plan, with a lock.** The session keeps a single `PLAN.md`. A planning pass takes a
  short-lived lock on the session in the task store before it reads the plan and releases it
  after the tasks are written and the plan is pushed, so two passes cannot append at once. A
  second pass that finds the lock held stops and says who holds it and since when. The lock
  expires on its own so a crashed pass cannot wedge a session. A file per pass was
  considered and rejected: on the default branch 108 of 119 committed plans have a single
  commit and none has more than five, so replanning is rare and the single file keeps
  existing links simple.
- **Writes:** tasks get `source` (unchanged), `planDocumentId`, `specDocumentId`, `owner`.
  When one pass plans several specs, each task links to the spec it came from. The plan
  document is registered once and updated on later passes. Planned specs get `plannedAt`.
  The session's `repos` is widened.

### Docs PR

Both commands commit through a PR, because most repos protect their default branch.

- Branch `docs/plan-{session}`. If a PR for that branch is still open, push the new or
  changed files to it. If it has merged or closed, open a new PR from
  `docs/plan-{session}-{n}`.
- The existing secret-pattern scrub gate runs on every commit.
- The document's `prUrl` is recorded. A document is visible in the admin UI as soon as it is
  registered, linking to the PR until the file is on the default branch.
- Failure here prints a warning and continues, as today.

### Autonomous path

- The dispatcher and `check-plan.ts` are unchanged.
- When plan-session materialises a spec from a `prd` task's description, it writes it as the
  session's next spec file, registers it with `originTaskId`, and takes owner from the task.
- Target repos are the dispatched repo plus any on the spec's `Repos` line. The scope
  preflight runs before anything is written. A target repo the token cannot write to is a
  hard contradiction: block the task with a named reason; do not write a partial plan.
- When the docs home repo is not checked out in the agent's workspace, the docs PR step is
  skipped with a warning, as it is today when there is no git checkout.

### Subagent contracts

- `methodology-contracts/prd.md`: inputs gain `specPath`, `specNumber`, `repos`, `owner`; the
  required sections gain the `Repos` line.
- `methodology-contracts/plan-session.md`: `specContent` becomes `specs[]` (`number`, `path`,
  `content`); `repo` becomes `homeRepo` plus `repos[]`; each returned task carries
  `specNumber`; `planMarkdown` is the content for this pass only, and the command does the
  append.

### Initiative close-out

`--initiative` keeps its current status behaviour: `/prd` closes the initiative when the
spec is finalized, `/plan-session` closes it when tasks are queued, and both still write
`source` as they do today.

In addition, each command sets its own document link on the initiative (`specDocumentId`
from `/prd`, `planDocumentId` from `/plan-session`). Linking is separate from closing: when
`/plan-session --initiative` finds the initiative already closed by `/prd`, it skips the
status change as today but still sets `planDocumentId`. The document links, not `source`,
are the reliable record of what fulfilled an initiative.

### Admin UI

- **Session detail:** a Documents block listing each spec and the plan with kind, number,
  owner, planned state and a link (GitHub file URL built from home repo and path, or the
  docs PR while unmerged). Owner and repos shown in the header.
- **"Mine" by default.** With hundreds of sessions, the useful first screen is your own. The
  Sessions and Tasks pages get a Mine / All switch, defaulting to Mine (owner equals the
  signed-in user's email) when that user owns anything, else All. The choice is kept in the
  URL so a view can be shared or bookmarked.
- **Sessions list:** owner column and owner filter, and a compact documents cell showing how
  many specs and whether any document is still `draft`, `pr_open` or `abandoned`.
- **Tasks pages:** owner column and filter; `source` rendered as a link when the task has a
  linked document; quick-add form gets an owner field.

### Existing data

- A one-time, idempotent registration script walks `planning/*/` in a checkout and registers
  each `PLAN.md` (plan 1) and `PRODUCT-SPEC.md` (spec 1, marked planned when a plan exists),
  sets `homeRepo` on the session, and links existing tasks to their plan by matching
  `source`. It adds records and never edits a task's other fields. Owner stays empty.
- Non-standard files (`PRODUCT-SPEC-deploying-pass.md`, audits, logs) are reported and left
  alone.

## Rollout order

1. Task store: reject unknown query parameters, with the caller audit. Ships alone, first.
2. Task store: schema (documents with state, owner, origin, session fields, the planning
   lock), endpoints, the reconciler, generated types and docs. Additive; safe alone.
3. Plugin: `/prd` (numbered specs, owner, repos, register, docs PR).
4. Plugin: `/plan-session` (unplanned specs, multi-repo, lock and append, links, origin) and
   both contracts. Task-filing skills and crons write their origin.
5. Admin UI, including the Mine / All switch.
6. Registration script, re-runnable, run by an operator.

Commands must tolerate a task store that does not yet have the document endpoints (older
deploy): warn once, skip registration and linking, and continue with today's behaviour.

## Decisions made without the requester (check these)

- Owner is an email; default is the git email; autonomous runs never block on a missing
  owner.
- `planning/` stays gitignored where it is; commands keep force-adding their own files.
- Legacy `PRODUCT-SPEC.md` counts as spec 1 and is never renamed.
- `/prd` opens the docs PR itself; later commits reuse it while it is open.
- Adding to a session continues the milestone number under the same prefix.
- An out-of-scope target repo in autonomous mode blocks the task.
- The unstaffed-repo warning is best-effort and never blocks.
- Existing sessions are registered by an operator-run script, not a migration, with lazy
  registration covering any session touched before the script runs.
- The store decides what a session has; file content is read from git, docs branch first.
- A scoped token sees a document through its repos, and a scope preflight runs before any
  multi-repo write.
- The session `repos` field keeps its name and becomes task repos plus declared repos.
- `/prd --initiative` still closes the initiative; a later `/plan-session --initiative`
  still links its plan to it.
- For an existing session, the stored home repo wins over the repo named on the command.
## Review record

The draft was reviewed by a four-agent council on 2026-11-16 and judged blind. Confirmed by
the requester afterwards:

- **Adopted:** rejecting unknown query parameters, a state per document with a nightly
  reconciler, a re-runnable backfill, a "mine" default view, an optional owner, a typed
  origin, and treating the scope preflight as a credential check, not a permission model.
- **Kept against the review:** owner as an email (the store has no human identity to point
  an id at), and one `PLAN.md` per session with a lock (replanning is rare in the measured
  history).
- **Deferred:** the items listed under Non-goals as the second initiative.
- **Not supported by the evidence:** the claim that lazy session registration has already
  failed. The sessions list omits closed and archived sessions by default, which accounts
  for the low count that was cited. Lazy registration stays as the safety net behind the
  backfill.

Figures used above, from the live store on 2026-11-16 with an unrestricted token: 4,068
tasks, 747 sessions, 96 sessions with tasks in more than one repo.

## Left to the builder

- Exact Prisma types and index choices; route file layout; zod schema names.
- Whether `planDocumentId` / `specDocumentId` are enforced foreign keys or plain strings.
- How the task prefix and last milestone number are derived for an existing session.
- Default-branch detection for file links, and when a link flips from PR to file.
- Wording of command output, and the split of content tests versus unit tests.
- Task breakdown and sequencing within each rollout step.

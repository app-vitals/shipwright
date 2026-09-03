# Plan: research-docs-quality

## Background

Three quality gaps were identified against `/research-docs`'s current behavior:

1. Step 3's gap analysis (`plugins/shipwright/commands/research-docs.md`) is purely
   structural — it scans for module/service directories, routes, and schema files. It has
   no equivalent for concern-based domains that cut across modules and are easy to
   structurally miss (authz, secrets rotation, error-handling conventions, sensitive-data
   handling, logging/tracing wiring, business-domain state, third-party service
   dependencies).
2. Generated/updated docs have no check against reproducing content that already has a
   canonical source elsewhere (a route table duplicating an API spec, a migrations list
   duplicating the migrations directory), and no check that a concrete literal value
   (schedule expression, pool size, timeout, count) matches its own prose paraphrase
   elsewhere in the same doc, and no check that a stated "convention" names a concrete
   mechanism rather than just asserting a rule.
3. Generated docs have no size target and can grow unbounded, working against the goal of
   a doc being fully read when consulted.

All three were scoped, in discussion, to also cover Auto Mode (`--auto`, Steps A1-A9) —
this is the mode `test-readiness` normally runs in, and today none of the three checks
exist there at all.

## Design

No new files — both `plugins/shipwright/commands/research-docs.md` and its content-test
suite `plugins/shipwright/commands/research-docs.unit.test.ts` are the only files touched
across all three tasks.

**Auto Mode has no confirmation gate**, so each task needs a distinct unattended
equivalent of its interactive "propose and wait for confirmation" behavior. The existing
precedent for this is Step A7 ("Task Out Missing Docs"): rather than guess, it files a
task-store follow-up task via the existing `/tasks/bulk` POST and defers the actual
write to a later, human-reviewed pass. All three tasks below reuse that same mechanism
instead of introducing a second, easy-to-miss "advisory" reporting channel:

- **RDQ-1.1** extends Step A7 itself — the concern-checklist candidates are unioned into
  the same missing-docs task payload Step A7 already builds and posts.
- **RDQ-1.2** and **RDQ-1.3** add a new **Step A5.5 — Auto Mode Quality Pass**, run
  immediately after Step A5 applies staleness rewrites, against each doc A5 just touched.
  Hits are filed as task-store tasks (same bulk mechanism), not auto-edited.

Auto-mode follow-up tasks use `session: "docs-freshness-cron"` — the same session Step A7
already uses for missing-doc tasks — so they surface in the same place the auto-run's own
downstream tooling already queries, rather than fragmenting into a new session. This is a
judgment call (not derivable from the source spec); flagged during planning and accepted.

Interactive Mode (Steps 3/5/6/8) is unaffected in scope by the auto-mode work — all three
checks are additive to interactive mode's existing "propose and wait" flow.

Safe to deploy standalone: yes — all three are additive (new checklist entries, a new
summary section, a new auto-mode step); nothing existing is renamed, removed, or changed
in behavior when the new checks find nothing to flag.

## Tasks

| ID | Title | Depends on | Branch | Layer | Hours | Complexity | Model | HITL |
|----|-------|-----------|--------|-------|-------|------------|-------|------|
| RDQ-1.1 | Add cross-cutting concerns checklist to gap analysis | — | `feat/rdq-1-1-cross-cutting-checklist` | CLI | 3 | 3 | sonnet | |
| RDQ-1.2 | Add canonical-source-duplication and mechanism-honesty quality checks | — | `feat/rdq-1-2-canonical-duplication-check` | CLI | 4 | 4 | sonnet | |
| RDQ-1.3 | Add doc size governance with split proposal | — | `feat/rdq-1-3-size-governance` | CLI | 2.5 | 3 | sonnet | |

### RDQ-1.1 — Add cross-cutting concerns checklist to gap analysis

Today's Step 3 gap analysis only detects **structurally** missing docs (a module directory
with no `docs/{module}.md` counterpart). Add a checklist pass for concern-based domains
that cut across modules and are easy to miss structurally: business-domain/state-model,
authorization/access-control, error-handling conventions, sensitive-data handling,
secrets/credential rotation, logging/tracing/observability wiring, and third-party/internal
service dependencies a newcomer wouldn't recognize from public docs alone.

**Interactive mode:** for each category, verify it is materially present in the codebase
(e.g. an actual authz middleware/decorator, a dedicated error class hierarchy, a logging
SDK init) before proposing it — never propose an empty stub. Present verified candidates in
the `DOCS AUDIT` summary as a new `CONCERNS:` block, visually distinct from `MISSING:` but
flowing into the same `Proceed?` gate.

**Auto mode:** extend Step A7 — a concern verified materially present (scoped to
`CHANGED_FILES`, same as A7's existing structural check) with no matching doc gets unioned
into the same missing-docs task payload A7 already posts via `/tasks/bulk`, using
`title: "Document {concern} conventions"` to distinguish it from A7's existing
`"Document {module} module"` structural tasks. Same `session: "docs-freshness-cron"`.

**Acceptance criteria:**
- Interactive mode: a project with a real authorization/access-control layer gets it
  proposed in the `CONCERNS:` block, distinct from the structural `MISSING:` list; a
  project with no sensitive-data handling does not get that category proposed
- Auto mode: Step A7's missing-docs task payload includes a concern-based task when a
  concern is verified present in `CHANGED_FILES` with no matching doc, alongside any
  structural missing-doc tasks from the same run
- Test decision: add unit/content-test coverage in `research-docs.unit.test.ts` (new
  `describe` block, matching the existing suite's content-assertion style) for: a concern
  that verifies present gets proposed (interactive), a concern that verifies absent is
  skipped, and Step A7's auto-mode task payload documents unioning concern candidates
  alongside structural ones. No existing tests change — this is additive coverage only.

### RDQ-1.2 — Add canonical-source-duplication and mechanism-honesty quality checks

Add a quality pass, run on any doc drafted or updated in a session, checking for two
failure classes: (1) content that has a single canonical source elsewhere in the repo
(a route/endpoint table duplicating an API spec, a DB entity/migration enumeration
duplicating the migrations directory, an env-var table duplicating an example env file, a
codegen'd identifier list duplicating its codegen source) that will go stale the moment the
canonical source changes; (2) a concrete literal value (schedule expression, pool size,
timeout, percentage, count) whose prose paraphrase elsewhere in the same doc doesn't match
it. Also flag any convention described only as a principle with no concrete mechanism named
(the specific annotation, helper, command, or config key) as low-confidence.

**Interactive mode:** these are proposals surfaced for user confirmation (Step 5/6, before
Step 8's summary) — never automatic rewrites.

**Auto mode:** new **Step A5.5 — Auto Mode Quality Pass**, run immediately after Step A5
applies staleness rewrites, against each doc A5 just touched. Each hit files a task-store
task via the same `/tasks/bulk` mechanism A7 uses (e.g. `"Review {doc} for canonical-source
duplication"`, `"Review {doc} literal/prose mismatch"`, `"Review {doc} convention missing
named mechanism"`), `session: "docs-freshness-cron"` — never an auto-edit. Step A9's summary
gets a new `Quality flags tasked: N` line.

**Acceptance criteria:**
- Interactive mode: a doc containing a large route/endpoint table gets flagged with a
  proposed pointer-replacement when a canonical spec source is present in the repo; a doc
  containing a literal value and a mismatched prose paraphrase is flagged with the specific
  line; a doc stating a convention with no named mechanism is flagged as low-confidence
- Auto mode: Step A5.5 runs against docs Step A5 just rewrote and files one task-store task
  per hit instead of editing; Step A9's summary reports the count
- Test decision: add unit/content-test coverage in `research-docs.unit.test.ts` for each of
  the three interactive checks plus Step A5.5's existence and its task-filing (not editing)
  behavior in auto mode. No existing tests change.

### RDQ-1.3 — Add doc size governance with split proposal

Generated docs have no size target today and can grow unbounded. Define a soft target
(~100-150 lines) and a hard threshold (~150-200 lines); when updating a doc that would
exceed the hard threshold, propose a split into the current doc plus sub-topic doc(s)
rather than growing an ever-larger single file.

**Interactive mode:** the split is proposed (which sections move where) and requires
confirmation before any new file is created — never automatic.

**Auto mode:** folds into RDQ-1.2's Step A5.5 pass — after Step A5 rewrites a doc, check
its resulting line count; over the hard threshold files a task-store task
(`"Split {doc} — exceeds {N} lines"`) with a best-effort section-grouping suggestion in the
description, same `/tasks/bulk` mechanism, `session: "docs-freshness-cron"`. Step A9's
summary gets a new `Split proposals tasked: N` line.

**Acceptance criteria:**
- Interactive mode: updating a doc that stays under the hard threshold behaves as today (no
  split proposal); updating a doc that would exceed the hard threshold triggers a split
  proposal identifying which sections would move to a new sub-topic file
- Auto mode: Step A5.5 checks line count on docs Step A5 rewrote and files a split-proposal
  task when the hard threshold is exceeded, without creating any file; Step A9's summary
  reports the count
- Test decision: add unit/content-test coverage in `research-docs.unit.test.ts` for both the
  under-threshold (no-op) and over-threshold (split proposal) interactive cases, plus Step
  A5.5's line-count check and task-filing behavior in auto mode. No existing tests change.

### Dependency Map

```
[START]
  ├─ RDQ-1.1: Add cross-cutting concerns checklist (no deps)
  ├─ RDQ-1.2: Add canonical-source-duplication + honesty checks (no deps)
  └─ RDQ-1.3: Add doc size governance (no deps)
```

```
Task     | Depends on | Blocks | HITL
RDQ-1.1  | —          | —      |
RDQ-1.2  | —          | —      |
RDQ-1.3  | —          | —      |
```

All three touch the same two files but are independently shippable — each is additive to a
different section of `research-docs.md` (Step 3 / Step A7 for RDQ-1.1; a new Step 5/6
quality pass + new Step A5.5 for RDQ-1.2 and RDQ-1.3) and none depends on another's content
existing first. Sequential `dev-task` execution against current `main` handles any adjacent
edits to the same file.

## HITL scan

HITL scan: no tasks require human steps

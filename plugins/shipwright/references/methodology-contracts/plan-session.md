# Plan-Session Methodology Contract

The interface any subagent plugged into the "plan-session" pipeline phase's decomposition
step must satisfy — whether that's the built-in behavior (Steps 2 through 5.5 of
`plugins/shipwright/commands/plan-session.md`) or a custom, operator-supplied subagent
swapped in via a per-agent, per-phase `AgentPhaseMethodology` override (`phase ->
subagentType or null`, phase value `"plan-session"`). The `/shipwright:plan-session` command
is the caller: it owns Step 1 (loading CLAUDE.md, scanning for existing/duplicate tasks in
this session, scanning open cross-session tasks, and — under `--autonomous` — materializing
`planning/{session}/PRODUCT-SPEC.md` from the originating PRD task's `description`) and Step 6
(writing `PLAN.md` to disk, the `/tasks/bulk` POST, the plan-viz link, autonomous PRD
closeout, and opening the plan PR) — none of that is delegated. Once the spec is loaded, the
caller dispatches whichever subagent is configured for the plan-session phase with the inputs
below and parses the output shape below regardless of which concrete agent produced it. A
drop-in replacement for the built-in decomposition step must accept exactly these inputs and
return exactly this output shape — the caller has no other integration point and does no
phase-specific adaptation.

`plugins/shipwright/commands/plan-session.md`'s Steps 2 through 5.5 are the **reference
implementation** this contract was extracted from — codebase exploration across four layers
(business logic / views / APIs / DB), complexity-risk and breaking-change flagging, optional
web research, design proposal (iterate-until-approved interactively, or accept-first-pass
under `--autonomous`), task breakdown with complexity/model scoring and bundle-model
inheritance, and Type-A HITL detection. Consult it for the full built-in decomposition logic;
this doc only specifies the wire shape, not decomposition policy.

## Inputs

- **`specContent`** — the full verbatim contents of `planning/{session}/PRODUCT-SPEC.md`
  (Step 1's primary input). Under `--autonomous`, this is the text the caller already
  materialized from the originating PRD task's `description` (with the submitter's
  `Commit as PRODUCT-SPEC.md and run /shipwright:plan-session.` instruction line stripped) —
  the subagent receives the same materialized spec either way and does not re-derive it.
- **`repo`** — `org/repo`. Always passed explicitly by the caller (interactively-confirmed or,
  under `--autonomous`, supplied by the dispatcher) — the subagent must not attempt to
  auto-detect it.
- **`session`** — the session slug used to group tasks and PRs.
- **`existingSessionTaskIds`** (optional) — task ids already queued for this session (Step
  1.3's dedup scan against `GET /tasks?session={session}`), so the subagent does not propose
  duplicates of work already in the queue. Omitted (empty array) when the session has no
  existing tasks.
- **`openCrossSessionTasks`** (optional) — `{id, title, status, session}` entries for open
  tasks from prior sessions (Step 1.4's scan) that may be valid `dependencies` values for the
  new task breakdown. Omitted entirely when none exist.
- **`testLayerDefs`** (optional) — the layer definitions loaded from
  `docs/test-readiness/test-system.md` when that file exists in the repo worktree. Omitted
  when the file is absent — a compliant subagent falls back to the four built-in defaults
  (unit / integration / smoke / e2e) exactly as the reference implementation's Step 2 does,
  and must not guess a project-specific set instead.
- **`principles`** (optional) — the verbatim contents of the loaded principles file: a
  project-level `.claude/shipwright/principles.md` override when present, otherwise the
  default `plugins/shipwright/references/principles.md`. Its `architecture`, `testing`, and
  `security` domain entries inform task scope and acceptance criteria (e.g. respecting
  `architecture_layering` when splitting a task across layers, citing a relevant
  `security_*` entry in a security-specific acceptance criterion).
- **`autonomous`** (optional) — `{taskId}`, the originating PRD task's id, present only when
  the caller was itself invoked with `--autonomous`; omitted in interactive mode. When
  present, the subagent applies the loose-ambiguity bar instead of iterating with a human:
  **soft ambiguity** (spec is silent, vague, or has multiple reasonable readings, but a
  sensible default exists) — apply the default and append a bullet to `decisionLog[]` rather
  than stalling or asking; **hard contradiction** (the spec's own requirements conflict with
  each other or with a hard codebase constraint in a way no default can resolve without
  guessing) — do not fabricate an answer or silently pick a side; instead populate
  `hardContradiction` in the output and stop.

## Output

A single JSON object:

```json
{
  "tasks": [
    {
      "id": "PREFIX-1.1",
      "source": "planning/{session}/PLAN.md",
      "session": "{session}",
      "repo": "org/repo",
      "title": "Add billing schema migration",
      "description": "What to build, not how.",
      "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
      "layer": "API",
      "branch": "feat/prefix-1-1-add-billing-schema-migration",
      "dependencies": [],
      "status": "pending",
      "hitl": false,
      "pr": null,
      "hours": 2,
      "complexity": 3,
      "model": "sonnet"
    }
  ],
  "planMarkdown": "{full plan writeup: session name, technical design, task table, Dependency Map, Breaking Change Safety notes, and Decision Log}",
  "decisionLog": [
    "{decision point}: defaulted to {choice} — {one-line reason}"
  ],
  "hardContradiction": null
}
```

- **`tasks[]`** — zero or more task objects, each conforming exactly to the fields the
  `POST /tasks/bulk` endpoint accepts (see `task-store/prisma/schema.prisma`'s `Task` model
  and `task-store/src/openapi-schemas.ts`'s `BulkInsertItemSchema`/`TaskSchema`). The caller
  passes `tasks[]` straight through to `/tasks/bulk` as the request body — the subagent must
  not include any field the bulk endpoint doesn't recognize, and every field below maps 1:1
  to a `Task` model column:
  - `id` — `{PREFIX}-{N}.{M}`, prefix 2-3 letters from the feature name. Maps to `Task.id`
    (`String @id`).
  - `source` — always `"planning/{session}/PLAN.md"` — links the task back to the plan file
    the caller writes to disk in Step 6a. Maps to `Task.source` (`String?`).
  - `session` — the session slug passed in. Maps to `Task.session` (`String?`).
  - `repo` — the `repo` passed in, unchanged. Maps to `Task.repo` (`String?`); the bulk
    endpoint requires the `repo` key be present on every item (a literal `null` is valid for
    an unscoped task, but the key must exist).
  - `title` — short, verb-first. Maps to `Task.title` (`String`, required by the bulk
    endpoint).
  - `description` — what to build, not how; carries the injected `## Human steps` section for
    HITL-flagged tasks (see `hitl` below). Maps to `Task.description` (`String?`).
  - `acceptanceCriteria` — 2-5 specific, testable bullets, always including at least one test
    decision bullet (layers affected, tests added, tests retired and why). Maps to
    `Task.acceptanceCriteria` (`String[]`).
  - `layer` — one of `API | Frontend | Database | Shared | Background | CLI`. Maps to
    `Task.layer` (`String?`).
  - `branch` — `feat/{id-lowered-dashes}-{first-3-words-kebab}`, or a shared branch name for
    bundled tasks. Maps to `Task.branch` (`String?`).
  - `dependencies` — task ids (from this session or from `openCrossSessionTasks`) that must
    complete before this task is ready; empty array if none. Maps to `Task.dependencies`
    (`String[]`).
  - `status` — always `"pending"` for newly-decomposed tasks; the caller/executor owns every
    later transition. Maps to `Task.status` (`TaskStatus`, required by the bulk endpoint).
  - `hitl` — `true` for a Type-A HITL task (see reference implementation Step 5.5), `false`
    otherwise. Maps to `Task.hitl` (`Boolean?`).
  - `pr` — always `null` at decomposition time; no PR exists yet. Maps to `Task.pr` (`Int?`).
  - `hours` — a rough 1-8h estimate; larger work is broken into multiple tasks. Maps to
    `Task.hours` (`Float?`).
  - `complexity` — integer 1-5 per the reference implementation's scoring table. Maps to
    `Task.complexity` (`Int?`).
  - `model` — `"haiku" | "sonnet" | "opus"`, derived from `complexity` and, for bundled
    tasks, bumped to the bundle's highest tier before being written. Maps to `Task.model`
    (`String?`).
- **`planMarkdown`** — the full plan writeup (session name, technical design from Step 4, the
  task table and Dependency Map from Step 5, Breaking Change Safety notes, and — under
  `--autonomous` — the `## Decision Log` section). The caller writes this verbatim to
  `planning/{session}/PLAN.md` in Step 6a; the subagent does not write to disk itself.
- **`decisionLog[]`** — one string per soft-ambiguity default applied under `--autonomous`, in
  the form `"{decision point}: defaulted to {choice} — {one-line reason}"`. Empty outside
  `--autonomous`, since the interactive iterate-until-approved loop has no defaults to log.
- **`hardContradiction`** — `null` on success. When the subagent hits a hard contradiction
  under `--autonomous`, this is a short, human-readable one-line description (e.g. the same
  text the reference implementation would use for
  `blockedReason: "plan_session_autonomous_hard_contradiction: {...}"`) instead of `null`,
  and `tasks[]`/`planMarkdown` are empty/omitted. The caller uses this verbatim to PATCH the
  originating task to `blocked, hitl: true` and stops before Step 6 — mirroring the reference
  implementation's Step 4/5 escape hatch. Outside `--autonomous` this field is always `null`;
  there is no `taskId` to PATCH and no automated escape hatch to trigger — an interactive
  subagent instead keeps iterating with the human as the reference implementation's Step 4/5
  "iterate until approved" loop does.

## Scope

This contract covers only the wire shape between the caller and the plan-session-phase
decomposition subagent — what goes in, what comes back. It says nothing about how the
subagent internally explores the codebase, scores complexity, decides bundle groupings, or
applies HITL judgment; those are the concrete implementation's concern (see
`commands/plan-session.md` Steps 2 through 5.5 for the reference implementation's full
heuristics). It also says nothing about what the caller does with the output afterwards: the
`/shipwright:plan-session` wrapper continues to own writing `planning/{session}/PLAN.md` to
disk, POSTing `tasks[]` to `/tasks/bulk`, transitioning the originating PRD task to `done` on
success (or `blocked` on a `hardContradiction`), and opening the docs-only plan PR — the
subagent does not touch the task store, the filesystem, or GitHub directly.

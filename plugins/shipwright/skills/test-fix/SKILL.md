---
name: test-fix
description: Read docs/test-readiness/test-readiness-plan.md and queue its flat T-NNN task list as task-store tasks, one task per row, with dependency edges (predecessor) and per-task HITL classification. Requires test-roadmap to have run first. Replaces the former GitHub-issue publish skill's dashboard with a task-store queue. Includes a one-time --backfill-from-github mode that migrates already-published GitHub issues into task-store tasks and closes them.
---

# Test Fix

Read the latest `docs/test-readiness/test-readiness-plan.md` and queue its flat task list as
task-store tasks — one task per `T-NNN` row. Dependency edges (predecessor links) are written
as task-store `dependencies` arrays, so task-store's own `ready:true` query computes readiness
directly. Findings are never turned into direct PRs;
they always become task-store tasks that `dev-task` (or a human, for HITL tasks) picks up
later.

This is the **Phase 5** replacement for the former GitHub-issue publish skill.

**Prerequisites:** Run `/test-roadmap` first to produce `test-readiness-plan.md`.

> **Task store setup:** This skill pushes tasks to the Shipwright task store. If
> `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke
> `/shipwright:task-store` for setup instructions.

---

## Setup: Parse Arguments

Before starting, check for flags:

- `--dry-run` — print what would be queued (including hitl classification) without querying
  the task store for dedup and without writing anything.
- `--backfill-from-github [--repo owner/name]` — a separate, one-time migration mode. See the
  dedicated **Backfill Mode** section below. It does not run the regular flow (Steps 1–7).

> **Note:** Queueing is the only mode for the regular flow. There is no PR mode and no
> `--queue` flag — every regular run queues tasks. `--dry-run` shows a preview and stops
> without touching the task store.

---

## Step 1: Verify test-readiness-plan.md Exists

1. Look for `docs/test-readiness/test-readiness-plan.md` in the project root.
2. If it does not exist, print:
   ```
   No docs/test-readiness/test-readiness-plan.md found. Run /test-roadmap first to generate it.
   ```
   Then stop.
3. Read the plan.

---

## Step 2: Parse the Task List

1. Parse the `## 5. Task list` section's flat rows, format `T-NNN | M# | files | layer |
   bucket | outcome | verify` (per `test-roadmap/SKILL.md` section 5).
2. Parse any **audit-decision-row** tables (`## 5. Task list` → "Audit task decision rows",
   also rendered per-task in `issue.md.tmpl`'s "Audit decisions" section) attached to tasks
   marked `[audit: N items]` in the expected-outcome column. Keep each table's rows verbatim —
   they're needed for Step 5's description field and for the M5 HITL rule (rule c below).
3. Parse `depends_on` / predecessor links: any explicit `depends_on:` annotation on a row, and
   the Repo Configuration tasks' pairing (`depends_on` the paired workflow task, per
   `repo-config/SKILL.md`'s pairing rule).
4. If the task list is empty or malformed (rows don't match the `T-NNN | M# | ...` shape),
   print:
   ```
   No parseable T-NNN task rows found in test-readiness-plan.md. Nothing to queue.
   ```
   Then stop.

---

## Step 3: Detect Target Repo

Detect the current repo from git: run `git remote get-url origin` and strip the
`https://github.com/` (or `git@github.com:`, stripping the `.git` suffix) prefix to get the
`org/repo` value — e.g. `app-vitals/shipwright`. This is the `repo` value used both to scope
the dedup queries in Step 4 and, unchanged, as the task JSON's `repo` field in Step 5 —
compute it once here and reuse it there. (Same derivation as entropy-fix's Step 6q.1.)

Derive `repo-slug` from it too: the last path segment, lowercased — e.g.
`app-vitals/shipwright` → `shipwright`. This slug is appended to every task ID (Step 5) so
the same `T-NNN` scanned in two different repos never collides — the same class of bug
previously fixed for entropy-fix's task IDs.

---

## Step 4: Dedup Check

Skip this step entirely if `--dry-run` was passed (Step 6 handles the dry-run preview
instead — no dedup query is made).

Run (URL-encode the detected repo, e.g. `app-vitals%2Fshipwright`):
```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=pending&repo={url-encoded-repo}" | jq '.tasks'
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=in_progress&repo={url-encoded-repo}" | jq '.tasks'
```

The `&repo=` filter scopes dedup to tasks for the repo currently being scanned — without it,
a T-NNN active for one repo would incorrectly block or interfere with dedup for a different
repo.

Parse both `.tasks` arrays. From the combined results, collect tasks where:
- `source == "shipwright"`, AND
- `title` starts with `"Test readiness:"`

Extract the already-active `T-NNN` IDs from the task `id` field (format:
`test-{t-nnn}-{repo-slug}` — e.g. `test-t-104-shipwright` maps back to `T-104`). Build a set
of "already active" T-NNN IDs.

For each row from Step 2: if its `T-NNN` is in the "already active" set, skip it. Print:
`Skipping {T-NNN} — task already active`.

---

## Step 5: Build Task JSON

Skip this entire step if `--dry-run` was passed — Step 6 performs the equivalent
classification in-memory for the preview instead, without writing anything.

For each remaining `T-NNN` row (not skipped in Step 4), build a task object. Reuse the `repo`
and `repo-slug` values detected in Step 3 — do not re-derive them:

```json
{
  "id": "test-{t-nnn}-{repo-slug}",
  "title": "Test readiness: {outcome} (T-NNN)",
  "source": "shipwright",
  "repo": "<repo, as detected in Step 3>",
  "branch": "feat/test-{t-nnn-lower}-{slug}",
  "layer": "<test-layer from the row: unit | integration | smoke | e2e | infra>",
  "priority": "<critical | high | medium — see 5.1>",
  "type": "test-readiness",
  "status": "pending",
  "hitl": <true | false — computed per 5.2>,
  "dependencies": ["test-{predecessor-t-nnn}-{repo-slug}", "..."],
  "addedAt": "<current ISO timestamp>",
  "acceptanceCriteria": ["...", "Verification command `{verify}` passes"],
  "description": "<see 5.3>"
}
```

`{t-nnn}`: lowercase the row's task ID (e.g. `T-104` → `t-104`). `{t-nnn-lower}`: same value,
used in the branch name.

`slug` (for the branch name): lowercase, hyphens, max 5 words from the row's outcome.

**`layer` field note:** this is the row's **test-layer** value (`unit` / `integration` /
`smoke` / `e2e` / `infra`) — deliberately *not* the API/Frontend/Database/Shared/
Background/CLI convention `entropy-fix`/`error-fix`/`plan-session` use for their `layer`
field. Task-store's `layer` column is free text (`layer String?` in
`task-store/prisma/schema.prisma` — no enum constraint), so repurposing it here for
test-layer is safe and is more useful to `dev-task` and downstream tooling than a generic
bucket would be. Do not invent a second field for this — `layer` carries it.

### 5.1 Compute the `priority` Field

`priority` is the row's criticality tier, derived primarily from milestone:

- **M2 rows** (Critical-path coverage) → `critical`
- **M4 rows** (High-tier coverage) → `high`
- **M1 / M3 / M5 rows** → `medium`, **unless** the row carries its own explicit tier
  annotation (e.g. an inline `criticality: high` note or an audit-decision-row's own
  criterion naming a tier) — in that case use the row's own annotation instead.

This milestone-to-tier default for M1/M3/M5 is a deliberate, documented default — M1
(infrastructure), M3 (canary plumbing), and M5 (cleanup) tasks are usually not
criticality-ranked the way M2/M4 inventory items are, so `medium` is the safe default rather
than leaving the field ambiguous. Criticality tiers themselves come from
`test-inventory/SKILL.md` Step 4 (`critical` / `high` / `medium`) — the same three-tier
vocabulary, reused here for consistency with the rest of the pipeline.

### 5.2 Compute the `hitl` Field

The `hitl` boolean is a **per-task judgment call**, same philosophy as entropy-fix's Step
6q.4 and error-fix's Step 6 — no numeric or count-based backstop ever forces the
classification. Default `hitl: false`, except:

- **(a) CI workflow secret scan** — if the task creates or modifies a CI workflow file (e.g.
  a M1 "establish runner + CI pipeline shape" task touching `.github/workflows/*.yml`) and
  doing so would need a new `${{ secrets.* }}` reference: extract every `${{ secrets.* }}`
  reference the task's change would introduce, and check whether each secret name already
  appears in another workflow file in the repo (`grep -r '\${{ *secrets\.' .github/workflows/`).
  Any secret that is net-new — not referenced anywhere else in the repo — means a human must
  provision it. Set `hitl: true` and list the new secret name(s) in the description (same
  procedure as `plan-session.md`'s Step 5.5 "CI workflow secret scan" paragraph).
- **(b) Branch protection changes** — if the task modifies branch protection settings (the
  paired branch-protection tasks from `repo-config/SKILL.md`'s pairing rule, e.g. "Enable
  branch protection on `main` requiring the new CI jobs"), set `hitl: true` — this is a
  GitHub Settings action, not a code change an agent can make.
- **(c) M5 "delete (redundant)" audit tasks with an untested canonical owner** — if this is a
  M5 deletion task and its audit-decision-row table flags the canonical owner (the test that
  supersedes the one being deleted) as itself untested or not yet landed, set `hitl: true`.
  This mirrors `test-roadmap`'s own Open Risks guidance: don't delete a "redundant" test
  before its replacement exists — that call needs a human to confirm the replacement is
  actually in place and adequate.

Judge (a)/(b)/(c) against the row's own files/outcome/audit table — there is no default lean
either way beyond `false`; these three rules are the only paths to `true`.

### 5.3 Build the `description` Field

The `description` field must give `dev-task` (or the HITL executor) enough context to fix
without re-reading `test-readiness-plan.md`. It mirrors `issue.md.tmpl`'s body content minus
the GitHub-specific "Closing checklist" section — `acceptanceCriteria` is the task-store
equivalent of that checklist:

```
Milestone: {milestone name, e.g. "M2 — Critical-path coverage"}
Layer: {test-layer} | Bucket: {bucket} | Criticality: {priority}

Expected outcome: {outcome}

Files to touch:
{files_to_touch}

{If this is an audit task — include the audit-decision-rows table verbatim:}
Audit decisions:
| Item | Decision | Criterion |
|---|---|---|
{...rows, verbatim from Step 2's parse...}

Context:
- Inventory entry: docs/test-readiness/test-inventory.md#{anchor}
- Blueprint section: docs/test-readiness/test-system.md#{anchor}
- Migration bucket: docs/test-readiness/test-migration.md#{anchor}

Verification command: {verify}

Task: {T-NNN} | HITL: {hitl}
```

Resolve the three context anchors the same way the former GitHub-issue publish skill's Step
5.4 resolved context links — by matching the row's task ID / outcome against the corresponding
section headers in each artifact file. If an anchor can't be confidently resolved, omit that
line rather than guessing a broken link.

### 5.4 Compute `dependencies`

`dependencies` is an array of task-store IDs (`test-{t-nnn}-{repo-slug}` form) — one entry
per predecessor `T-NNN` this row's `depends_on` / pairing-rule reference names (parsed in
Step 2.3). Map each predecessor `T-NNN` to its task-store ID using the same
`{t-nnn}-{repo-slug}` derivation used for this task's own `id`.

This is what makes task-store's own `ready:true` query correctly compute readiness for these
tasks — it fully replaces the old `ready` / `blocked` label toggling the former GitHub-issue
publish skill's `--refresh` flag used to do. **Do not implement any separate ready/blocked
computation in this skill** — no local label state, no re-evaluation step. A task is ready
exactly when the task store says it is, by walking `dependencies`.

If a row has no predecessors, `dependencies` is an empty array.

---

## Step 6: Dry-Run Output (if --dry-run)

If `--dry-run` was passed, run Steps 1–3 and 2's parsing as normal, but skip Step 4 (dedup)
entirely — do not query the task store. For each parsed row, compute `priority` (5.1), `hitl`
(5.2), and `dependencies` (5.4) in-memory, then print a preview:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEST FIX — DRY RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Would queue {N} tasks:

  1. test-{t-nnn}-{repo-slug}
     Outcome: {outcome} (T-NNN, M#)
     Layer: {test-layer} | Priority: {priority}
     Depends on: {dependency task IDs, or "none"}
     HITL: {true|false} (classification per Step 5.2{a|b|c} or default)

  2. ...

No tasks written to task store. No dedup query made.
Re-run without --dry-run to queue tasks.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing.

---

## Step 7: Write, Queue, and Summarize

Skip this step if `--dry-run` was passed (handled in Step 6).

### 7.1 Write and Append

1. Write all task objects built in Step 5 to `/tmp/test-fix-tasks-{unix-timestamp}.json` as a
   JSON array.
2. Run:
   ```bash
   curl -sf -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks/bulk" \
     --data-binary @/tmp/test-fix-tasks-{unix-timestamp}.json | jq .
   ```
3. Delete the temp file after appending.

### 7.2 Print Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEST FIX — QUEUED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  QUEUED    {N} tasks   ({A} autonomous, {H} HITL)
  SKIPPED   {K} tasks (already active)

Tasks queued:
  test-{t-nnn}-{repo-slug} — {outcome}  [layer: {test-layer}, priority: {priority}, hitl: {true|false}]
  ...

{If any skipped:}
Skipped (already active):
  {T-NNN} — task already in queue or in progress

Run /shipwright:dev-task to execute autonomous tasks. HITL tasks are picked up via
/shipwright:hitl.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing — this is the sole final output for the regular flow.

---

## Backfill Mode (`--backfill-from-github [--repo owner/name]`)

A genuinely separate, one-time migration path — it does not run Steps 1–7 above (the regular
plan-parsing flow). It operates purely off existing GitHub issue state, since a fresh
`test-readiness-plan.md` may not exist in the target repo, or may have since diverged from
what was originally published by the former GitHub-issue publish skill.

Use this once, per repo, to migrate issues the former GitHub-issue publish skill already
created into task-store tasks, then retire the GitHub side of those specific issues (closing
them with a link back to the task store). Ordinary tasks going forward come from the regular
flow (Steps 1–7) against a current `test-readiness-plan.md`.

Full procedure (repo detection, issue parsing, predecessor-ordering, task creation, closing,
and the summary block): see `references/backfill-from-github.md`.

---

## Error Handling

- **`test-readiness-plan.md` missing** (regular flow): handled in Step 1 — print the message
  and stop.
- **No parseable task rows** (regular flow): handled in Step 2 — print the message and stop.
- **Task-store dedup query fails** (Step 4): log the failure and stop. Do not queue tasks
  without a dedup pass, or you risk duplicate tasks for an already-active `T-NNN`.
- **Bulk append fails** (`/tasks/bulk` non-2xx, Step 7.1): log the response body and
  stop. Do not retry blindly; re-running the regular flow is idempotent because the dedup
  check (Step 4) skips already-queued rows.
- **Backfill-specific failures** (auth, unreachable repo, missing task-id marker, partial
  bulk-append reruns): see `references/backfill-from-github.md`'s "Error Handling
  (Backfill-Specific)" section.

---

## Constraints (Do Not Violate)

- **Queue only** — this skill never opens PRs and never leaves the base branch. It only
  writes tasks to the task store; the actual fix lands later via `dev-task` or
  `/shipwright:hitl`.
- **No separate ready/blocked computation** — task-store's `dependencies` array and its own
  `ready:true` query are the sole readiness mechanism (Step 5.4). This skill never writes,
  toggles, or reads a local `ready` / `blocked` label the way the former GitHub-issue publish
  skill's `--refresh` flag did; that mechanism is fully replaced, not duplicated.
- **Dedup before queueing** — never skip Step 4 in the regular flow (outside `--dry-run`,
  which explicitly skips it by design and queues nothing for real).
- **No numeric/count backstop on `hitl`** — the only paths to `hitl: true` are the three
  explicit rules in Step 5.2 (CI workflow secrets, branch protection, untested M5 deletion
  owner). No file-count, line-count, or milestone-number threshold ever forces the
  classification on its own.
- **Backfill is one-time and separate** — `--backfill-from-github` never runs the regular
  Steps 1–7, and the regular flow never reads GitHub issue state. The two modes do not share
  logic beyond the field-mapping conventions of Step 5 (which backfill explicitly reuses,
  per B5).
- **Repo-scoped task IDs** — every task ID carries the `{repo-slug}` suffix (Step 3 / B1) so
  the same `T-NNN` scanned in two different repos never collides.
- **`test-readiness-plan.md` is not modified here** — a queued task only means a fix is
  scheduled. The plan document is Phase 4's output and is not checked off, annotated, or
  rewritten by this skill.
- **No interactive confirmation** — matches entropy-fix/error-fix: queue-only skills don't
  gate on user confirmation for regular-flow task-store writes, since they're internal and
  correctable. Backfill mode's `gh issue close` calls are the one externally-visible action
  in this skill, and they only happen after the corresponding task-store task already exists
  (B5 before B6) — never the reverse.

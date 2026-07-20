---
name: test-fix
description: Read docs/test-readiness/test-readiness-plan.md and queue its flat T-NNN task list as task-store tasks, one task per row, with dependency edges (predecessor/fan-out) and per-task HITL classification. Requires test-roadmap to have run first. Replaces the former GitHub-issue publish skill's dashboard with a task-store queue.
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
5. Run each surviving `T-NNN` row through the pre-filing verification checklist —
   `references/pre-filing-verification.md` (relative to the plugin root) — before it proceeds
   any further to Step 3 (repo detection), Step 4 (dedup), or Step 5 (task creation). This
   re-verifies the row against the current repo state (`test-readiness-plan.md` is a snapshot
   that may already be stale by the time this skill runs) and catches task ID / branch
   collisions early. Treat `references/pre-filing-verification.md` as canonical for how to
   apply the checklist. Per its four checks:
   - Drop rows whose target files (the `files` column, plus any fixture/test paths the row
     implies) no longer exist as described, or whose testing gap has already been closed by a
     later commit on main since `test-readiness-plan.md` was generated (Checklist Items 1–2) —
     do not build a task for them. Skip silently, matching this skill's own convention (there
     is no separate ledger section here beyond the dedup/summary output Step 4/Step 7 already
     produce).
   - **Route rows whose target-file or fixture existence can't be confirmed by a literal
     check to HITL, rather than assuming they're safe to drop or safe to file clean**
     (Checklist Item 3). This is the exact failure mode that caused task T-130's false
     negative: a grep-based existence check missed a fixture that was referenced via
     `path.join()` construction rather than a literal import or string match, so the row was
     treated as a confirmed pass when the fixture's real status couldn't actually be
     determined that way. When a row's target file or fixture is referenced indirectly —
     constructed paths, dynamic dispatch, reflection-based lookups, or anything else a literal
     grep/import check can't definitively resolve — do not treat it as either a confirmed pass
     (file exists, skip) or a confirmed absence (file missing, safe to file); route it to HITL
     instead. This feeds directly into the `hitl` computation in Step 5.2 as an explicit path
     to `hitl: true`.
   - Checklist Item 4 (task ID / branch collisions) is satisfied by this skill's own Step 3 /
     Step 4 dedup check (repo-slug-scoped task IDs, dedup query); no separate action is needed
     here beyond noting the overlap.
   This runs once, here in Step 2, so both the `--dry-run` preview (Step 6) and the real queue
   path (Step 7) operate on the same already-verified row set.

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
- `source == "test-fix"`, AND
- `title` starts with `"Test readiness:"`

Extract the already-active `T-NNN` IDs from the task `id` field (format:
`test-{t-nnn}-{repo-slug}` — e.g. `test-t-104-shipwright` maps back to `T-104`). Build a set
of "already active" T-NNN IDs.

For each row from Step 2: if its `T-NNN` is in the "already active" set, skip it. Print:
`Skipping {T-NNN} — task already active`.

### 4.1 Fuzzy Near-Duplicate Check

The exact-ID check above only catches literal `T-NNN` reuse, scoped to `source ==
"test-fix"` tasks whose title starts with `"Test readiness:"`. It cannot catch a
differently-numbered task that semantically duplicates existing active work — e.g. a
finding that gets re-scoped and re-queued under a new `T-NNN` after the original active task
was created by a different source or with a different title convention. That gap is exactly
what let one duplicate issue slip past dedup once the original had no task-store footprint
matching the narrow `source`/prefix filter.

To close it, run a second, wider comparison — no new API calls, no `--repo=`-scope change:
reuse the **same combined `.tasks` array** already fetched above (the `status=pending` and
`status=in_progress` results, both `&repo=`-scoped), but this time **do not** filter by
`source == "test-fix"` or by the `"Test readiness:"` title prefix. Consider literally every
active (pending + in_progress) task title for the repo, regardless of source or naming
convention.

For each row surviving the exact-ID check (i.e. not already skipped), compute its would-be
title exactly as Step 5 will build it — `"Test readiness: {outcome} (T-NNN)"` — and compare it
against every title in that unfiltered active-task set using **normalized word-overlap
(Jaccard similarity)**:

1. Lowercase both titles and strip punctuation.
2. Split each into a set of words (tokens).
3. `similarity = |intersection| / |union|` of the two word sets.

Flag any pair where `similarity >= 0.6`. This threshold is a deliberate middle ground:

- **Too strict (e.g. 0.9)** would miss genuine rewordings — the entire point of this check is
  to catch titles that got re-scoped or rephrased under a different `T-NNN`, which by
  definition won't be a near-exact string match.
- **Too loose (e.g. 0.3)** would flag unrelated tasks that merely share generic vocabulary
  ("test", "fix", "add"), producing enough noise that humans learn to ignore the flag.
- **0.6** is biased toward not missing a real duplicate, which is the safer failure mode —
  consistent with the "flag, don't skip" philosophy below.

**Worked example.** Suppose an existing active task (any source) is titled:

```
Test readiness: add integration coverage for auth middleware (T-041)
```

And a new candidate row from Step 2 would build the title:

```
Test readiness: add integration coverage for the auth middleware (T-058)
```

Lowercase, strip punctuation, and tokenize (dropping the parenthetical `T-NNN`, which is
excluded from the token comparison since it's expected to differ):

- Title A words: `{test, readiness, add, integration, coverage, for, auth, middleware}` (8)
- Title B words: `{test, readiness, add, integration, coverage, for, the, auth, middleware}` (9)
- Intersection: `{test, readiness, add, integration, coverage, for, auth, middleware}` (8)
- Union: `{test, readiness, add, integration, coverage, for, the, auth, middleware}` (9)
- `similarity = 8 / 9 ≈ 0.89`

`0.89 >= 0.6`, so this pair is flagged — even though `T-041` and `T-058` are different IDs and
the exact-ID check alone would have missed this duplicate entirely.

**This never causes a skip.** A fuzzy match is not removed from the Step 5 build list and is
never excluded from the Step 7.1 bulk POST — it still gets created. Fuzzy-match false
positives are common (shared vocabulary, generic verbs like "fix"/"add"/"update"), and
silently dropping genuinely new work because of a coincidental title overlap is a worse
failure mode than one extra line a human has to glance at. This mirrors the same philosophy
already applied to the `hitl` field (Step 5.2): no auto-decision on a fuzzy or judgment-based
signal where the cost of a wrong auto-decision is asymmetric — surface it for a human instead.

For each flagged pair, print:
`Flagging {T-NNN} — {similarity}% title-similar to active task {other-id}: "{other-title}" — not skipped, review after queueing`

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
  "source": "test-fix",
  "repo": "<repo, as detected in Step 3>",
  "branch": "feat/test-{t-nnn-lower}-{slug}",
  "layer": "<test-layer from the row: unit | integration | smoke | e2e | infra>",
  "priority": "<critical | high | medium — see 5.1>",
  "type": "test-readiness",
  "status": "pending",
  "hitl": <true | false — computed per 5.2>,
  "dependencies": ["test-{predecessor-t-nnn}-{repo-slug}", "..."],
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
- **(d) Ambiguous fix approach** — a general "is the fix approach obvious" judgment call,
  modeled on `consolidation-fix/SKILL.md`'s Step 7 per-finding `hitl` classification. The
  question here isn't "which canonical shape to converge on" (consolidation-fix's framing) —
  it's "is there an obvious, single way to write this test that mirrors existing precedent in
  the codebase, or is the testing approach itself ambiguous":
  - `hitl: false` continues to apply (no change to the existing default) when there's a clear
    existing test file/pattern nearby to mirror — the row's `files` column names a target test
    file adjacent to (or extending) an existing suite with the same layer/suffix convention,
    the fixture/mocking strategy already has precedent elsewhere in the codebase, and there's
    no real ambiguity about how the test should be structured.
  - `hitl: true` (new rule d) applies when **any** of the following hold:
    - **No existing precedent to mirror** — the row requires a genuinely novel test-fixture
      strategy (e.g. the first integration test against a new external dependency, or a test
      layer/suffix that doesn't yet exist anywhere in the repo for this component) and
      reasonable engineers could disagree about how to structure it.
    - **The row's scope crosses component/service boundaries** in a way that makes an
      isolated, obvious test hard to write — e.g. the row's `files` column spans multiple
      packages/services with no existing shared test-fixture convention between them.
    - **The row is itself an audit/judgment row** whose own audit-decision-row table (parsed
      in Step 2) reflects unresolved ambiguity about what "correct" behavior even is — distinct
      from rule (c)'s narrower untested-canonical-owner case, this is about the row's own
      decision criterion being unclear, not about a deletion target.
  - Rule (d) is evaluated **in addition to** rules (a)–(c) — it does not replace them, and the
    same "no default lean, judge each row on its own facts, no numeric backstop" philosophy
    that governs (a)–(c) and this whole section applies to (d) too.
  - **Carry-forward from Step 2's pre-filing check:** an unconfirmable indirect-reference row
    from Step 2's pre-filing verification (Checklist Item 3 — the T-130 false-negative
    pattern) is itself a path to `hitl: true` here. It is not a fifth numbered rule
    the way (a)–(d) are — it's carried forward from Step 2's per-row verification — but the
    `hitl` value it produces lands in this same field, so treat it as already-decided input
    alongside (a)–(d) rather than re-litigating it.

Judge (a)/(b)/(c)/(d) against the row's own files/outcome/audit table — there is no default
lean either way beyond `false`; these four rules (plus the Step 2 pre-filing carry-forward) are
the only paths to `true`.

**Worked example.**

Row 1 — `hitl: false`:
```
T-071 | M4 | src/lib/formatCurrency.ts | unit | high-tier | add unit coverage for formatCurrency edge cases | bun test src/lib/formatCurrency.unit.test.ts
```
`src/lib/formatCurrency.unit.test.ts` already exists with 10 sibling unit tests covering other
pure functions in the same file, following the same `describe`/`it` structure and no external
fixtures. This row simply extends that suite with more cases for the same function. Clear
existing pattern to mirror, no boundary crossing, no audit ambiguity → `hitl: false`.

Row 2 — `hitl: true` under rule (d):
```
T-088 | M2 | src/clients/paymentsGatewayClient.ts | integration | critical-path | add integration coverage for the new paymentsGatewayClient | bun test src/clients/paymentsGatewayClient.integration.test.ts
```
This is the first integration test against a brand-new external payments gateway dependency —
there is no existing `*.integration.test.ts` fixture/recording convention anywhere in the repo
for this kind of third-party client (the repo's other integration tests all cover internal
services with an established recorded-fixture pattern that doesn't obviously transfer to an
external payment API's auth/retry semantics). No existing precedent to mirror, reasonable
engineers could disagree on the fixture strategy → `hitl: true` per rule (d), even though
neither rule (a), (b), nor (c) applies.

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
entirely — do not query the task store. This includes the Step 4.1 fuzzy near-duplicate
check: it reuses Step 4's same two task-store queries, and `--dry-run`'s whole contract is
"no task-store queries made" (see Setup: Parse Arguments). Extending the fuzzy check into
dry-run would require querying the task store, which would break that contract — so dry-run
previews never surface fuzzy-duplicate flags; they only appear on a real (non-dry-run) run's
Step 4/7.2 output. For each parsed row, compute `priority` (5.1), `hitl`
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
  FLAGGED   {F} tasks (possible near-duplicate, not skipped)

Tasks queued:
  test-{t-nnn}-{repo-slug} — {outcome}  [layer: {test-layer}, priority: {priority}, hitl: {true|false}]
  ...

{If any skipped:}
Skipped (already active):
  {T-NNN} — task already in queue or in progress

{If any flagged:}
Flagged for review (possible near-duplicate, not skipped):
  {T-NNN} — {similarity}% title-similar to active task {other-id}: "{other-title}"

Run /shipwright:dev-task to execute autonomous tasks. HITL tasks are picked up via
/shipwright:hitl.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing — this is the sole final output for the regular flow.

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
- **Fuzzy near-duplicate check (Step 4.1) never skips** — it only ever flags for human review
  (printed in Step 4's output and again in Step 7.2's summary). Only the exact-ID check can
  remove a row from the Step 5 build list; a fuzzy title match is never, on its own, a reason
  to withhold a task from the bulk POST.
- **No numeric/count backstop on `hitl`** — the only paths to `hitl: true` are the four
  explicit rules in Step 5.2 (CI workflow secrets, branch protection, untested M5 deletion
  owner, ambiguous fix approach) plus the Step 2 pre-filing-verification carry-forward
  (unconfirmable indirect-reference rows). No file-count, line-count, or milestone-number
  threshold ever forces the classification on its own.
- **Repo-scoped task IDs** — every task ID carries the `{repo-slug}` suffix (Step 3) so
  the same `T-NNN` scanned in two different repos never collides.
- **`test-readiness-plan.md` is not modified here** — a queued task only means a fix is
  scheduled. The plan document is Phase 4's output and is not checked off, annotated, or
  rewritten by this skill.
- **No interactive confirmation** — matches entropy-fix/error-fix: queue-only skills don't
  gate on user confirmation for regular-flow task-store writes, since they're internal and
  correctable.

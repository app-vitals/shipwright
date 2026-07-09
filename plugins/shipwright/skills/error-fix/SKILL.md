---
name: error-fix
description: Read error-report.md, fetch each New/Regressed issue's Sentry detail and stack trace, classify hitl per issue, and queue task-store tasks (plus companion observability-fix tasks where instrumentation gaps hinder root-causing). Requires error-scan to have run first.
---

# Error Fix

Read the latest `error-report.md` and, for every unresolved New/Regressed issue that has a
mapped repo, fetch its Sentry detail and latest-event stack trace, classify whether it can be
fixed autonomously or needs a human, and queue it as a task-store task. Findings are never
turned into direct PRs; they always become task-store tasks that `dev-task` (or a human, for
HITL tasks) picks up later.

Issues whose service tag is `UNMAPPED` in the report are never queued — they're surfaced for
human triage instead, since guessing a repo could send a fix into the wrong codebase.

**Prerequisites:**
- Run `/error-scan` first to produce `error-report.md`.
- `SENTRY_ORG` and `SENTRY_AUTH_TOKEN` must be set in the environment — this skill calls the
  Sentry API directly (issue detail + latest event) to gather enough context for HITL
  classification and root-cause investigation, the same env vars `/error-scan` requires.

> **Task store setup:** This skill pushes findings to the Shipwright task store. If
> `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke
> `/shipwright:task-store` for setup instructions.

---

## Setup: Parse Arguments

Before starting, check for flags:

- `--dry-run` — print what would be queued (including hitl classification and companion
  tasks) without querying the task store for dedup and without writing anything (no
  task-store writes, no ledger writes)

> **Note:** Queueing is the only mode. There is no PR mode and no `--queue` flag — every
> run queues tasks. `--dry-run` shows a preview and stops without touching the task store or
> the ledger.

---

## Step 1: Verify error-report.md Exists

1. Look for `error-report.md` in the project root.
2. If it does not exist, print:
   ```
   No error-report.md found. Run /error-scan first to generate a report.
   ```
   Then stop.
3. Read the report.

---

## Step 2: Collect Candidate Issues

1. Parse the report's `## New Issues` and `## Regressed Issues` sections. Collect every
   unchecked (`- [ ]`) issue entry from both sections.
2. For each issue entry, read its recorded repo mapping status directly from the entry (the
   report states this explicitly per Step 6 of `/error-scan`'s output format: `Repo: {repo
   dir name}` or `Repo: **UNMAPPED** ({reason})`).
3. Split into two groups:
   - **Mapped** — entries with a concrete repo dir name. These proceed to Step 3.
   - **Unmapped** — entries marked `**UNMAPPED**`. These are **never** queued. Set them
     aside for the "surfaced for human triage" section of the final summary (Step 8).
4. If neither group has any entries (report shows "No new issues..." and "No regressed
   issues..." for both sections), print:
   ```
   No new or regressed issues to process. Run /error-scan to refresh the report.
   ```
   Then stop.

---

## Step 3: Fetch Sentry Detail Per Mapped Issue

For each mapped issue (by its Sentry issue `id` — the report shows `shortId`; resolve the
numeric/opaque `id` from the report entry or, if not present, look it up via
`https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/?query=is:unresolved` matching on
`shortId`), fetch:

```bash
curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/$ISSUE_ID/"
```

and the latest event for a stack trace:

```bash
curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/$ISSUE_ID/events/latest/"
```

Use these two responses as the basis for Step 5 (hitl classification) and Step 6 (companion
task detection). Never print or log `$SENTRY_AUTH_TOKEN` — reference it by name only, in
this file and in any output.

If either call fails for a given issue (non-2xx), note it and skip that issue for this run —
do not queue a task built on incomplete information. Include skipped-on-fetch-failure issues
in the final summary as a distinct line (not the same as "already active" or "unmapped").

---

## Step 4: Dry-Run Output (if --dry-run)

If `--dry-run` was passed, skip the dedup check (Step 5) entirely — do not query the task
store. For each mapped issue fetched in Step 3, run the classification (Step 6) and
companion-task detection (Step 7) in-memory, then print a preview:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ERROR FIX — DRY RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Would queue {N} tasks:

  1. error-{sentryIssueId}-{slug}
     Issue: {issue title} _{service}_ [hitl: {true|false}]
     Repo: {repo dir name}
     Reasoning: {one-line rationale for the hitl call}

  2. error-{sentryIssueId}-obs-{slug}   (companion)
     Call site: {file/module description}
     Reasoning: {one-line rationale — instrumentation gap found}
     [hitl: {true|false}]

  ...

{N} issues surfaced for human triage (unmapped):
  {shortId} — {title}

No tasks written to task store. No ledger changes.
Re-run without --dry-run to queue tasks.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing.

---

## Step 5: Dedup Check

Skip this step entirely if `--dry-run` was passed (handled in Step 4 instead).

Run:
```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=pending" | jq '.tasks'
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=in_progress" | jq '.tasks'
```

Parse both `.tasks` arrays. From the combined results, collect tasks where:
- `source == "shipwright"`, OR
- `title` starts with `"Error fix:"`

Extract the Sentry issue ID each already-active task covers, using either signal available:
1. Parse the task `id` field (format: `error-{sentryIssueId}-{shortId-or-slug}`) — the
   segment immediately after `error-` up to the next `-` is the Sentry issue ID.
2. Cross-reference `state/error-patrol-ledger.json`'s `taskLinks` map (written by this skill
   in Step 8 — see below) — invert it (`taskId -> sentryIssueId`) and match against the
   fetched tasks' `id` fields for a second signal, in case a task ID was hand-edited.

Build a set of "already active" Sentry issue IDs from the union of both signals.

For each mapped issue from Step 2: if its Sentry issue ID is in the "already active" set,
skip it entirely (no primary task, no companion-task investigation needed for queueing
purposes — it's already covered). Print: `Skipping {shortId} — task already active`.

Keep both `.tasks` arrays in memory if useful for description-building later, but this step's
only output is the "already active" set and the skip list.

---

## Step 6: Classify `hitl` Per Issue

For each remaining mapped issue (not skipped in Step 5), classify the primary fix task's
`hitl` field using the Sentry detail and stack trace fetched in Step 3. This is a **judgment
call made at runtime by the Claude agent running this skill** — there is no numeric or
severity threshold that ever forces the classification. `count`/`userCount` inform triage
priority (already reflected in the report's sort order), never the hitl call.

- **`hitl: false`** (autonomous) — a clear single root cause with an obvious fix: the stack
  trace points to one function/module, the fix is a straightforward code change (null check,
  missing `await`, wrong type, off-by-one, unhandled edge case in one code path, etc.), and
  it's contained to one service.
- **`hitl: true`** (needs a human) — the root cause is ambiguous, there's no clear
  reproduction path from the available context, the stack trace spans multiple
  services/repos, or a correct fix would require a product/design decision (e.g. "should
  this input actually be rejected, or should we accept and normalize it?").

Judge each issue on its own facts — no default lean either way, and never let event count or
user count alone push the call to either side.

---

## Step 7: Companion-Task Detection (Observability Gaps)

While investigating an issue's stack trace/context in Step 3 to classify it, watch for signs
that root-causing was **hindered by an instrumentation gap** at the relevant call site:

- Missing request/entity context on the Sentry event (e.g. no request ID, no
  user/account/entity identifier, no relevant params attached) that would otherwise have
  made the root cause obvious.
- Inconsistent logging shape at that call site compared to how similar call sites in the
  same codebase report errors.
- The issue looks like **pure noise** — an exception captured that isn't actually an
  actionable error (e.g. expected/benign condition raised as an exception, third-party
  library warning miscaptured, a client-abort or validation-rejection path that shouldn't be
  treated as a service error at all).

If one or more of these apply, queue a **second, companion task** for the observability fix
at that specific call site, **in addition to** the primary fix task for the issue itself.

- If the issue is a clear bug independent of the instrumentation gap, queue **both** the
  primary fix task (Step 6 hitl classification) and the companion task.
- If the issue is pure noise with nothing to "fix" beyond stopping the miscapture, queue
  **only** the companion task — there is no primary fix task, since there's no actual defect
  to correct beyond the instrumentation itself.

Classify the companion task's `hitl` with the same judgment style used for entropy-fix's
`per-finding` rows:

- **`hitl: false`** — a single, obvious call-site fix: e.g. add one missing context field to
  one `Sentry.captureException` call, or adjust one log statement's shape to match its
  neighbors.
- **`hitl: true`** — the gap **recurs across multiple call sites or services** with no
  existing shared abstraction to slot the fix into (e.g. there's no shared request-context
  concept yet to attach the missing field to, so introducing one is a design decision, not a
  drop-in change). This matches entropy-fix's `architecture_layering` /
  `duplicated_utility` per-finding judgment: ambiguous, multi-approach, or no service
  boundary exists yet → HITL.

If the primary fix genuinely depends on the companion task landing first (e.g. the fix can't
be verified/reproduced without the missing context the companion task adds), set
`dependencies: ["{companion task id}"]` on the primary task. Most of the time these are
independent — only set the dependency when there's a real ordering requirement, and note the
reasoning in the primary task's description either way.

---

## Step 8: Build Task JSON and Queue

Skip this entire step if `--dry-run` was passed (handled in Step 4).

### 8.1 Build Task Objects

For each issue with a primary fix task to queue:

```json
{
  "id": "error-{sentryIssueId}-{slug}",
  "title": "Error fix: {issue title}",
  "source": "shipwright",
  "repo": "<repo dir name from error-report.md's Service → Repo Mapping table, or re-derived from state/error-patrol-ledger.json's serviceRepoMap if the report is stale>",
  "branch": "fix/error-{sentryIssueId}-{slug}",
  "layer": "Background",
  "status": "pending",
  "hitl": <true | false — computed per Step 6>,
  "addedAt": "<current ISO timestamp>",
  "description": "<see below>"
}
```

For each companion observability-fix task to queue:

```json
{
  "id": "error-{sentryIssueId}-obs-{slug}",
  "title": "Error fix (observability): {call site description}",
  "source": "shipwright",
  "repo": "<same repo derivation as the primary task>",
  "branch": "fix/error-{sentryIssueId}-obs-{slug}",
  "layer": "Background",
  "status": "pending",
  "hitl": <true | false — computed per Step 7>,
  "dependencies": [],
  "addedAt": "<current ISO timestamp>",
  "description": "<see below>"
}
```

Repo derivation: read the repo dir name from `error-report.md`'s `## Service → Repo Mapping`
table (matched by the issue's service tag) — this is the primary source since it reflects
this run's data. Only fall back to re-deriving from `state/error-patrol-ledger.json`'s
`serviceRepoMap` if the report's mapping for that service is missing/stale (e.g. the report
predates the ledger's most recent scan). Never queue a task for a service that's `unmapped`
in either source — that issue should already have been filtered out in Step 2.

`slug`: lowercase, hyphens, max 5 words, derived from the issue title.

The primary task's `description` must give `dev-task` (or the HITL executor) enough context
to fix without re-reading Sentry:
```
Sentry issue: {shortId} — {issue title}
Link: {permalink}
Culprit: {culprit}
Service: {service tag} | Repo: {repo}

Stack trace summary:
{condensed summary of the top frames from the latest-event stack trace fetched in Step 3 —
enough to point at the function/file, not the full raw trace}

Root cause hypothesis: {your best-effort read from Step 6's investigation}

Fix guidance: {concrete guidance — e.g. "add a null check before accessing X in
path/to/file.ts:42" or "this requires a product decision on Y; do not guess"}

{If a companion task was also queued for this issue:}
Related observability task: {companion task id} — {one-line reason}

Issue: {sentryIssueId} | HITL: {hitl}
```

The companion task's `description`:
```
Observability gap at: {file/module or call site description}
Related Sentry issue: {shortId} — {issue title} ({permalink})

Gap: {missing context field | inconsistent logging shape | noise miscaptured as exception —
describe specifically what's missing or wrong}

Fix guidance: {e.g. "add {field} to the Sentry.captureException call at path/to/file.ts:NN"
or "reclassify this as a warning/log instead of captureException, since {reason it's not an
actionable error}"}

{If this call site's gap recurs across multiple services/call sites:}
Recurs at: {list of other locations observed, if known}

{If the primary fix depends on this landing first:}
Blocks: error-{sentryIssueId}-{slug} — {reason}

Issue: {sentryIssueId} | HITL: {hitl}
```

### 8.2 Write and Append

1. Write all task objects (primary + companion) to
   `/tmp/error-fix-tasks-{unix-timestamp}.json` as a JSON array.
2. Run:
   ```bash
   curl -sf -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks/bulk" \
     --data-binary @/tmp/error-fix-tasks-{unix-timestamp}.json | jq .
   ```
3. Delete the temp file after appending.

---

## Step 9: Update the Ledger

Skip this step if `--dry-run` was passed.

Update `state/error-patrol-ledger.json` — the same file `/error-scan` reads/writes, resolved
the same way (sibling of the repo checkouts, one level up from `repos/<repo>`; see
`/error-scan`'s Step 5 for the exact path convention). This is a **partial merge, not a full
overwrite**: read the existing ledger, add/update only the top-level `taskLinks` key, and
leave `lastRun`, `issues`, and `serviceRepoMap` untouched — those are owned by `/error-scan`.

Schema for `taskLinks`:
```json
{
  "taskLinks": {
    "<sentryIssueId>": {
      "primary": "<primary task id, or null if this issue only got a companion task>",
      "companion": "<companion task id, or omitted if none was queued>"
    }
  }
}
```

For every issue that got only a primary task, record `{"primary": "<id>"}` (no `companion`
key). For every issue that got only a companion task (pure-noise case), record
`{"primary": null, "companion": "<id>"}`. For every issue that got both, record both keys.

Merge these entries into the existing `taskLinks` map (add new keys, overwrite an existing
issue's entry if this run re-queued something for it — this shouldn't normally happen given
Step 5's dedup, but merge rather than replace wholesale regardless, since dedup is keyed on
"already active" tasks, not on `taskLinks` presence alone).

Print: `Ledger updated: state/error-patrol-ledger.json (taskLinks merged)`

---

## Step 10: Print Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ERROR FIX — QUEUED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  QUEUED     {N} tasks   ({A} autonomous, {H} HITL)
  SKIPPED    {N} issues (already active)
  UNMAPPED   {N} issues (surfaced for human triage, not queued)

Tasks queued:
  error-{sentryIssueId}-{slug} — {issue title}  [hitl: {true|false}]
  error-{sentryIssueId}-obs-{slug} — {call site description}  [hitl: {true|false}] (companion)
  ...

{If any skipped:}
Skipped (already active):
  {shortId} — task already in queue or in progress

{If any unmapped:}
Surfaced for human triage (unmapped service — not queued):
  {shortId} — {title} _{service tag}_ — {reason from error-report.md}

{If any skipped due to Sentry fetch failure:}
Skipped (Sentry fetch failed):
  {shortId} — could not fetch issue detail/stack trace this run

Run /shipwright:dev-task to execute autonomous tasks. HITL tasks are picked up via
/shipwright:hitl. Unmapped issues need manual repo identification — see error-report.md's
Service → Repo Mapping section.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing — this is the sole final output.

---

## Error Handling

- **`error-report.md` missing**: handled in Step 1 — print the message and stop.
- **No New/Regressed issues**: handled in Step 2 — print the message and stop.
- **Sentry fetch fails for an issue** (Step 3): skip that issue for this run (no task built
  on incomplete information), note it in the summary, and continue with remaining issues —
  do not abort the whole run over one failed fetch.
- **Task-store dedup query fails** (Step 5): log the failure and stop. Do not queue tasks
  without a dedup pass, or you risk duplicate tasks for the same Sentry issue.
- **Bulk append fails** (`/tasks/bulk` non-2xx): log the response body and stop. Do not
  retry blindly; re-running the skill is idempotent because the dedup check will skip
  already-queued issues.
- **Ledger write fails**: log the failure. Tasks are already queued at this point (Step 8
  runs before Step 9) — do not roll back the task-store writes; a missed `taskLinks` update
  degrades future dedup precision (Step 5's ledger cross-reference) but the `id`-parsing
  signal in Step 5 still catches most repeats.

---

## Constraints (Do Not Violate)

- **Unmapped over guessed** — never queue a task for an issue whose service tag is
  `UNMAPPED` in `error-report.md`. Surface it for human triage instead. A wrong repo guess
  sends a future fix into the wrong codebase.
- **No numeric/count backstop** — no event count, user count, or severity threshold ever
  forces a `hitl` classification, for either the primary fix task (Step 6) or the companion
  observability task (Step 7). Always a per-issue judgment call.
- **Dedup before queueing** — never skip the Step 5 dedup check (outside `--dry-run`, which
  explicitly skips it by design and queues nothing for real).
- **Companion-task reasoning stays local to this file** — the Sentry-specific logic for
  detecting instrumentation gaps and queueing companion observability tasks lives in this
  SKILL.md, not in `plugins/shipwright/references/principles.md`. `principles.md` stays
  vendor-agnostic; this mechanism only makes sense in the context of Sentry event/capture
  semantics.
- **Never log or persist `$SENTRY_AUTH_TOKEN`.** Not in tasks, not in the ledger, not in
  stdout output.
- **Queue only** — this skill never opens PRs and never leaves the base branch. It only
  writes tasks to the task store; the actual fix lands later via `dev-task` or
  `/shipwright:hitl`.
- **Ledger update is a partial merge** — only `taskLinks` is added/updated in
  `state/error-patrol-ledger.json`. `lastRun`, `issues`, and `serviceRepoMap` are owned by
  `/error-scan`; this skill never touches or removes them.
- **`error-report.md` findings are not checked off here** — a queued task only means a fix
  is scheduled. Checking off the report's findings (or resolving the underlying Sentry issue)
  happens via a separate mechanism (`error-resolve`, out of scope for this skill), not by
  this skill.
- **`--dry-run` mutates nothing** — no task-store dedup query, no bulk write, no ledger
  write. Everything that would happen is printed to stdout instead.

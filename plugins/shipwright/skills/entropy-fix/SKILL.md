---
name: entropy-fix
description: Read entropy-report.md and queue PR-worthy violations as task-store tasks, one task per rule, with per-finding HITL classification. Requires entropy-scan to have run first.
---

# Entropy Fix

Read the latest `entropy-report.md` and queue focused, human-reviewable tasks for
`PR-worthy` violations. Each task fixes one rule — no bundled concerns. Findings are
never turned into direct PRs; they always become task-store tasks that `dev-task`
(or a human, for HITL tasks) picks up later.

**Prerequisites:** Run `/entropy-scan` first to produce `entropy-report.md`.

> **Task store setup:** This skill pushes findings to the Shipwright task store. If
> `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke
> `/shipwright:task-store` for setup instructions.

---

## Setup: Parse Arguments

Before starting, check for flags:

- `--dry-run` — print what tasks would be queued without querying the task store for
  dedup or writing any tasks
- `--rule {id}` — queue only violations of a specific rule ID (e.g., `--rule dead_exports`)

> **Note:** Queueing is the only mode. There is no PR mode and no `--queue` flag — every
> run queues tasks. `--dry-run` shows a preview and stops without touching the task store.

---

## Step 1: Verify entropy-report.md Exists

1. Look for `entropy-report.md` in the project root.
2. If it does not exist, print:
   ```
   No entropy-report.md found. Run /entropy-scan first to generate a report.
   ```
   Then stop.
3. Read the report.

---

## Step 2: Load Principles

Load the same principles file that the scan used, filtered the same way:

1. Check `.claude/shipwright/principles.md` in the project root. If it exists, load it.
2. Otherwise, load the plugin default: `references/principles.md` (relative to the plugin root).
3. Filter to only entries containing a `**Detection:**` field — the same entropy-scannable set `/entropy-scan` used.
4. Build a map of `rule_id → entry` for quick lookup. Retain each entry's `**Severity:**`,
   `**PR-worthy:**`, and `**HITL:**` fields — the `**HITL:**` value (`always` / `never` /
   `per-finding`) is the authoritative classification source used in Step 6q.4. Do not
   hardcode a duplicate classification table here; principles.md is the single source of truth.

---

## Step 3: Filter and Group Findings

1. Parse the report's `## Findings` section. Collect all unchecked (`- [ ]`) findings.
2. Filter to only findings whose entry has `**PR-worthy:** true` in the principles file.
3. If `--rule` flag was passed, further filter to only that rule's findings. If no findings match that rule ID, print: "No unchecked findings for rule `{rule_id}`. Nothing to queue." and stop.
4. Group findings by `rule_id`. One task will be queued per group.
5. Sort groups: high-severity rules first, then medium, then low.
6. If no `PR-worthy` unchecked findings exist, print:
   ```
   No PR-worthy findings to queue. All violations are either:
   - Already checked off (fixed)
   - In entries marked PR-worthy: false (fix manually)
   Run /entropy-scan to refresh the report.
   ```
   Then stop.

---

## Step 4: Dry-Run Output (if --dry-run)

If `--dry-run` was passed, print a preview and stop without querying or writing to the task store:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENTROPY FIX — DRY RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Would queue {N} tasks:

  1. entropy-{rule-id}-{repo-slug}-{YYYY-Www}
     Rule: {rule.description} ({severity})
     Findings: {count} instances
     Files: {list of unique file paths}
     HITL: {true|false} (classification per Step 6q.4)

  2. ...

No tasks written to task store.
Re-run without --dry-run to queue tasks.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing.

---

## Step 5: Cap Check

If there are more than 10 rule groups to queue, note:

```
Found {N} rules with PR-worthy findings. Capping at 10 tasks per run.
Queueing highest-severity rules first. Re-run after these land to continue.
```

Process only the first 10 groups (sorted by severity).

---

## Step 6: Queue Tasks

Queueing is the only mode. Run this workflow for every run.

### 6q.1 Dedup Check

First, detect the current repo from git: run `git remote get-url origin` and strip the
`https://github.com/` (or `git@github.com:`, stripping the `.git` suffix) prefix to get the
`org/repo` value — e.g. `app-vitals/shipwright`. This is the `repo` value used both to scope
the dedup queries below and, unchanged, as the task JSON's `repo` field in 6q.3 — compute it
once here and reuse it there.

Derive `repo-slug` from it too: the last path segment, lowercased — e.g. `app-vitals/shipwright`
→ `shipwright`. This slug is used in task IDs throughout this skill (6q.3, 6q.6) to keep IDs
unique per repo.

Run (URL-encode the detected repo, e.g. `app-vitals%2Fshipwright`):
```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=pending&repo={url-encoded-repo}" | jq '.tasks'
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=in_progress&repo={url-encoded-repo}" | jq '.tasks'
```

The `&repo=` filter scopes dedup to tasks for the repo currently being scanned — without it, a
rule active for one repo would incorrectly block or interfere with dedup for a different repo.

Parse both `.tasks` arrays. From the combined results, collect tasks where:
- `source == "shipwright"`, OR
- `title` starts with `"Entropy fix:"`

Extract the rule IDs from existing tasks by parsing the `id` field (format:
`entropy-{rule-id}-{repo-slug}-{YYYY-Www}`) or from the `branch` field (format:
`fix/entropy-{rule-id}-...`). Build a set of "already active" rule IDs.

For each rule group: if its `rule_id` is in the "already active" set, skip it. Print: `Skipping {rule_id} — task already active`.

Keep both `.tasks` arrays in memory — the task-store cross-check in 6q.2 reuses them.

### 6q.2 Task-Store Cross-Check (dead-code deletion findings)

Before enqueueing any finding for a **deletion** rule — `dead_exports`, `unreferenced_files`,
or `commented_out_blocks` — cross-check it against the pending and in-progress tasks already
fetched in 6q.1. This prevents deleting code that another queued task is about to depend on.
(`commented_out_blocks` is currently `PR-worthy: false` in principles.md, so Step 3 filters
it out before it ever reaches this cross-check — this reference applies if that flag is
ever flipped to `true`.)

For each candidate finding under one of those three rules:

1. Extract the finding's flagged **file path** and, where the finding names one, its **symbol
   name** (e.g. the export name for `dead_exports`).
2. Scan the `title` and `description` text of every pending/in-progress task for a reference
   to that file path or symbol name (substring match on the path, and whole-word match on the
   symbol name to avoid spurious hits).
3. If a match is found, **skip** that finding — do not add it to the task's findings list.
   Record it for the final summary as: `deferred — {file}:{symbol} referenced by task {task-id}`.

After cross-checking, if a rule group has **zero** remaining findings (all were deferred),
skip the whole group and note it as deferred in the summary. Rules other than the three
deletion rules are not cross-checked — they pass through unchanged.

### 6q.3 Build Task JSON

For each remaining rule group, build a task object. Reuse the `repo` and `repo-slug` values
detected in 6q.1 — do not re-derive them:

```json
{
  "id": "entropy-{rule-id}-{repo-slug}-{YYYY-Www}",
  "title": "Entropy fix: {rule.description}",
  "source": "shipwright",
  "repo": "<repo, as detected in 6q.1>",
  "branch": "fix/entropy-{rule-id}-{short-description}",
  "layer": "Shared",
  "status": "pending",
  "hitl": <true | false — computed per Step 6q.4>,
  "addedAt": "<current ISO timestamp>",
  "description": "<findings summary — see below>"
}
```

The `description` field must give dev-task (or the HITL executor) enough context to fix without re-reading entropy-report.md:
```
Entropy patrol finding: {rule.id} — {rule.description} ({rule.severity})

Findings ({count} total):
- {file_path}:{line} — {finding_description}
{Include ALL findings that survived the 6q.2 cross-check. If there are more than 20, include the first 20 and append: "(+N more — re-run /entropy-fix to see all)"}

Fix guidance: {entry's **Detection:** field, or remediation guidance from the principles file}

Rule: {rule.id} | Severity: {rule.severity} | Domain: {rule.domain} | HITL: {hitl}
```

The `{repo-slug}` segment is the last path segment of the detected `repo` value (from 6q.1),
lowercased — e.g. `app-vitals/shipwright` → `shipwright`. It namespaces the task ID per repo so
the same rule scanned in two different repos in the same week never collides.

The `{YYYY-Www}` suffix in the task ID uses ISO week format. Compute from the current date:
- Year: 4-digit year
- `W`: literal `W`
- Week number: 2-digit zero-padded ISO week number (01–53)
- Example: `entropy-dead_exports-shipwright-2026-W23`

`short-description`: lowercase, hyphens, max 5 words from rule.description.

### 6q.4 Compute the `hitl` Field

The `hitl` boolean is computed **per finding-group** by reading the rule's `**HITL:**` field
from the principles map loaded in Step 2 — this file is the single source of truth for the
classification, so do not maintain a duplicate table here. There is **no** numeric backstop:
no file-count or line-count threshold ever forces a task to HITL.

Look up `rule.hitl` (the `**HITL:**` field value) and route:

- **`never`** → `hitl: false` unconditionally. The fix is obvious by construction. This is
  `dead_exports` (nothing imports it), `unreferenced_files`, and `commented_out_blocks` (once
  reviewed, deletion/restoration is unambiguous). These three still pass through the 6q.2
  cross-check before they are enqueued. (`commented_out_blocks` is currently
  `PR-worthy: false`, so this `hitl` classification is dormant until that flag changes —
  see the 6q.2 note.)
- **`always`** → `hitl: true` unconditionally. This is `hardcoded_secrets`: a committed secret
  is compromised and needs rotation — an infra/access action outside the codebase that a code
  edit alone cannot resolve. `entropy-fix` never autonomously "fixes" a secret.
- **`per-finding`** → evaluate the specific finding group and decide. This is
  `duplicated_utility` and `architecture_layering`. Use judgment (you are the Claude agent
  running this skill), grounded in the principle's prose:
  - `hitl: false` (autonomous) when the fix is a clear, mechanical, single-approach move —
    a single obvious call site, a clear drop-in replacement with matching behavior, or a
    trivial one-line move up into an **existing** service method.
  - `hitl: true` (needs a human) when it is ambiguous or multi-approach — behavior differs
    between the local copy and the shared lib, there are multiple reasonable ways to
    consolidate/restructure, or **no service boundary exists yet** to move the logic into.
  - No default lean either way; judge each group on its own facts. This is a judgment call
    made at runtime, never a count-based heuristic.

### 6q.5 Write and Append

1. Write all task objects to `/tmp/entropy-tasks-{unix-timestamp}.json` as a JSON array
2. Run:
   ```bash
   curl -sf -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks/bulk" \
     --data-binary @/tmp/entropy-tasks-{unix-timestamp}.json | jq .
   ```
3. Delete the temp file after appending

### 6q.6 Print Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENTROPY FIX — QUEUED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  QUEUED    {N} tasks   ({A} autonomous, {H} HITL)
  SKIPPED   {N} rule groups (already active)
  DEFERRED  {N} findings (referenced by pending/in-progress tasks)

Tasks queued:
  entropy-{rule-id}-{repo-slug}-{YYYY-Www} — {rule.description}  [hitl: {true|false}]
  ...

{If any skipped:}
Skipped (already active):
  {rule_id} — task already in queue or in progress

{If any deferred by cross-check:}
Deferred (referenced by existing task):
  {file}:{symbol} — referenced by task {task-id}

Run /shipwright:dev-task to execute autonomous tasks. HITL tasks are picked up via
/shipwright:hitl.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing — this is the sole final output.

---

## Error Handling

- **Task-store query fails** (dedup/cross-check in 6q.1): log the failure and stop. Do not
  queue tasks without a dedup + cross-check pass, or you risk duplicate tasks and deleting
  code a pending task depends on.
- **Bulk append fails** (`/tasks/bulk` non-2xx): log the response body and stop. Do not retry
  blindly; re-running the skill is idempotent because the dedup check will skip already-queued
  rules.
- **No PR-worthy findings**: handled in Step 3 — print the "nothing to queue" message and stop.
- **More than 10 groups**: cap at 10 as described in Step 5. Always queue highest-severity first.

---

## Constraints (Do Not Violate)

- **One task per rule** — never bundle multiple rule violations into one task.
- **Queue only** — this skill never opens PRs and never leaves the base branch. It only writes
  tasks to the task store; the actual fix lands later via `dev-task` or `/shipwright:hitl`.
- **Cross-check before deletion** — never enqueue a `dead_exports` / `unreferenced_files` /
  `commented_out_blocks` finding without running the 6q.2 task-store cross-check first.
- **No cascade** — only queue what's in the current `entropy-report.md`. Do not re-scan during a run.
- **No principles.md changes** — the fix skill enforces principles, it does not modify them,
  and it reads the `**HITL:**` classification from principles.md rather than duplicating it.
- **entropy-report.md is not checked off here** — a queued task only means a fix is scheduled.
  The report's findings are checked off when the queued task actually lands its fix, via a
  separate mechanism, not by this skill.

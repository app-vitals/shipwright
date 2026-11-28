---
name: entropy-fix
description: "Read the entropy-scan handoff for one repo and route PR-worthy violations as task-store tasks (auto / review / plan), one task per rule. Requires --repo org/repo and /entropy-scan to have run first."
argument-hint: "--repo org/repo [--dry-run] [--rule id]"
---

# Entropy Fix

Read the findings `/entropy-scan` left for one repo and queue focused tasks for `PR-worthy`
violations. Each task covers one rule — no bundled concerns. Every rule group is **routed**
one of three ways — auto, review or plan — per the finding-routing contract in
[docs/task-store.md](../../../../docs/task-store.md) ("Finding routing" and "System-cron
contract"; task shapes also in the `/shipwright:task-store` skill). Findings are never turned
into direct PRs; they always become task-store tasks. Records exactly one run for the whole
`entropy-patrol` task, with separate auto/review/plan counts.

**Prerequisites:** Run `/entropy-scan --repo org/repo` first (the `entropy-patrol` system cron
chains the two for you).

> **Task store setup:** This skill pushes findings to the Shipwright task store. If
> `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke
> `/shipwright:task-store` for setup instructions.

---

## Setup: Parse Arguments

`--repo org/repo` is **required**. If it is missing, print the following and stop without
reading anything, scanning `repos/`, or touching the task store:

```
Usage: /shipwright:entropy-fix --repo org/repo [--dry-run] [--rule {id}]
```

Other flags:

- `--dry-run` — print what tasks would be queued without querying the task store for
  dedup or writing any tasks; records no run (and the task store is not touched at all)
- `--rule {id}` — queue only violations of a specific rule ID (e.g., `--rule dead_exports`)

> **Note:** Queueing is the only mode. There is no PR mode and no `--queue` flag — every
> run queues tasks. `--dry-run` shows a preview and stops.

---

## Step 1: Locate the scan handoff

The scan runs in a worktree named `{dirname}-docs-entropy-patrol-{YYYYMMDD}` (or the reused
earlier-day docs branch's worktree) under `$SHIPWRIGHT_WORKTREE_DIR`, where `{dirname}` is the
`repos/` directory whose `origin` remote URL matches `org/repo`. Use the most recently
modified such worktree. Read `.entropy-patrol/findings.json` in it (schema: see
`/entropy-scan` Step 4.1) and `cd` there for everything below.

If the worktree or the file does not exist, print:

```
No entropy scan handoff found for {org/repo}. Run /entropy-scan --repo {org/repo} first.
```

Then stop. Never read a report file from a clone root.

The `repo` slug and `{repo-slug}` for task IDs come from `--repo` (`app-vitals/shipwright` →
slug `shipwright`, the last path segment lowercased) — do not detect them from git. If the
handoff's `repo` differs from `--repo`, stop with an error.

---

## Step 2: Load Principles

Load the same principles file that the scan used, filtered the same way:

1. Check `.claude/shipwright/principles.md` in the repo worktree. If it exists, load it.
2. Otherwise, load the plugin default: `references/principles.md` (relative to the plugin root).
3. Filter to only entries containing a `**Detection:**` field — the same entropy-scannable set `/entropy-scan` used.
4. Build a map of `rule_id → entry` for quick lookup. Retain each entry's `**Severity:**`,
   `**PR-worthy:**`, and `**HITL:**` fields — the `**HITL:**` value (`always` / `never` /
   `per-finding`) is the authoritative input to the Step 6.1 routing. Do not
   hardcode a duplicate classification table here; principles.md is the single source of truth.

---

## Step 3: Filter and Group Findings

1. Read the `findings` array of the handoff file (Step 1). Every finding in it is open: the
   scan re-derives the full set each run, so there is no checked-off state.
2. Filter to only findings whose entry has `**PR-worthy:** true` in the principles file; keep every `tooling_*` baseline finding (all are PR-worthy; see Step 6.1).
3. If `--rule` flag was passed, further filter to only that rule's findings. If no findings match that rule ID, print: "No unchecked findings for rule `{rule_id}`. Nothing to queue." and stop.
4. Group findings by `rule_id`. One task will be queued per group.
5. Sort groups: high-severity rules first, then medium, then low.
6. If no `PR-worthy` unchecked findings exist, print:
   ```
   No PR-worthy findings to queue. All violations are either:
   - Already fixed (no longer in the scan)
   - In entries marked PR-worthy: false (fix manually)
   Run /entropy-scan --repo {org/repo} to refresh the handoff.
   ```
   Then stop.
7. Run each surviving finding through the pre-filing verification checklist —
   `references/pre-filing-verification.md` (relative to the plugin root) — before it proceeds
   any further. This re-verifies the finding against the current repo state (the scan report
   is a snapshot that may already be stale by the time this skill runs) and catches task ID /
   branch collisions early. Treat `references/pre-filing-verification.md` as canonical for how
   to apply the checklist. Per its four checks:
   - Drop findings whose file/line no longer exists or whose described gap is already fixed
     (Checklist Items 1–2) — do not queue a task for them. Log them the same way as other
     skipped findings (Step 6.6 summary).
   - Route findings that can't be confirmed by a literal check to HITL rather than assuming
     they're safe to drop (Checklist Item 3) — this feeds into the `hitl` computation in
     Step 6.1.
   - Checklist Item 4 (task ID / branch collisions) is satisfied by this skill's own 6.2 dedup
     check; no separate action is needed here beyond noting the overlap.
   This runs once, here in Step 3, so both the `--dry-run` preview (Step 4) and the real queue
   path (Step 6) operate on the same already-verified finding set.

---

## Step 3.5: Re-check Suppressions (defense in depth)

`entropy-scan` already drops suppressed findings, but a stale handoff file written
before a suppression landed can still list them. Before dedup, re-check every surviving
finding against `.shipwright/suppressions.yml` in the **repo being fixed** (schema:
`references/suppressions-schema.md`; per-principle `symbol` convention:
`entropy-scan/references/suppressions.md`) so a stale handoff cannot refile it.

1. **Build candidates**, one `{rule: "entropy", file, symbol, rule_id, line}` per finding. `file`
   comes from the finding's path; derive `symbol` per the per-principle convention (never a line
   number; matching is exact).
2. **Filter** with the shared script, from the repo being fixed:
   ```bash
   bun "$CLAUDE_PLUGIN_ROOT/scripts/suppressions.ts" --filter .shipwright/suppressions.yml candidates.json
   ```
   A missing file is valid (nothing suppressed). A non-zero exit means the file is invalid —
   print the error and treat it as "no suppressions applied"; never abort. `expired` entries do
   not suppress.
3. **Skip each `suppressed` finding** — remove it before dedup and task-building, and print:
   `Skipping {rule_id} {file}:{symbol} — suppressed in .shipwright/suppressions.yml ({status}: {reason})`
   This message is distinct from the "task already active" message in 6.2. If a rule group is
   left empty, drop the group; if no groups remain, print the Step 3 "No PR-worthy findings"
   message and stop.

---

## Step 4: Dry-Run Output (if --dry-run)

If `--dry-run` was passed, print a preview and stop without querying or writing to the task
store and without recording a run:

```
ENTROPY FIX — DRY RUN — {org/repo}

Would queue {N} tasks:

  1. entropy-{rule-id}-{repo-slug}-{YYYY-Www}
     Rule: {rule.description} ({severity})
     Route: {auto|review|plan} — {one-line reason, per Step 6.1}
     Findings: {count} instances
     Files: {list of unique file paths}

  2. ...

No tasks written to task store. No run recorded.
Re-run without --dry-run to queue tasks.
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

## Step 6: Route and Queue Tasks

Queueing is the only mode. Run this workflow for every run.

### 6.1 Route each finding group (auto / review / plan)

Every rule group gets exactly one route. The route comes from the rule's `**HITL:**` field in
the principles map loaded in Step 2 (the single source of truth — do not keep a duplicate
table here) plus, for `per-finding` rules, a judgment on the specific group. There is no
numeric backstop: no file-count or line-count threshold ever forces a route.

- **auto** — the fix is obvious: `kind: "dev"`, `status: "pending"`, `hitl: false`. Agents
  scoped to the repo execute it through the normal loop. Criteria:
  - `**HITL:** never` rules — `dead_exports`, `unreferenced_files`, `commented_out_blocks`
    (deletion/restoration is unambiguous by construction; these still pass the 6.3 cross-check).
  - `per-finding` rules (`duplicated_utility`, `architecture_layering`) where the fix is a
    clear, mechanical, single-approach move: a single obvious call site, a clear drop-in
    replacement with matching behavior, or a trivial one-line move up into an **existing**
    service method.
- **review** — the fix needs one human decision, then one agent PR: `kind: "dev"`, created
  `status: "blocked"` with `blockedReason` starting `needs-review:` and holding the specific
  question for the human. The existing per-finding HITL criteria map here:
  - `per-finding` rules where the fix is ambiguous or multi-approach: behavior differs
    between the local copy and the shared lib, or there are multiple reasonable ways to
    consolidate or restructure the code.
  - `**HITL:** always` rules (`hardcoded_secrets`): a committed secret is compromised and must
    be rotated or revoked outside the codebase, which no agent can do. Ask: "Has the exposed
    credential been rotated/revoked? Unblock once done so the agent can remove it from code."
    Never auto-fix a secret.
  - A human answers, optionally edits the description, and calls `POST /tasks/{id}/unblock`;
    the task then enters `?ready=true` and agents execute it.
- **plan** — the work is bigger than one task: `kind: "prd"`, `hitl: true`, description = draft
  problem statement plus the findings. Criteria: the fix is multi-PR (spans more than one PR's
  worth of change, e.g. many modules or layers) or architectural (no service boundary exists
  yet to move the logic into, or it needs a new module or design decision). A human runs it
  through `/shipwright:prd` or `/shipwright:plan-session`, which produces agent-executable
  tasks; the autonomous plan phase skips it because it is `hitl: true`.

**Built-in tooling baseline findings** (`category: "tooling"`, rule ids `tooling_*`, produced
by `/entropy-scan` Step 3.2) are not in principles.md, so they skip the `**PR-worthy:**` /
`**HITL:**` lookup and the Step 6.3 cross-check, and use the `route` the scan stamped on each
finding. They are always one task per rule and never human-gated beyond the review route:

- **auto** — adding a config that matches the detected toolchain (linter, formatter, type
  checker), adding pre-commit hooks, or wiring existing lint/type-check commands into CI.
- **review** — turning on a stricter mode that may break the build (e.g. TypeScript `strict`):
  created blocked with `needs-review:` asking whether to enable it now and fix the fallout.

Dedup (6.2) applies unchanged, so re-running on an unchanged repo queues no duplicates. The
shared `scripts/entropy-baseline.ts` (`planBaselineTasks`) builds these task objects.

Use judgment for `per-finding` groups (you are the Claude agent running this skill), grounded
in the principle's prose; no default lean — judge each group on its own facts, at runtime.
Pre-filing verification Item 3 (a finding that can't be confirmed by a literal check) routes
to **review**. `hitl: true` is used only on the **plan** route's `kind: "prd"` task — never
`hitl: true` on a dev task, and this skill has no credential-rotation route of its own (that
exception belongs to security-fix; secrets here go to review).

### 6.2 Dedup Check

The `repo` value is the `--repo` argument, unchanged (e.g. `app-vitals/shipwright`), and is
also the task JSON's `repo` field in 6.4. `repo-slug` is its last path segment, lowercased.

Run (URL-encode the repo, e.g. `app-vitals%2Fshipwright`). `GET /tasks` defaults to
`limit=50` and truncates silently unless the caller raises it — pass an explicit high
`limit=1000` on every query. Review tasks are created `blocked`, so query all three active
statuses (`status=pending`, `status=in_progress` and `status=blocked`):
```bash
for status in pending in_progress blocked; do
  curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=$status&repo={url-encoded-repo}&limit=1000" | jq .
done
```

The `&repo=` filter scopes dedup to tasks for the repo being fixed.

**Pagination guard — do not silently proceed with a partial result set.** `limit=1000`
covers the common case, but a repo can still have more than 1000 active tasks. After each call, check the response's `nextCursor`: if it is `null`, the page is complete. If it is a string,
the first `limit=1000` page did not cover every active task — re-run the same query with
`&cursor=<nextCursor>` (the opaque string from the previous response; never parse or build one)
and merge the `.tasks` arrays, repeating until `nextCursor` is `null`. Only treat the dedup
query as complete once every page has been fetched this way; never build the "already active"
set (below) from a page that fails this check.

Parse all `.tasks` arrays. From the combined results, collect tasks where:
- `source == "shipwright"` or `source == "entropy-fix"`, OR
- `title` starts with `"Entropy fix:"`

Extract the rule IDs from existing tasks by parsing the `id` field (format:
`entropy-{rule-id}-{repo-slug}-{YYYY-Www}`) or from the `branch` field (format:
`fix/entropy-{rule-id}-...`). Build a set of "already active" rule IDs.

For each rule group: if its `rule_id` is in the "already active" set, skip it. Print: `Skipping {rule_id} — task already active`.

Keep the `.tasks` arrays in memory — the task-store cross-check in 6.3 reuses them.

### 6.3 Task-Store Cross-Check (dead-code deletion findings)

Before enqueueing any finding for a **deletion** rule — `dead_exports`, `unreferenced_files`,
or `commented_out_blocks` — cross-check it against the pending and in-progress tasks already
fetched in 6.2. This prevents deleting code that another queued task is about to depend on.
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

### 6.4 Build Task JSON

For each remaining rule group, build a task object using the shape for its route. Reuse the
`repo` and `repo-slug` values from 6.2. Every task — all three routes — carries
`originKind: "cron"`, `originRef: "entropy-patrol"` and `repo`.

**auto:**
```json
{
  "id": "entropy-{rule-id}-{repo-slug}-{YYYY-Www}",
  "title": "Entropy fix: {rule.description}",
  "source": "entropy-fix",
  "originKind": "cron",
  "originRef": "entropy-patrol",
  "repo": "<repo, from --repo>",
  "kind": "dev",
  "branch": "fix/entropy-{rule-id}-{short-description}",
  "layer": "Shared",
  "status": "pending",
  "hitl": false,
  "description": "<findings summary — see below>"
}
```

**review** — same as auto, but created blocked with the question (never `hitl: true`):
```json
{
  "status": "blocked",
  "blockedReason": "needs-review: <the specific question for the human>",
  "hitl": false
}
```

**plan** — a `kind: "prd"` task, `hitl: true` (no branch):
```json
{
  "id": "entropy-{rule-id}-{repo-slug}-{YYYY-Www}",
  "title": "Entropy plan: {rule.description}",
  "source": "entropy-fix",
  "originKind": "cron",
  "originRef": "entropy-patrol",
  "repo": "<repo, from --repo>",
  "kind": "prd",
  "layer": "Shared",
  "status": "pending",
  "hitl": true,
  "description": "<draft problem statement, then the findings summary>"
}
```

The `description` field must give dev-task (or the human planning it) enough context to act
without re-reading the handoff file:
```
Entropy patrol finding: {rule.id} — {rule.description} ({rule.severity})

Findings ({count} total):
- {file_path}:{line} — {finding_description}
{Include ALL findings that survived the 6.3 cross-check. If there are more than 20, include the first 20 and append: "(+N more — re-run /entropy-fix to see all)"}

Fix guidance: {entry's **Detection:** field, or remediation guidance from the principles file}

Rule: {rule.id} | Severity: {rule.severity} | Domain: {rule.domain} | Route: {auto|review|plan}
```

The `{repo-slug}` segment namespaces the task ID per repo so the same rule scanned in two
different repos in the same week never collides.

The `{YYYY-Www}` suffix in the task ID uses ISO week format. Compute from the current date:
- Year: 4-digit year
- `W`: literal `W`
- Week number: 2-digit zero-padded ISO week number (01–53)
- Example: `entropy-dead_exports-shipwright-2026-W23`

`short-description`: lowercase, hyphens, max 5 words from rule.description.

### 6.5 Write and Append

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

Count the tasks the store accepted per route: `auto`, `review`, `plan`.

### 6.6 Print Summary

```
ENTROPY FIX — QUEUED — {org/repo}

  QUEUED    {N} tasks   ({A} auto, {R} review, {P} plan)
  SKIPPED   {N} rule groups (already active)
  DEFERRED  {N} findings (referenced by pending/in-progress tasks)

Tasks queued:
  entropy-{rule-id}-{repo-slug}-{YYYY-Www} — {rule.description}  [route: {auto|review|plan}]
  ...

{If any skipped:}
Skipped (already active):
  {rule_id} — task already in queue, blocked for review, or in progress

{If any suppressed:}
Skipped (suppressed in .shipwright/suppressions.yml):
  {file}:{symbol} — {status}: {reason}

{If any deferred by cross-check:}
Deferred (referenced by existing task):
  {file}:{symbol} — referenced by task {task-id}

Auto tasks run via the normal dev loop. Review tasks wait for a human to answer and unblock.
Plan tasks wait for /shipwright:prd or /shipwright:plan-session.
```

Then record the run (Step 7). The summary above is the final output.

---

## Step 7: Record the run

Record exactly one run for this `entropy-patrol` task — never under `--dry-run`. Build a
result file from the handoff and the routing outcome:

```json
{
  "outcome": "ok",
  "metrics": {
    "findings": 12, "suppressed": 2, "high": 1, "medium": 6, "low": 5,
    "auto": 3, "review": 1, "plan": 1, "skipped": 0, "deferred": 0
  }
}
```

`outcome` is `ok` when anything was queued or the scan found open items, `no_op` when the scan
found nothing and nothing was queued, and `failed` when the run errored (include `"error": 1`
in metrics). `auto`, `review` and `plan` are separate counts of tasks queued per route.
Then:

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" record --cron entropy-patrol --repo {org}/{repo} \
  --commit {handoff.commitSha} --result /tmp/entropy-result.json \
  --legacy-shape entropy-patrol-last-run
```

Add `--task {SC-…task id}` when the run was dispatched from a system-cron task.

**One-time legacy import.** Only when the task store has no prior run for this repo and the
agent-local `state/entropy-patrol-last-run.json` holds an entry for it, the recorder carries
that entry into this first run and deletes the legacy file after the post succeeds. This is the
only place this skill touches that file, only through the recorder's `--legacy-shape` flag —
never read, write or delete it directly.

---

## Error Handling

- **Task-store query fails** (dedup/cross-check in 6.2): record a `failed` run (Step 7) and
  stop. Do not queue tasks without a dedup + cross-check pass, or you risk duplicate tasks and
  deleting code a pending task depends on.
- **Bulk append fails** (`/tasks/bulk` non-2xx): log the response body, record a `failed` run
  and stop. Do not retry blindly; re-running the skill is idempotent because the dedup check
  will skip already-queued rules.
- **No PR-worthy findings**: handled in Step 3 — print the "nothing to queue" message, record a
  `no_op` run (not under `--dry-run`) and stop.
- **More than 10 groups**: cap at 10 as described in Step 5. Always queue highest-severity first.

---

## Constraints (Do Not Violate)

- **`--repo` is required.** Missing it is a usage error.
- **One task per rule** — never bundle multiple rule violations into one task.
- **Three routes only** — every task is auto, review or plan per Step 6.1. Never `hitl: true` on a dev task; `hitl: true` only on a plan route `kind: "prd"` task.
- **Stamp provenance** — every follow-on task carries `originKind: "cron"`, `originRef: "entropy-patrol"` and `repo`.
- **Queue only** — this skill never opens PRs and never edits code. It only writes tasks to the task store; the actual fix lands later via the dev loop or a human plan.
- **Cross-check before deletion** — never enqueue a `dead_exports` / `unreferenced_files` /
  `commented_out_blocks` finding without running the 6.3 task-store cross-check first.
- **No cascade** — only queue what's in the current handoff. Do not re-scan during a run.
- **No principles.md changes** — the fix skill enforces principles, it does not modify them,
  and it reads the `**HITL:**` classification from principles.md rather than duplicating it.
- **No local state** — no `state/` file is read or written except the Step 7 one-time import.

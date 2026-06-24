---
name: entropy-fix
description: Read entropy-report.md, fix pr_worthy violations, and open targeted PRs. One PR per concern. Requires entropy-scan to have run first.
---

# Entropy Fix

Read the latest `entropy-report.md` and open focused, human-reviewable PRs for `pr_worthy` violations. Each PR fixes one rule — no bundled concerns, max 3 files changed per PR.

**Prerequisites:** Run `/entropy-scan` first to produce `entropy-report.md`.

---

## Setup: Parse Arguments

Before starting, check for flags:

- `--dry-run` — print what PRs would be opened without creating branches, making changes, or creating PRs
- `--rule {id}` — fix only violations of a specific rule ID (e.g., `--rule dead_exports`)
- `--queue` — instead of opening PRs, push findings as tasks to the task store (via the task store API). Enables automated deferred fixing.

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

## Step 2: Load Golden Principles

Load the same golden principles config that the scan used:

1. Check `.claude/entropy-patrol/golden-principles.yaml` in the project root. If it exists, load it.
2. Otherwise, load the plugin default: `skills/entropy-scan/golden-principles.yaml`.
3. Build a map of `rule_id → rule` for quick lookup (needed for `pr_worthy` status and PR body generation).

---

## Step 3: Filter and Group Findings

1. Parse the report's `## Findings` section. Collect all unchecked (`- [ ]`) findings.
2. Filter to only findings whose rule has `pr_worthy: true` in the golden principles config.
3. If `--rule` flag was passed, further filter to only that rule's findings. If no findings match that rule ID, print: "No unchecked findings for rule `{rule_id}`. Nothing to fix." and stop.
4. Group findings by `rule_id`. One PR will be opened per group.
5. Sort groups: high-severity rules first, then medium, then low.
6. If no `pr_worthy` unchecked findings exist, print:
   ```
   No pr_worthy findings to fix. All violations are either:
   - Already checked off (fixed)
   - In categories marked pr_worthy: false (fix manually)
   Run /entropy-scan to refresh the report.
   ```
   Then stop.

---

## Step 4: Dry-Run Output (if --dry-run, without --queue)

If `--dry-run` was passed **and `--queue` was NOT passed**, print a preview and stop:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENTROPY FIX — DRY RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Would open {N} PRs:

  1. fix/entropy-{rule-id}-{short-description}
     Rule: {rule.description} ({severity})
     Findings: {count} instances
     Files affected: {list of unique file paths}

  2. ...

No branches created. No files changed. No PRs opened.
Re-run without --dry-run to execute.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing.

---

## Step 4b: Queue + Dry-Run Preview (if --queue AND --dry-run)

If both `--queue` and `--dry-run` were passed, print a preview and stop:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENTROPY FIX — QUEUE DRY RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Would queue {N} tasks:

  1. entropy-{rule-id}-{YYYY-Www}
     Rule: {rule.description} ({severity})
     Findings: {count} instances
     Files: {list of unique file paths}

  2. ...

No tasks written to task store.
Re-run with --queue (without --dry-run) to queue tasks.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing.

---

## Step 5: Cap Check

If there are more than 10 rule groups to fix, note:

```
Found {N} rules with pr_worthy findings. Capping at 10 PRs per run.
Fixing highest-severity rules first. Re-run after merging to continue.
```

Process only the first 10 groups (sorted by severity).

---

## Step 6: Queue Tasks (if --queue)

If `--queue` was passed, run this workflow instead of Steps 6a-6e.

### 6q.1 Dedup Check

Run:
```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=pending" | jq '.tasks'
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=in_progress" | jq '.tasks'
```

Parse both `.tasks` arrays. From the combined results, collect tasks where:
- `source == "shipwright"`, OR
- `title` starts with `"Entropy fix:"`

Extract the rule IDs from existing tasks by parsing the `id` field (format: `entropy-{rule-id}-{YYYY-Www}`) or from the `branch` field (format: `fix/entropy-{rule-id}-...`). Build a set of "already active" rule IDs.

For each rule group: if its `rule_id` is in the "already active" set, skip it. Print: `Skipping {rule_id} — task already active`.

### 6q.3 Build Task JSON

For each remaining rule group, build a task object:

```json
{
  "id": "entropy-{rule-id}-{YYYY-Www}",
  "title": "Entropy fix: {rule.description}",
  "source": "shipwright",
  "repo": "<detected from git remote get-url origin — strip https://github.com/ prefix>",
  "branch": "fix/entropy-{rule-id}-{short-description}",
  "layer": "Shared",
  "status": "pending",
  "addedAt": "<current ISO timestamp>",
  "description": "<findings summary — see below>"
}
```

The `description` field must give dev-task enough context to fix without re-reading entropy-report.md:
```
Entropy patrol finding: {rule.id} — {rule.description} ({rule.severity})

Findings ({count} total):
- {file_path}:{line} — {finding_description}
{Include ALL findings. If there are more than 20, include the first 20 and append: "(+N more — re-run /entropy-fix to see all)"}

Fix guidance: {rule.detection_hint or remediation guidance from the golden principles config}

Rule: {rule.id} | Severity: {rule.severity} | Category: {rule.category}
```

The `{YYYY-Www}` suffix in the task ID uses ISO week format. Compute from the current date:
- Year: 4-digit year
- `W`: literal `W`
- Week number: 2-digit zero-padded ISO week number (01–53)
- Example: `entropy-dead_exports-2026-W23`

`short-description`: lowercase, hyphens, max 5 words from rule.description.

### 6q.4 Write and Append

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

### 6q.5 Print Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENTROPY FIX — QUEUED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  QUEUED   {N} tasks
  SKIPPED  {N} rule groups (already active)

Tasks queued:
  entropy-{rule-id}-{YYYY-Www} — {rule.description}
  ...

{If any skipped:}
Skipped (already active):
  {rule_id} — task already in queue or in progress

Run /shipwright:dev-task to execute.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing. Do NOT run Steps 6a-6e (branch creation, PR opening) in queue mode.

---

## Step 6 (PR Mode): Fix Each Group

If `--queue` was NOT passed, run the PR workflow for each group (one rule at a time, sequentially — never parallel):

### 6a. Confirmation Gate for High-Severity Destructive Fixes

If the rule severity is `high` AND any finding involves deleting code (not just adding tests, moving functions, or renaming — specifically removing existing logic), print:

```
⚠️  HIGH-SEVERITY DESTRUCTIVE FIX
Rule: {rule.id} — {rule.description}
Findings:
  - {file}:{line} — {description}
  ...

This fix involves removing existing code. Confirm to proceed? (yes/no)
```

Wait for confirmation. If the answer is not `yes`, skip this group and note it in the final summary.

### 6b. Branch Check

Check if branch `fix/entropy-{rule-id}-{short-description}` already exists (locally or remotely):
- Construct short-description: lowercase, hyphens, max 5 words from rule.description
- If branch exists, skip this group. Print: "Branch `fix/entropy-{rule-id}-...` already exists — skipping. Merge or delete it first."

### 6c. Create Branch and Make Fixes

1. Create branch from base: `git checkout main && git checkout -b fix/entropy-{rule-id}-{short-description}`
2. For each finding in this group:
   - Apply the fix described by the rule's `detection_hint` remediation guidance
   - Keep changes focused: only fix what the finding describes. Do not refactor surrounding code.
   - Blast radius cap: if this group has more than 3 unique files to modify, fix the 3 highest-severity or most clearly scoped findings and note the rest as "deferred — re-run after merge"
3. Commit: `fix(entropy): resolve {rule.id} — {finding_count} instance(s)`

### 6d. Open PR

Run:
```
gh pr create \
  --title "fix(entropy): {rule.description} ({finding_count} instance(s))" \
  --body "..." \
  --base main
```

PR body format:
```markdown
## Entropy Fix: {rule.description}

**Golden Principle:** `{rule.id}` ({rule.severity})
**Findings fixed:** {count}

### What was changed
{bullet list: `file_path:line` — one-line description of change}

### Why this matters
{rule.description — explain the principle being enforced and why drift here costs the team}

### Review notes
{Any caveats: "N instances auto-fixed; M flagged as needs-human-review and left as comments"}
{If blast radius cap applied: "N additional findings deferred — re-run /entropy-fix after merge"}

---
_Generated by [shipwright](https://github.com/app-vitals/shipwright). Review carefully before merging._
```

### 6e. Update entropy-report.md

After the PR is opened successfully, go back to the base branch and update `entropy-report.md`:
- Check off the fixed findings: change `- [ ]` to `- [x]` for each finding that was addressed in this PR
- Add a note below each checked finding: `_(fixed in PR #{pr_number})_`

### 6f. Log PR Result

Record the result for the final summary (success, skip, or failure with reason).

---

## Step 7: Return to Base Branch

After processing all groups, run `git checkout {original-branch}` to return to where you started.

---

## Step 8: Print Final Summary

> **Note:** In `--queue` mode, execution stops at Step 6q.5 and this Step 8 summary is not printed. The queue summary is the final output.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENTROPY FIX COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  OPENED    {N} PRs
  SKIPPED   {N} groups (branch exists or no-confirm)
  FAILED    {N} PRs (see below)

PRs opened:
  #{pr_number} — {rule.id}: {title}
  ...

{If any failures:}
Failures (fix manually):
  {rule.id} — {reason}

{If any deferred findings:}
Deferred findings (run /entropy-fix again after merging open PRs):
  {rule.id} — {N} remaining findings

entropy-report.md updated with fixed findings checked off.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Error Handling

- **`gh pr create` fails**: Log the failure, continue to the next group. Do not abort the run.
- **Branch creation fails** (e.g., git conflict): Log and skip this group. Include in final summary under failures.
- **Fix attempt produces no diff**: Don't commit an empty change. Skip and note: "No diff produced for {rule.id} — may already be fixed. Check entropy-report.md."
- **More than 10 groups**: Cap at 10 as described in Step 5. Always process highest-severity first.

---

## Constraints (Do Not Violate)

- **One PR per rule** — never bundle multiple rule violations into one PR.
- **3-file blast radius cap** — never modify more than 3 files in a single PR.
- **No auto-merge** — PRs always require human review before merge.
- **No cascade** — only fix what's in the current `entropy-report.md`. Do not re-scan during a fix run.
- **Sequential branches** — create branches one at a time. Parallel branch creation causes git conflicts.
- **No golden-principles.yaml changes** — the fix skill enforces rules, it does not modify them.
- **Confirmation required for high-severity destructive ops** — never skip this gate.

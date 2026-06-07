---
name: test-publish
description: >
  Phase 5 of the test-readiness pipeline. Publishes the approved `test-readiness-plan.md` to GitHub as a dashboard of issues — one per task — with milestones M1-M5, consistent labels, dependency edges, and a parent tracking issue. Makes the roadmap programmable: `gh issue list --search "label:test-readiness label:ready sort:created-asc" --limit 1` returns the next workable item with full context inline. Invoke when the `/test-publish` command runs.
---

# test-publish skill

## Purpose

Turn the static roadmap markdown into a live, label-filterable GitHub issue dashboard. Each issue is self-contained so a developer (or `claude code`) can pick one without context-switching to read external docs.

## When invoked

By the `/test-publish` command. Requires `docs/test-readiness/test-readiness-plan.md`.

## Process

### Step 1 — preflight

1. Read `docs/test-readiness/test-readiness-plan.md`. Abort if missing.
2. Parse the task list. Each row should yield: `id`, `milestone`, `files`, `layer`, `bucket`, `outcome`, `verify`. Reject if task list is malformed.
3. Detect target repo: `gh repo view --json nameWithOwner -q .nameWithOwner` (or use `--repo`). Abort if `gh` not authenticated.
4. List existing issues with the `test-readiness` label to detect which task IDs are already published. Compare against the parsed task list. Compute "new" set.

### Step 2 — confirm scope with user

Print a summary:
- Target repo: `owner/name`
- Milestones to create: list new ones (skip existing)
- Labels to create: list new ones (skip existing)
- Issues to create: count + per-milestone breakdown
- Tracking issue: create or update existing

Wait for explicit confirmation. Skip the wait when `--dry-run` (just print) or
when `--yes` is passed (print the summary, then proceed to create for real
without prompting — used by the unattended `shipwright-test-readiness` cron).

### Step 3 — ensure labels exist

Required label set (color hints in parens):

| Label | Purpose | Color |
|---|---|---|
| `test-readiness` | umbrella | `0E8A16` (green) |
| `milestone:m1` ... `milestone:m5` | which phase | `1D76DB` (blue) |
| `layer:unit` / `layer:integration` / `layer:smoke` / `layer:e2e` / `layer:infra` / `layer:doc` / `layer:repo-config` / `layer:meta` | test layer (`doc`/`repo-config`/`meta` cover documentation, repo settings, and meta tasks) | `5319E7` (purple) |
| `bucket:reuse` / `bucket:promote` / `bucket:rebuild` / `bucket:delete` / `bucket:net-new` | migration bucket | `FBCA04` (yellow) |
| `criticality:critical` / `criticality:high` / `criticality:medium` | priority | `D93F0B` (orange) |
| `ready` | no unmet deps | `0E8A16` (green) |
| `blocked` | waiting on predecessors | `B60205` (red) |

Create any missing label via `gh label create <name> --color <hex> --description "<desc>"`. Existing labels are not modified.

### Step 4 — ensure milestones exist

For each of M1–M5, check `gh api repos/:owner/:repo/milestones?state=all` for an existing title match. If missing, create:

```
gh api repos/:owner/:repo/milestones -f title="M1 — Infrastructure baseline" \
  -f description="Runners, local substitutes, CI pipeline shape. No new tests."
```

Use these canonical titles:

- `M1 — Infrastructure baseline`
- `M2 — Critical-path coverage`
- `M3 — Canary suite live`
- `M4 — High-tier coverage`
- `M5 — Cleanup`

### Step 5 — create issues from the task list

For each task in the parsed task list:

1. Resolve dependency state: a task is `ready` iff every predecessor task ID is either (a) not in the publish set, or (b) already closed. Otherwise `blocked`.
2. Build the issue body from `${CLAUDE_PLUGIN_ROOT}/assets/templates/issue.md.tmpl`. Substitute all fields, including the hidden `<!-- task-id: T-NNN -->` marker (used for idempotency on re-runs). The template's **Closing Checklist** section (per `${CLAUDE_PLUGIN_ROOT}/skills/repo-config/SKILL.md`) is mandatory — it converts the verification command from a suggestion into a mergeable gate.
3. Build label set: `test-readiness`, `milestone:m<N>`, `layer:<layer>`, `bucket:<bucket>`, `criticality:<criticality>`, and `ready` or `blocked`.
4. Resolve context links — anchors in the artifact files. Format: `<repo-url>/blob/<sha>/docs/test-readiness/test-inventory.md#<anchor>`. Use the current HEAD sha so the links are immutable.
5. Create the issue:
   ```
   gh issue create \
     --title "[<layer>] <outcome-shortened> (T-NNN)" \
     --milestone "M<N> — <name>" \
     --label "<labels>" \
     --body-file <temp-file>
   ```
6. Record the resulting issue number against the task ID.

### Step 6 — create or update the tracking issue

Template at `${CLAUDE_PLUGIN_ROOT}/assets/templates/tracking-issue.md.tmpl`. Body contains:
- Roadmap summary (sections 1–3 of the plan)
- Per-milestone checkbox list of child issues, linked by number
- Speed delta table
- Open risks

Title: `Test Readiness Roadmap`. Label: `test-readiness`, `tracking`. Pin via `gh issue pin <number>` (best-effort — not all repos allow this; non-fatal on failure).

If a tracking issue already exists (search by title + label), update its body via `gh issue edit <number> --body-file <temp-file>`.

### Step 7 — write the traceability artifact

Write `docs/test-readiness/test-readiness-issues.md` with:
- Tracking issue: `#NNN`
- Per-task table: `T-NNN | issue #M | status | url`

This file is the local mirror of what's in GitHub, useful when working offline or for diffing on re-runs.

### Step 8 — report

Print a summary to the user:
- N issues created
- K issues already existed (skipped)
- Tracking issue: `#NNN`
- Suggested next command: `gh issue list --search "label:test-readiness label:ready sort:created-asc" --limit 1`

## Refresh mode (`--refresh`)

Skip steps 5–6 (no new issues). Instead:

1. For each open issue with the `test-readiness` label, parse its predecessor list from the body.
2. If all predecessors are closed → ensure the issue has `ready` label, not `blocked`.
3. If any predecessor is open → ensure `blocked`, not `ready`.
4. Update the tracking issue's checkboxes (check items whose underlying issues are closed).

Use `gh issue edit <n> --add-label ready --remove-label blocked` (or reverse).

## Dry-run mode (`--dry-run`)

Steps 1–4 run as normal but emit "would create" lines instead of API calls. No labels, milestones, or issues are created. Use for review before committing.

## Auto-confirm mode (`--yes`)

Runs the full publish (steps 1–8) but skips the Step 2 confirmation wait. The
scope summary is still printed for the log. Intended for the unattended
`shipwright-test-readiness` cron, which cannot answer an interactive prompt.
Idempotency (the `<!-- task-id -->` dedup) makes repeated unattended runs safe.

## Failure modes to avoid

- **Don't double-publish.** Task IDs are matched against the hidden `<!-- task-id: T-NNN -->` comment in existing issues. Re-running creates only new tasks.
- **Don't ship "ready" labels by default.** Compute dependency state per-task. The first published task in each milestone is usually `ready`; everything depending on it is `blocked` until it closes.
- **Don't omit context links.** The whole point of the dashboard is self-contained issues. Each must link back to the inventory / system / migration sections that explain *why* the task exists.
- **Don't pin the tracking issue silently.** Pinning can fail (repo settings, permissions). Report failure clearly but don't abort.
- **Don't run without explicit user confirmation, unless `--yes` is passed.** This is the only command in the plugin that writes outside the repo — confirmation is mandatory for interactive runs. `--yes` is the sanctioned bypass for the unattended cron; never assume confirmation otherwise.

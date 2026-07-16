# Backfill Mode (`--backfill-from-github [--repo owner/name]`)

A genuinely separate, one-time migration path — it does not run Steps 1–7 of the main
`SKILL.md` (the regular plan-parsing flow). It operates purely off existing GitHub issue
state, since a fresh `test-readiness-plan.md` may not exist in the target repo, or may have
since diverged from what was originally published by the former GitHub-issue publish skill.

Use this once, per repo, to migrate issues the former GitHub-issue publish skill already
created into task-store tasks, then retire the GitHub side of those specific issues (closing
them with a link back to the task store). Ordinary tasks going forward come from the regular
flow (Steps 1–7 in `SKILL.md`) against a current `test-readiness-plan.md`.

### B1: Detect Target Repo

Use `--repo owner/name` if passed. Otherwise detect via `git remote get-url origin`, same
derivation as Step 3 of `SKILL.md`. Derive `repo-slug` the same way.

### B2: List Open test-readiness Issues

```bash
gh issue list --repo {owner/name} --label test-readiness --state open \
  --json number,title,body,labels --limit 500
```

If none are returned, print `No open test-readiness-labeled issues found in {owner/name}.
Nothing to backfill.` and stop.

### B3: Parse Each Issue

For each issue, parse:
- The hidden `<!-- task-id: T-NNN -->` marker from the body (per `issue.md.tmpl`). If absent,
  skip the issue and note it in the final summary as `skipped (no task-id marker)`.
- Milestone from the issue's `milestone:m{N}` label → maps to the same milestone name used in
  `SKILL.md` Step 5.3.
- Layer from the `layer:{unit|integration|smoke|e2e|infra}` label.
- Bucket from the `bucket:{reuse|promote|rebuild|delete|net-new}` label.
- Criticality from the `criticality:{critical|high|medium}` label → this is the `priority`
  field directly (no milestone-derived default needed here — the label already carries it).
- "Requires #N" predecessor lines from the body's `## Dependencies` section — each is a
  GitHub issue number referencing another `test-readiness`-labeled issue.

### B4: Resolve Predecessors and Ordering

Since predecessor references in GitHub issues are issue numbers, not task-store IDs, process
issues in an order that resolves predecessors before dependents: topological by milestone
(M1 before M2 before M3 before M4 before M5), and within a milestone, by `ready` label before
`blocked` label (an issue only labeled `ready` has no open predecessors, so it can't need a
not-yet-created task-store ID).

Maintain an in-memory map of `issue number → newly-created task-store ID` as each task is
created (B5), so later issues in the processing order can resolve their "Requires #N" lines
to the correct `dependencies` entries.

If a "Requires #N" reference points at an issue outside the fetched open set (e.g. it's
already closed, or it's a non-test-readiness issue), resolve it to `test-{t-nnn}-{repo-slug}`
by parsing the referenced issue's own `<!-- task-id: T-NNN -->` marker (fetch it via
`gh issue view {N} --json body` if needed) rather than skipping the dependency edge —
preserving the edge is the point of the migration, per the acceptance criteria's "preserving
dependency edges."

### B5: Create the Task-Store Task

Use the **same field mapping as Step 5** in `SKILL.md`, sourced from the issue instead of a
plan row:

```json
{
  "id": "test-{t-nnn}-{repo-slug}",
  "title": "Test readiness: {outcome, from issue title minus the [layer]/(T-NNN) decoration} (T-NNN)",
  "source": "shipwright",
  "repo": "<owner/name>",
  "branch": "feat/test-{t-nnn-lower}-{slug}",
  "layer": "<layer from B3>",
  "priority": "<criticality from B3>",
  "type": "test-readiness",
  "status": "pending",
  "hitl": <true | false — same classification rules as 5.2, applied to the issue's content>,
  "dependencies": ["test-{predecessor-t-nnn}-{repo-slug}", "..."],
  "acceptanceCriteria": ["<parsed from the issue's Acceptance criteria checklist>", "Verification command `{verify}` passes"],
  "description": "<same shape as 5.3, sourced from the issue body's Expected outcome / Files to touch / Audit decisions / Context sections>"
}
```

POST each task individually or batch via `/tasks/bulk` (same call shape as Step 7.1) as they
resolve — batching per milestone is fine since ordering only matters across milestones, not
within the same POST.

### B6: Close the Migrated Issue

Immediately after a task-store task is created for an issue, close it:

```bash
gh issue close {n} --comment "Migrated to Shipwright Task Store as {task-id}. This pipeline no longer publishes to GitHub Issues — see docs/test-readiness/test-readiness-plan.md and the task store for live status."
```

Close issues one at a time as their tasks are created — do not batch all closes to the end —
so a mid-run failure leaves a consistent state (every closed issue has a corresponding
task-store task; no issue is closed without one).

### B7: Print Backfill Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEST FIX — BACKFILL COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  MIGRATED  {N} issues → task-store tasks (closed on GitHub)
  SKIPPED   {K} issues (no task-id marker)

Migrated:
  #{n} → test-{t-nnn}-{repo-slug} — {outcome}

{If any skipped:}
Skipped (no task-id marker):
  #{n} — {title}

Backfill is one-time per repo. Future tasks come from /test-fix against a current
docs/test-readiness/test-readiness-plan.md.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Error Handling (Backfill-Specific)

- **`gh` not authenticated or repo unreachable**: log the failure and stop before creating or
  closing anything.
- **Issue missing its `<!-- task-id: T-NNN -->` marker**: skip that issue, note it in the
  summary (B7), and do not close it — closing an unmigrated issue would lose its work with no
  task-store equivalent created.
- **Bulk append fails** (`/tasks/bulk` non-2xx): log the response body and stop. A partial run
  is safe to re-run — already-closed issues are no longer in the open set fetched by B2, so
  they won't be reprocessed.

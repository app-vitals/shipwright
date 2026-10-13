---
name: prompt-fix
description: Read the prompt-audit ledger and queue proposed findings as propose-only task-store tasks, one task per finding. Every task is hitl true unless a human-promoted rule qualifies under a deterministic policy. Requires prompt-scan to have run first.
---

# Prompt Fix

Turn `proposed` findings in `state/prompt-audit-ledger.json` into task-store tasks whose
bodies carry the evidence, the projected metric, the measurement plan, the blast-radius
report and the list of things the PR must prove, so no markdown change merges on a
hypothesis. Findings never become direct edits or PRs; they always become tasks that a
human (via `/shipwright:hitl`) or, for a promoted rule, `dev-task` picks up later.

This mirrors `entropy-fix` and `consolidation-fix` for the cap, dedup and bulk POST, and
is deliberately **stricter on `hitl`**: those skills let the model judge mechanical fixes.
Prose has no compiler and a regression is silent, so here `hitl` is computed by
`scripts/prompt-audit/hitl-policy.ts`, never judged. **The launch posture is propose-only:
every task is `hitl: true`.**

**Prerequisites:** run `/prompt-scan` first to produce the ledger and
`prompt-audit-report.md`.

> **Task store setup:** this skill reads and writes the Shipwright task store. If
> `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke
> `/shipwright:task-store` for setup instructions.

---

## Setup: Parse Arguments

- `--dry-run` — print every task that would be queued, with its full body, and write
  nothing to the task store or the ledger
- `--class <a-f>` — consider only findings of this class (`a`, `b`, `c`, `d`, `e` or `f`)
- `--finding <fp>` — consider only the finding whose fingerprint matches (full or
  unambiguous prefix; if the prefix matches several, list them and stop)

Queueing is the only mode. There is no PR mode.

---

## Step 1: Verify the Report Exists

1. Look for `prompt-audit-report.md` in the project root and `state/prompt-audit-ledger.json`.
2. If either is missing, print:
   ```
   No prompt-audit-report.md / ledger found. Run /prompt-scan first to generate them.
   ```
   Then stop.
3. Parse the ledger. If it is unparseable or has no `findings` object, stop and report
   the error; never overwrite a ledger you could not read.

---

## Step 2: Filter to `proposed` Findings Only

1. Keep ledger entries with `status: proposed`. Ignore `tracking`, `suppressed`,
   `queued`, `measured`, `regressed` and `resolved` entries.
2. Apply `--class` and `--finding` if passed. If `--finding` matches nothing, print
   "No proposed finding with fingerprint `{fp}`. Nothing to queue." and stop.
3. If nothing remains, print "No proposed findings. Nothing to queue." and stop.

---

## Step 3: Re-Check the Decisions Registry Live (Decisions and Autonomy Entries)

The registry can change after the scan ran, so never trust the ledger's `proposed` status
as still current. See `references/decisions-registry.md` for the shared pattern.

1. Read `.claude/shipwright/prompt-audit-decisions.md`. A missing file means "no
   suppressions configured and no promoted rules": continue with empty lists.
2. **Decisions.** For each remaining finding, compare its rule id and file to each
   entry's **Finding** field (a judgment match, as in `prompt-scan`). A match whose
   **Revisit** condition is not met drops the finding. Print
   `Skipping {fp} — accepted per prompt-audit-decisions.md ("{name}")`.
3. **Autonomy entries.** Collect `**Autonomy:** <rule>, <evidence>` lines. Only a human
   writes these. They are inputs to the Step 10 policy and the only route to `hitl: false`.
   Entries are read, never written.

---

## Step 4: Pre-Filing Verification

Apply `references/pre-filing-verification.md` (relative to the plugin root) to every
surviving finding. The ledger is a snapshot, so re-read the live file:

1. Check that `file:line` still matches: open the finding's `file` at `line` (use `git show HEAD:<file>` or the working tree).
   If the file is gone, or the line no longer matches the finding's `evidence`, skip it:
   print `Skipping {fp} — stale, {file}:{line} no longer matches`. Leave it `proposed`
   in the ledger.
2. A finding whose evidence cannot be confirmed by a literal check is not filed
   autonomously; carry it forward with `replacementVerified: false` so the policy returns
   `hitl: true`.
3. Checklist item 4 (id and branch collisions) is covered by Step 9.

---

## Step 5: Cutover Freeze Check

Prompt edits must not be confounded with the model change. Refuse to file while the
cutover window is open: **PAU-2.3 is done and PAU-2.4 is not done**.

1. `GET $SHIPWRIGHT_TASK_STORE_URL/tasks/PAU-2.3` and `.../tasks/PAU-2.4` (task ids are
   global). "Done" means status `done` or `deployed`.
2. If PAU-2.3 is done and PAU-2.4 is not, print
   `Refusing to file: model cutover window open (PAU-2.3 done, PAU-2.4 not done). Prompt edits would be confounded with the model change.`
   and stop. This applies to `--dry-run` too, which prints the same refusal.
3. If either task does not exist in this task store, the freeze does not apply; continue.

---

## Step 6: Weekly Cap Check

At most **2 prompt-fix tasks open or merged this ISO week**, so each change is isolable in
the post-merge series.

1. Compute the current ISO week `{YYYY-Www}` and the repo (see Step 9).
2. Query each of `pending`, `in_progress`, `pr_open`, `approved`, `blocked`, `merged`,
   `deployed` and `done` with `&repo={url-encoded-repo}&limit=1000` and the pagination
   guard from Step 9. Count tasks whose `id` starts with `prompt-` and ends with
   `-{YYYY-Www}`. `cancelled` tasks do not count.
3. `remaining = 2 - count`. If `remaining <= 0`, print
   `Refusing to file: {count} prompt-fix tasks already open or merged in {YYYY-Www} (weekly cap 2).`
   and stop. Otherwise Step 8 files at most `min(10, remaining)` tasks.

---

## Step 7: Dry-Run Preview (if --dry-run)

If `--dry-run` was passed, run Steps 8 through 10 (ordering, cap, dedup queries and task
building are all read-only), print the preview, and stop before Step 11:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROMPT FIX — DRY RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Would queue {N} tasks (weekly cap leaves {remaining}):

  1. {task id}
     Title: {title}
     HITL: {true|false} ({reasons})
     Body:
     {the full body, exactly as Step 10 builds it}

  2. ...

No tasks written to the task store. Ledger not modified.
Re-run without --dry-run to queue tasks.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Step 8: Order and Cap at 10 Tasks per Run

1. Order the survivors: **class (c) first** (static-only, no eval needed), then by
   projected saving (`metrics.before - metrics.projectedAfter`, largest first) within
   and after class (c).
2. Keep at most **10 tasks per run**, and no more than the weekly `remaining` from Step 6.
3. Print the rest as `Deferred {fp} — over the per-run or weekly cap`; they stay
   `proposed` for the next run.

---

## Step 9: Dedup Against the Task Store

Detect the repo: `git remote get-url origin`, strip the `https://github.com/` or
`git@github.com:` prefix and the `.git` suffix (for example `app-vitals/shipwright`).
`repo-slug` is its last path segment, lowercased.

`GET /tasks` defaults to `limit=50` and truncates silently, so pass `limit=1000`:

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=pending&repo={url-encoded-repo}&limit=1000" | jq .
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=in_progress&repo={url-encoded-repo}&limit=1000" | jq .
```

**Pagination guard — never proceed with a partial result set.** After each call compare
`total` to `.tasks | length`. If `total > tasks.length`, repeat the query with
`&offset=1000`, `&offset=2000`, ... and merge until the summed length is `>= total`. Only
then build the "already active" set.

From the merged tasks keep those whose `id` starts with the `prompt-` prefix. A finding
is a duplicate when an active task's id contains its `{class}-{fp8}` segment (any week).
Print `Skipping {fp} — task already active ({id})` and leave the ledger entry alone.

---

## Step 10: Build Task JSON

For each remaining finding:

1. **Blast radius.** Run
   `bun run plugins/shipwright/scripts/prompt-audit/cli.ts blast --file {file} --json`
   and keep the full output. This is the report embedded in the body.
2. **Compute `hitl` with the policy, never by judgment.** Build the policy input and run
   ```bash
   echo '{input-json}' | bun run plugins/shipwright/scripts/prompt-audit/hitl-policy.ts
   ```
   which prints `{"hitl": bool, "reasons": [...]}`. Input fields: `rule`, `class`,
   `claim` (from the finding), `file`, `autonomyEntry` and `acceptedProposals` (Step 3),
   `replacementVerified` (Step 4), `cronCount` = `crons` length and `pinningTestCount` =
   `pinningTests` length (blast report), `descriptionOrFrontmatterChange`, `diffLines` and
   `leverCount` (from the proposed diff). Any field that cannot be determined
   mechanically takes the value that forces `hitl: true` (`false` for
   `replacementVerified`, `true` for `descriptionOrFrontmatterChange`, `999` for
   `diffLines`, `0` for `leverCount`). Use the `hitl` printed by the script verbatim.
   With no promoted rule every task is `hitl: true`, including class (c).
3. Build the task object:

```json
{
  "id": "prompt-{class}-{fp8}-shipwright-{YYYY-Www}",
  "title": "Prompt audit: {rule} - {file}",
  "source": "prompt-fix",
  "repo": "<repo from Step 9>",
  "branch": "chore/prompt-{fp8}-{slug}",
  "layer": "Docs",
  "status": "pending",
  "hitl": "<boolean printed by hitl-policy.ts>",
  "description": "<body, see below>"
}
```

`{fp8}` is the first 8 hex chars of the fingerprint; `{slug}` is the rule name,
lowercased, hyphenated, at most 5 words. The id suffix is the ISO week, 2-digit
zero-padded (`2026-W42`), so an example id is `prompt-c-a1b2c3d4-shipwright-2026-W42`.

### Body template

```
Prompt audit finding {fingerprint} — class {class} / {rule} ({cost-only|quality-claimed})

## Evidence
{file}:{line} — {evidence}

## Metric
{units}: {before} -> {projectedAfter} projected (model: {model}, estimated: {true|false})

## Measurement plan
Tier: {static|eval}. {evals with kind and estimated cost, or "none"}.
Acceptance: {measurement.acceptance}

## Blast radius (computed at filing)
{full blast report: load class and contexts, referrers, cron prompts and loop phases,
pinning content tests, source-map pages}
Change class: {rule}. Max diff lines: 20. Revert: git revert <merge commit>.

Stale-picture rule: before editing anything, the executing agent re-runs
`bun run plugins/shipwright/scripts/prompt-audit/cli.ts blast --file {file} --json`.
If its output differs from the report above, STOP and escalate (mark the task blocked
with the diff) instead of proceeding with a stale picture.

## Acceptance criteria (prove each in the PR body)
1. `cli.ts measure --finding {fp} --before main --after HEAD --model {m}` reports `tokenDelta <= -{N}`.
2. If the measurement tier is eval: `/shipwright:prompt-eval --finding {fp} --kind {kind} --max-cost-usd {X}`
   reports a score delta >= 0 and its JSON is attached to the PR.
3. The ledger entry's `measured` is populated (`cli.ts measure --record`) and cited in the PR body.

## PR must prove
- the relevant content tests pass
- the same-model token delta
- every removed line is dispositioned (relocated to a named file, or stale with command output)
- the always-loaded set did not grow
- for behavioral edits, an eval or production-series result
- the PR title starts with `docs:` or `chore:`

## Suppress instead
If the cost is intentional, do not edit the prompt: add an entry to
`.claude/shipwright/prompt-audit-decisions.md` (a human edit) and close this task.

HITL: {hitl} | Fingerprint: {fingerprint} | First seen: {firstSeen} | Last seen: {lastSeen}
```

---

## Step 11: Write and Append

1. Write the task objects to `/tmp/prompt-fix-tasks-{unix-timestamp}.json` as an array.
2. Run:
   ```bash
   curl -sf -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks/bulk" \
     --data-binary @/tmp/prompt-fix-tasks-{unix-timestamp}.json | jq .
   ```
3. Delete the temp file. If the POST fails, leave the ledger unchanged and report it.

---

## Step 12: Mark the Ledger

For each task the store accepted, set the ledger entry's `status: queued` and
`taskId` to the task id, and append a history event `{at, event: "queued", status: "queued"}`.
Write the whole ledger back (two-space indent, trailing newline), preserving every other
entry and every `history`. Skipped, stale, deferred and duplicate findings stay as they were.

---

## Step 13: Print Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROMPT FIX — QUEUED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Tasks queued:         {N}  (hitl true: {n}, hitl false: {n})
  Skipped (decisions):  {N}
  Skipped (stale):      {N}
  Skipped (duplicate):  {N}
  Deferred (cap):       {N}

{one line per queued task: id — title}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Known Gap

`hitl: true` blocks agent pickup, **not merge**. Branch protection requires 0 approvals and
the merging account is a bypass actor, so a hand-opened PR can still merge unreviewed. A
CODEOWNERS path rule with required code-owner review would close it, but it conflicts with
the documented bypass-actor design. This is an open question, not scheduled work.

---

## Constraints (Do Not Violate)

- **Propose-only.** Never edit a prompt, open a PR, or run git writes. The only writes are
  the task-store bulk POST and the ledger update.
- **`hitl` comes from `hitl-policy.ts`.** Never override it, never judge it, and never
  write a `hitl: false` task without a human-written `**Autonomy:**` entry. Quality-claimed
  findings are always `hitl: true`.
- **Never write the decisions registry.** Humans only.
- **Refuse during the cutover window and at the weekly cap**, and print why.
- **Re-check everything live:** registry, file and line, task store. Never reuse a prior
  run's answer.
- **Never proceed on a partial dedup result.** Apply the pagination guard.
- **`--dry-run` mutates nothing.**

---
name: security-fix
description: Read open security PatrolFindings from the task store (required --repo) and route each rule group auto / review / plan as task-store tasks, one task per rule; credential rotation/revocation findings keep hitl true and go through /shipwright:hitl. Requires security-scan to have run first.
---

# Security Fix

Read the repo's open security `PatrolFinding`s from the task store and queue focused,
human-reviewable tasks for `PR-worthy` findings. Each task fixes one rule — no bundled
concerns. Findings are never turned into direct PRs, and the scan-to-fix hand-off is the store:
this skill reads no report file and writes no finding to any repo path.

**Prerequisites:** Run `/security-scan --repo org/repo` first so open PatrolFindings exist.

> **Task store setup:** If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is
> missing, invoke `/shipwright:task-store` for setup instructions.

---

## Setup: Parse Arguments

- `--repo org/repo` — **required**. If missing or not `org/repo`, print and stop:
  ```
  Usage: /security-fix --repo org/repo [--cron ID] [--dry-run] [--rule {id}]
  Error: --repo is required.
  ```
- `--cron ID` — the system-cron id the scheduler passes (default `security-patrol-maintenance`);
  used as `CRON_ID` for reads, `originRef` and the recorded run.
- `--dry-run` — print what would be routed without writing tasks, findings or a run
- `--rule {id}` — route only findings of one rule (e.g. `--rule osv-cve`)

Set `REPO` to the `--repo` value and derive `repo-slug`: the last path segment, lowercased
(`app-vitals/shipwright` → `shipwright`). `cd` into the repo's local clone before Step 1 so
verification, suppressions and `git rev-parse HEAD` run against `--repo`. Queueing is the only
mode — no PR mode.

---

## Step 1: Load Open Findings from the Store

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/patrol-findings?cronId=$CRON_ID&repo={url-encoded-repo}&status=open&limit=200" | jq '.findings'
```

Page with `nextCursor` until exhausted. If none are returned, print
`No open security findings for {repo}. Run /security-scan --repo {repo} first.` and stop.
Each finding's `fingerprint` is `security-{rule}-{repo-slug}-{YYYY-Www}` and its `detail` holds
`rule`, `tier`, `severity`, `count` and the `findings` list (`file`, `line`, `description`).

---

## Step 2: Rule Classification Table

The rules below are a fixed, closed set defined by `security-scan`. This table is the single
source of truth for classification. **Route** maps today's HITL column onto the three finding
routes (see `/shipwright:task-store` "Finding routing"): `auto` = `kind: dev`, `pending`,
`hitl: false`; `review` = `kind: dev`, created `blocked`, `blockedReason: "needs-review: <question>"`,
never `hitl: true`; `plan` = `kind: prd`, `hitl: true`. `credential` is the one human-only
exception.

| rule | PR-worthy | HITL (was) | Route | requires-credential-action | rationale / fix guidance |
|---|---|---|---|---|---|
| `gitleaks-secret` | true | always | credential | true | A secret ever committed to git history is compromised — code alone can't un-compromise it. Human must rotate/revoke the credential at its source before any code cleanup matters. |
| `hardcoded-credential` | true | always | credential | true | Same reasoning as gitleaks-secret — a live credential value found in code (Tier 2 LLM check) needs rotation, not just removal. |
| `osv-cve` | true | never | auto | false | Mechanical dependency-lockfile bump to the patched version. If no patched version exists, route review instead. |
| `grype-cve` | true | never | auto | false | Mechanical base-image/dependency bump to the patched version. |
| `zizmor-lint` | true | never | auto | false | Mostly mechanical — SHA-pin unpinned GitHub Actions; for other zizmor findings in the group that aren't simple pinning fixes, fix if straightforward, else note as a follow-up in the PR body. |
| `secret-weak-compare` | true | never | auto | false | Mechanical — swap a non-constant-time comparison for `crypto.timingSafeEqual` or equivalent. |
| `authz-missing-check` | true | per-finding | auto, review or plan | false | Security-sensitive judgment call, not a credential issue — some routes are intentionally public. Per Step 4. |
| `posture-security-md-missing` | true | never | auto | false | Mechanical — add a `SECURITY.md` from a standard template (reporting process + supported versions). |
| `posture-sbom-missing` | false | n/a | none | false | Not filed — SBOM generation is a CI/tooling decision, not a single mechanical code fix. Left for manual triage. |
| `posture-branch-protection-missing` | false | n/a | none | false | Not filed — a GitHub repo settings change, not a code PR. Left for manual triage. |

`PR-worthy: false` rules are **never** queued — Step 3 filters them out.

**Never-auto rule.** Any finding that today's criteria would send to a human (`HITL: always`,
or a `HITL: per-finding` group that is ambiguous, cross-boundary, precedent-free, or that
fails pre-filing verification) must never become `auto`: credential findings stay
`hitl: true` via `/shipwright:hitl`; the others become `review` or `plan`. Do not hardcode a
duplicate copy of this table elsewhere.

---

## Step 3: Filter and Group Findings

1. Each open finding already is one rule group (its fingerprint is the group key and is reused
   unchanged as the task id). Skip findings whose `taskId` is already set.
2. Filter to rules with `PR-worthy: true` in the Step 2 table.
3. If `--rule` was passed, keep only that rule; if none match print
   "No open findings for rule `{rule_id}`. Nothing to queue." and stop.
4. Sort critical → high → medium → low.
5. If nothing survives, print `No PR-worthy findings to queue.` (posture-sbom-missing and
   posture-branch-protection-missing are left for manual triage) and stop.
6. Run each survivor through `references/pre-filing-verification.md` (relative to the plugin
   root) — the store finding is a snapshot that may be stale. Drop findings whose file/line no
   longer exists or whose gap is already fixed (Items 1–2); a finding that cannot be confirmed
   by a literal check routes `review`, never `auto` (Item 3); Item 4 (id/branch collisions) is
   covered by Step 6.1 dedup.

---

## Step 3.5: Re-check Suppressions (defense in depth)

`security-scan` already drops suppressed findings, but a store finding recorded before a
suppression landed can still list them. Before dedup, re-check every surviving
finding against `.shipwright/suppressions.yml` in the **repo being fixed** (schema:
`references/suppressions-schema.md`) so a stale finding cannot refile it.

1. **Build candidates** for `osv-cve`, `grype-cve` and `posture-*` findings only, parsing the
   match key from the finding description (never a line number): `{rule: "osv"|"grype", cve,
   package}` or `{rule: "posture", path}`. Other rules have no suppression schema and pass
   through unchanged.
2. **Filter** with the shared script, from the repo being fixed:
   ```bash
   bun "$CLAUDE_PLUGIN_ROOT/scripts/suppressions.ts" --filter .shipwright/suppressions.yml candidates.json
   ```
   A missing file is valid (nothing suppressed). A non-zero exit means the file is invalid —
   print the error and treat it as "no suppressions applied"; never abort. `expired` entries do
   not suppress.
3. **Skip each `suppressed` finding** — remove it before dedup and task-building, and print:
   `Skipping {rule} — suppressed in .shipwright/suppressions.yml ({status}: {reason})`
   This message is distinct from the "task already active" and "recently closed" messages in
   6.1. If a rule group is left empty, drop the group; if no groups remain, print the Step 3
   "No PR-worthy findings" message and stop.

---

## Step 4: Route Each Group

Decide the route per group using the Step 2 table:

- **credential** (`gitleaks-secret`, `hardcoded-credential`) → `hitl: true`, `kind: dev`, with a
  `## Human steps` section (6.4). Never auto-remediated: a committed or hardcoded credential is
  compromised the moment it exists, and only rotating or revoking it at its issuing source can
  fix that.
- **auto** → the rule is `HITL: never`, or an `authz-missing-check` group with a **single,
  obvious, canonical fix shape** and existing precedent in the same repo.
- **review** → `authz-missing-check` (or any group failing pre-filing verification) where
  multiple plausible fixes exist, intent is unclear (public vs authenticated), there is no
  precedent, or you are unsure. State the specific question in `blockedReason`
  (`needs-review: <question>`).
- **plan** → the fix is bigger than one task: it would cross repo or service boundaries or
  needs a design decision first. `kind: prd`, `hitl: true`, description = draft problem
  statement plus the findings.

Default toward `review` (or `plan` if large) when genuinely unsure — never toward `auto`.

**Worked example:** Two `authz-missing-check` findings from the same scan. The first flags
`src/routes/admin-users.ts:41`, a route with no auth check at all; there's no existing
"require-admin" middleware or equivalent pattern anywhere else in the codebase to model the
fix on, and it's genuinely unclear whether this route was meant to be public or just never
had auth wired up — a judgment call. Per the criterion above, this finding is `hitl: true`:
no clear precedent, ambiguous intent. Contrast that with a second finding at
`src/routes/billing-export.ts:19`, where the file already imports `requireAuth()` and uses
it on every other route in the same file except this one — the fix is a single, obvious,
mechanical addition of the same middleware call already used throughout the file, so this
finding is `hitl: false`.

---

## Step 5: Dry-Run Output (if --dry-run)

Print, then stop without writing tasks, findings or a run:

```
SECURITY FIX — DRY RUN ({repo})
Would route {N} tasks:
  1. security-{rule}-{repo-slug}-{YYYY-Www}  [auto | review | plan | credential]  {rule} ({severity}, {count} instances)
No tasks written. Re-run without --dry-run to queue.
```

---

## Step 6: Queue Tasks

Cap at 10 groups per run (highest severity first); note the cap if more remain.

### 6.1 Dedup Check

Query active and recently-closed tasks for the repo (URL-encode `REPO`):

Run (URL-encoded repo, e.g. `app-vitals%2Fshipwright`; also query `status=blocked` the same way so an awaiting-review task counts as active):
```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=pending&repo={url-encoded-repo}" | jq '.tasks'
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=in_progress&repo={url-encoded-repo}" | jq '.tasks'
```

The `&repo=` filter scopes dedup to tasks for the repo currently being scanned — without it, a
rule active for one repo would incorrectly block or interfere with dedup for a different repo.

Then run a third query for recently-closed `status=done` tasks, so a finding a human already
triaged (e.g. a HITL task closed as a false positive, with no code change because there was
nothing to fix) doesn't get silently re-filed the next time the same pattern is still
detectable — this is a coarse, rule-level check, the same granularity as the pending/
in_progress dedup above, not finding-level. Compute `updatedSince` as 14 days ago in ISO 8601
(`date -u`), then run:
```bash
UPDATED_SINCE=$(date -u -d '14 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-14d +%Y-%m-%dT%H:%M:%SZ)
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=done&repo={url-encoded-repo}&updatedSince=$UPDATED_SINCE" | jq '.tasks'
```
The 14-day window is long enough to span the weekly security-patrol cadence at least twice, but
short enough that a genuinely-regressed finding from months ago still gets re-filed rather than
silently suppressed forever.

Parse all three `.tasks` arrays. From the pending/in_progress results, collect tasks where:
- `source == "shipwright"`, OR
- `title` starts with `"Security fix:"`

Extract the rule IDs from these tasks by parsing the `id` field (format:
`security-{rule}-{repo-slug}-{YYYY-Www}`) or from the `branch` field (format:
`fix/security-{rule}-...`). Build a set of "already active" rule IDs.

From the `status=done` results (already filtered to the last 14 days by `updatedSince`), apply
the same `source`/`title` filter and rule-ID extraction to build a separate "recently closed"
set — keyed by rule ID, each entry keeping the done task's `completedAt` (or `updatedAt` if
`completedAt` is absent) and an outcome string for use in the skip message below. Resolve the
outcome as the first of these that is a non-empty string: the done task's `note` (the field
`/shipwright:hitl` Step 6 optionally sets from the human's close-out summary — the primary
path for the PR's motivating HITL-false-positive case), then its `blockedReason` (set by other
close paths, even though it's not typically paired with `status: "done"`), then the literal
`"resolved"` if neither is present.

For each rule group:
- If its `rule` is in the "already active" set, skip it. Print:
  `Skipping {rule} — task already active`.
- Else if its `rule` is in the "recently closed" set, skip it. Print:
  `Skipping {rule} — closed {date} as {outcome}, still within 14-day dedup window`
  (`{date}` is the done task's `completedAt`/`updatedAt`, `{outcome}` is the resolved outcome
  string above) — distinctly worded from the "already active" message above so operators can
  tell an active in-flight task from a recently-closed one at a glance in run output.

### 6.2 Build Task JSON

```json
{
  "id": "security-{rule}-{repo-slug}-{YYYY-Www}",
  "title": "Security fix: {rule description}",
  "source": "security-fix",
  "originKind": "cron",
  "originRef": "<CRON_ID>",
  "repo": "<REPO>",
  "kind": "dev | prd",
  "branch": "fix/security-{rule}-{short-description}",
  "layer": "Shared",
  "status": "pending | blocked",
  "blockedReason": "needs-review: <question>  (review route only)",
  "hitl": false,
  "description": "<see 6.3 / 6.4>"
}
```

Route shapes: auto = `kind: dev`, `status: pending`, `hitl: false`; review = `kind: dev`,
`status: blocked`, `blockedReason` set, `hitl: false` (a human unblocks with
`POST /tasks/{id}/unblock`); plan = `kind: prd`, `status: pending`, `hitl: true` (no branch);
credential = `kind: dev`, `status: pending`, `hitl: true`. Omit `blockedReason` unless review.
The id is the finding's fingerprint, reused unchanged. `short-description`: lowercase, hyphens,
max 5 words.

### 6.3 Description — auto, review and plan tasks

```
Security patrol finding: {rule} — {rule description} ({severity}, tier {tier})

Findings ({count} total):
- {file}:{line} — {finding_description}
{First 20 only; append "(+N more — see the PatrolFinding {fingerprint} in the task store)"}

Fix guidance: {rule's fix guidance from the Step 2 table}

Rule: {rule} | Severity: {severity} | Tier: {tier} | Route: {auto|review|plan}
```

For review, open with the question; for plan, open with a draft problem statement.

### 6.4 Description — credential-rotation tasks (`requires-credential-action: true`)

Filing the task with `hitl: true` plus a well-formed `## Human steps` block IS the routing
mechanism: `/shipwright:hitl {task-id}` finds and displays this section.

```
Security patrol finding: {rule} — {rule description} ({severity}, tier {tier})

This finding is tagged requires-credential-action: true. A committed or hardcoded credential
is compromised the moment it exists in the codebase or its history — code changes alone
cannot undo that. This task is never auto-remediated by security-fix or dev-task; it is
routed to a human via /shipwright:hitl.

Findings ({count} total):
- {file}:{line} — {finding_description}
{Include ALL findings that survived filtering. If there are more than 20, include the first
20 and append: "(+N more — re-run /security-fix to see all)"}

## Human steps

1. Identify the exposed credential and its issuing service from the findings list above.
2. Rotate or revoke the credential at its source (the issuing service's dashboard/API) — this
   cannot be done via a code change alone.
3. Update any live systems or secret stores (env vars, secret manager entries, CI secrets)
   with the new value.
4. Remove or replace the hardcoded value in code (or confirm it's already removed), and open
   a follow-up PR if code changes remain.
5. Confirm no other references to the old credential remain — grep the codebase and check
   recent git history.

Pick this up via /shipwright:hitl {task-id}.

Rule: {rule} | Severity: {severity} | Tier: {tier} | HITL: true | requires-credential-action: true
```

### 6.5 Write, Append and Link Back

1. Write the task array to a temp file outside the repo (`TASKS="$(mktemp -d)/security-tasks.json"`).
2. `POST $SHIPWRIGHT_TASK_STORE_URL/tasks/bulk` with `--data-binary @"$TASKS"` (bearer auth,
   `Content-Type: application/json`); delete the temp file afterwards.
3. Set `taskId` back on each routed finding (the batch keeps `detail`; status stays `open`):
   ```bash
   curl -sf -X POST -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/patrol-findings/batch" \
     --data '{"cronId":"'"$CRON_ID"'","repo":"'"$REPO"'","findings":[{"fingerprint":"<fp>","status":"open","taskId":"<fp>"}]}'
   ```
4. Record one run with the routing counts (the temp result file lives outside the repo):
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" record --cron "$CRON_ID" --repo "$REPO" \
     --commit "$(git rev-parse HEAD)" --result "$RESULT"
   ```
   `$RESULT` = `{"outcome":"ok","metrics":{"auto":N,"review":N,"plan":N,"credential":N,"skipped":N}}`
   (`"no_op"` when nothing was routed). Do not pass a legacy-import flag; the import belongs to
   `/security-scan`.

### 6.6 Print Summary

```
SECURITY FIX — {repo}: {A} auto, {R} review, {P} plan, {C} credential (hitl); {S} skipped
{If any skipped: one line per rule — "Skipped (already active)", "Skipped (recently closed, within 14-day dedup window): {rule} — closed {date} as {outcome}", or "Skipped (suppressed in .shipwright/suppressions.yml): {rule} — {status}: {reason}".}
Auto tasks run via the loop; review tasks wait for a human unblock; plan and credential tasks go to /shipwright:prd | /shipwright:plan-session and /shipwright:hitl.
```

Stop after printing.

---

## Error Handling

- **Store read fails** (Step 1 or 6.1 dedup): log and stop. Never queue without a dedup pass.
- **Bulk append fails**: log the response body and stop; re-running is idempotent because dedup
  skips already-queued rules and findings with a `taskId` are skipped.
- **Link-back or run record fails** after tasks were created: print the error and the created
  ids; do not re-create tasks.

---

## Constraints (Do Not Violate)

- **`--repo` is required** — no fallback to the current directory.
- **One task per rule** — never bundle multiple rule findings into one task.
- **Store only** — findings are read from, and linked back to, the task store; no finding
  detail is written to any repo path, and no other local state is read or written.
- **Queue only** — never opens PRs and never leaves the base branch.
- **Three routes, one exception** — every queued finding is `auto`, `review` or `plan`.
  `requires-credential-action` findings (`gitleaks-secret`, `hardcoded-credential`) are the
  only `hitl: true` dev tasks, always carry `## Human steps`, and are never auto-remediated by
  `dev-task` or this skill.
- **Never auto a previously-human finding** — nothing today's criteria send to a human may
  become `auto`.
- **Repo-namespaced IDs, always** — `security-{rule}-{repo-slug}-{YYYY-Www}`, the finding's
  fingerprint, so same-week multi-repo runs never collide (the `entropy-fix` task-ID bug).
- **`PR-worthy: false` rules are never queued.**
- **No cascade** — only route what is in the store now; do not re-scan during a run.
- **No classification table changes** — this skill enforces the Step 2 table, it does not
  modify it.

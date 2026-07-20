---
name: security-fix
description: Read security-report.md and queue PR-worthy findings as task-store tasks, one task per rule, routing any finding that requires credential rotation/revocation through /shipwright:hitl instead of auto-remediating it. Requires security-scan to have run first.
---

# Security Fix

Read the latest `security-report.md` and queue focused, human-reviewable tasks for
`PR-worthy` findings. Each task fixes one rule — no bundled concerns. Findings are never
turned into direct PRs; they always become task-store tasks that `dev-task` (for autonomous
tasks) or a human via `/shipwright:hitl` (for credential-rotation tasks) picks up later.

**Prerequisites:** Run `/security-scan` first to produce `security-report.md`.

> **Task store setup:** This skill pushes findings to the Shipwright task store. If
> `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke
> `/shipwright:task-store` for setup instructions.

---

## Setup: Parse Arguments

Before starting, check for flags:

- `--dry-run` — print what tasks would be queued without querying the task store for
  dedup or writing any tasks
- `--rule {id}` — queue only findings of a specific rule ID (e.g., `--rule osv-cve`)

> **Note:** Queueing is the only mode. There is no PR mode and no `--queue` flag — every
> run queues tasks. `--dry-run` shows a preview and stops without touching the task store.

---

## Step 1: Verify security-report.md Exists

1. Look for `security-report.md` in the project root.
2. If it does not exist, print:
   ```
   No security-report.md found. Run /security-scan first to generate a report.
   ```
   Then stop.
3. Read the report.

---

## Step 2: Rule Classification Table

Unlike `entropy-fix`, there is no shared principles file for `security-scan`'s rule set — the
rules below are a fixed, closed set defined by `security-scan` itself. This table is the
single source of truth for `security-fix`'s classification and is embedded directly here
rather than loaded from a file:

| rule | PR-worthy | HITL | requires-credential-action | rationale / fix guidance |
|---|---|---|---|---|
| `gitleaks-secret` | true | always | true | A secret ever committed to git history is compromised — code alone can't un-compromise it. Human must rotate/revoke the credential at its source before any code cleanup matters. |
| `hardcoded-credential` | true | always | true | Same reasoning as gitleaks-secret — a live credential value found in code (Tier 2 LLM check) needs rotation, not just removal. |
| `osv-cve` | true | never | false | Mechanical dependency-lockfile bump to the patched version. |
| `grype-cve` | true | never | false | Mechanical base-image/dependency bump to the patched version. |
| `zizmor-lint` | true | never | false | Mostly mechanical — SHA-pin unpinned GitHub Actions (the common case); for other zizmor findings in the same group that aren't simple pinning fixes, fix if straightforward, else note as a follow-up in the PR body. |
| `secret-weak-compare` | true | never | false | Mechanical — swap a non-constant-time comparison for `crypto.timingSafeEqual` or equivalent. |
| `authz-missing-check` | true | per-finding | false | Security-sensitive judgment call, not a credential issue — some routes are intentionally public. Use judgment per finding group: `hitl:false` when the missing check is unambiguous (e.g. an obviously-authenticated-only route with zero auth check), `hitl:true` when it's unclear whether the route should be public. |
| `posture-security-md-missing` | true | never | false | Mechanical — add a `SECURITY.md` from a standard template (reporting process + supported versions). |
| `posture-sbom-missing` | false | n/a | false | Not filed as a task — SBOM generation is a CI/tooling configuration decision, not a single mechanical code fix. Left for manual triage. |
| `posture-branch-protection-missing` | false | n/a | false | Not filed as a task — a GitHub repo settings change, not a code PR. Left for manual triage. |

Rules with `PR-worthy: false` (`posture-sbom-missing`, `posture-branch-protection-missing`)
are **never** queued — Step 3 filters them out before they reach the dedup or task-building
steps, mirroring how `entropy-fix` handles its own `PR-worthy: false` rules.

`requires-credential-action: true` (`gitleaks-secret`, `hardcoded-credential`) is the literal
tag this skill checks in Step 6q.3 to decide HITL routing — it is not a synonym for
`HITL: always` in general (`authz-missing-check` can also end up `hitl: true` per-finding
without requiring credential action), but for these two rules the two concepts coincide:
every finding of these rules is both `HITL: always` and `requires-credential-action: true`.

Do not hardcode a duplicate copy of this table elsewhere — this section is the single source
of truth `security-fix` reads.

---

## Step 3: Filter and Group Findings

1. Parse the report's `## New Findings` and `## Regressed Findings` sections, in that order.
   Collect all unchecked (`- [ ]`) findings from both — the report deliberately omits
   "Unchanged" findings from its body, so New + Regressed is already the full actionable set.
2. Each finding's `{id}` already encodes `rule` + `repo-slug` + `YYYY-Www` (format
   `security-{rule}-{repo-slug}-{YYYY-Www}`, per `security-scan`'s Step 2/Step 6). Group
   findings by `id` directly — do not re-derive `rule` separately; the id IS the group key,
   and it is reused unchanged as the task-store task id in Step 6q.3.
3. Filter to only groups whose rule has `PR-worthy: true` in the Step 2 table.
4. If `--rule` flag was passed, further filter to only that rule's group. If no findings
   match that rule ID, print: "No unchecked findings for rule `{rule_id}`. Nothing to
   queue." and stop.
5. Sort groups: critical first, then high, then medium, then low.
6. If no `PR-worthy` unchecked findings exist, print:
   ```
   No PR-worthy findings to queue. All findings are either:
   - Already checked off (fixed)
   - For rules marked PR-worthy: false (posture-sbom-missing, posture-branch-protection-missing — fix manually)
   Run /security-scan to refresh the report.
   ```
   Then stop.
7. Run each surviving finding through the pre-filing verification checklist —
   `references/pre-filing-verification.md` (relative to the plugin root) — before it proceeds
   any further toward becoming a task. This re-verifies the finding against the current repo
   state (the security report is a snapshot that may already be stale by the time this skill
   runs) and catches task ID / branch collisions early. Treat
   `references/pre-filing-verification.md` as canonical for how to apply the checklist. Per its
   four checks:
   - Drop findings whose file/line no longer exists or whose described gap is already fixed
     (Checklist Items 1–2) — do not queue a task for them. Log them the same way as other
     skipped findings (Step 6q.7 summary).
   - Route findings that can't be confirmed by a literal check to HITL rather than assuming
     they're safe to drop (Checklist Item 3) — this feeds into the `hitl` computation in
     Step 6q.3.
   - Checklist Item 4 (task ID / branch collisions) is satisfied by this skill's own Step 6q.1
     dedup check; no separate action is needed here beyond noting the overlap.
   This runs once, here in Step 3, so both the `--dry-run` preview (Step 4) and the real queue
   path (Step 6) operate on the same already-verified finding set.

---

## Step 4: Dry-Run Output (if --dry-run)

If `--dry-run` was passed, print a preview and stop without querying or writing to the task
store:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECURITY FIX — DRY RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Would queue {N} tasks:

  1. security-{rule}-{repo-slug}-{YYYY-Www}
     Rule: {rule description} ({severity})
     Findings: {count} instances
     Files: {list of unique file paths}
     HITL: {true|false}  requires-credential-action: {true|false}

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

Process only the first 10 groups (sorted by severity, per Step 3).

---

## Step 6: Queue Tasks

Queueing is the only mode. Run this workflow for every run.

### 6q.1 Dedup Check

First, detect the current repo from git: run `git remote get-url origin` and strip the
`https://github.com/` (or `git@github.com:`, stripping the `.git` suffix) prefix to get the
`org/repo` value — e.g. `app-vitals/shipwright`. This is the `repo` value used both to scope
the dedup queries below and, unchanged, as the task JSON's `repo` field in 6q.3 — compute it
once here and reuse it there.

Derive `repo-slug` from it too: the last path segment, lowercased — e.g.
`app-vitals/shipwright` → `shipwright`. This slug is used in task IDs throughout this skill
(6q.3) to keep IDs unique per repo — the same repo-namespacing `security-scan` already uses
for its own finding IDs and ledger keys.

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
- `title` starts with `"Security fix:"`

Extract the rule IDs from existing tasks by parsing the `id` field (format:
`security-{rule}-{repo-slug}-{YYYY-Www}`) or from the `branch` field (format:
`fix/security-{rule}-...`). Build a set of "already active" rule IDs.

For each rule group: if its `rule` is in the "already active" set, skip it. Print:
`Skipping {rule} — task already active`.

### 6q.2 Build Task JSON

For each remaining rule group, build a task object. Reuse the `repo` and `repo-slug` values
detected in 6q.1 — do not re-derive them. The task's `id` is the finding group's `{id}`
itself (already `security-{rule}-{repo-slug}-{YYYY-Www}` per Step 3, item 2) — reuse it
unchanged rather than reconstructing it:

```json
{
  "id": "security-{rule}-{repo-slug}-{YYYY-Www}",
  "title": "Security fix: {rule description}",
  "source": "security-fix",
  "repo": "<repo, as detected in 6q.1>",
  "branch": "fix/security-{rule}-{short-description}",
  "layer": "Shared",
  "status": "pending",
  "hitl": <true | false — computed per Step 6q.4>,
  "description": "<findings summary — see 6q.4/6q.5>"
}
```

`{repo-slug}` is the last path segment of the detected `repo` value (from 6q.1), lowercased.
It namespaces the task ID per repo so the same rule scanned in two different repos in the
same ISO week never collides — this is the exact fix for the known `entropy-fix` same-week
multi-repo task-ID collision bug, carried over from how `security-scan` already namespaces
its own finding IDs and ledger keys.

The `{YYYY-Www}` suffix uses ISO week format and is inherited directly from the finding
group's `{id}` — do not recompute it independently; it must match the report's ID exactly so
the dedup check in 6q.1 and any future re-run agree on the same task ID.

`short-description`: lowercase, hyphens, max 5 words from the rule's description.

### 6q.3 Compute the `hitl` and `requires-credential-action` Fields

Look up the rule in the Step 2 classification table and route:

- **`HITL: never`** → `hitl: false` unconditionally. Applies to `osv-cve`, `grype-cve`,
  `zizmor-lint`, `secret-weak-compare`, `posture-security-md-missing`. The fix is mechanical
  by construction — no numeric threshold ever forces these to HITL.
- **`HITL: always`** → `hitl: true` unconditionally. Applies to `gitleaks-secret` and
  `hardcoded-credential` — both are also `requires-credential-action: true`. These findings
  are **never auto-remediated**: a committed or hardcoded credential is compromised the
  moment it exists in the codebase, and a code edit alone cannot undo that — only rotating
  or revoking the credential at its issuing source can. `security-fix` never attempts this
  autonomously.
- **`HITL: per-finding`** → evaluate the specific finding group and decide. Applies to
  `authz-missing-check`. Use judgment (you are the Claude agent running this skill), grounded
  in the Step 2 table's rationale:
  - `hitl: false` (autonomous) when the missing check is unambiguous — an obviously
    authenticated-only route with zero auth check.
  - `hitl: true` (needs a human) when it's unclear whether the route should be public or
    not — a judgment call, not a mechanical fix.
  - No default lean either way; judge each group on its own facts.

**General ambiguous-fix criterion (applies on top of the lookup table above, including to
rule categories not yet in the Step 2 table):** the three bullets above cover the Step 2
table's fixed classifications, but the Step 2 table is not guaranteed to be exhaustive
forever — `security-scan` may add a new rule before this skill's Step 2 table is updated to
classify it. For any finding — whether its rule has a Step 2 entry or not — apply this
additional judgment, mirroring `consolidation-fix`'s Step 7 per-finding `hitl` heuristic:

- `hitl: false` (autonomous) when there is a **single, obvious, canonical fix shape** with
  **existing precedent elsewhere in the codebase** — e.g. the rule's own fix guidance in the
  Step 2 table names one clear, mechanical remediation (as `osv-cve`'s "bump to the patched
  version" or `secret-weak-compare`'s "swap in `crypto.timingSafeEqual`" already do), or an
  unclassified rule's finding clearly matches a fix pattern already used successfully
  elsewhere in this same repo.
- `hitl: true` (needs a human) when **any** of the following hold:
  - Multiple plausible fix approaches exist and reasonable engineers could disagree about
    which one to apply.
  - The fix would cross repo or service boundaries (e.g. the vulnerable code path spans both
    `plugins/shipwright/` and `agent/`, or two separate repositories).
  - There is no clear precedent elsewhere in the codebase for how to remediate this specific
    finding.
  - Default toward `hitl: true` when genuinely unsure — this is especially the lean for a
    rule with **no Step 2 table entry at all**, since an unclassified rule has, by
    definition, no rationale on record yet to justify autonomous action.

**Worked example:** Suppose `security-scan` ships a new rule, `insecure-deserialization`,
that is not yet in the Step 2 table. A finding flags `src/importer.ts:88` using
`unserialize()` on untrusted input. There is no existing safe-deserialization helper anywhere
else in the codebase, and two different plausible remediations exist — switch to a
schema-validated parser, or sandbox the deserialization call — with no precedent for which
this codebase prefers. Per the general criterion above, this finding is `hitl: true`: no
clear precedent, multiple plausible shapes, and no Step 2 table entry to lean on. Contrast
that with a second finding of the same new rule at `src/legacy-importer.ts:12`, where the
file already imports and partially uses a `safeParse()` helper from `src/lib/safe-parse.ts`
that another part of the codebase uses for the exact same untrusted-input pattern — here the
fix is a single, obvious, mechanical swap to the existing helper, so this finding is
`hitl: false` even though the rule itself still has no Step 2 table entry.

### 6q.4 Build the Description — Autonomous Tasks (`hitl: false`)

For rule groups classified `hitl: false`, the `description` field follows this shape:

```
Security patrol finding: {rule} — {rule description} ({severity}, tier {tier})

Findings ({count} total):
- {file}:{line} — {finding_description}
{Include ALL findings that survived filtering. If there are more than 20, include the first
20 and append: "(+N more — re-run /security-fix to see all)"}

Fix guidance: {rule's fix guidance from the Step 2 table}

Rule: {rule} | Severity: {severity} | Tier: {tier} | HITL: false
```

### 6q.5 Build the Description — Credential-Rotation Tasks (`requires-credential-action: true`)

For `gitleaks-secret` and `hardcoded-credential` findings (`requires-credential-action:
true`), the `description` field MUST state plainly that this requires credential
rotation/revocation and is therefore never auto-remediated, and MUST include a `## Human
steps` section — this is what routes the task through `/shipwright:hitl`: filing the task
with `hitl: true` plus a well-formed `## Human steps` block IS the routing mechanism (there
is no separate skill-invocation step; `/shipwright:hitl {task-id}` finds and displays this
section when a human or the `hitl` skill picks the task up).

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

### 6q.6 Write and Append

1. Write all task objects to `/tmp/security-tasks-{unix-timestamp}.json` as a JSON array
2. Run:
   ```bash
   curl -sf -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks/bulk" \
     --data-binary @/tmp/security-tasks-{unix-timestamp}.json | jq .
   ```
3. Delete the temp file after appending

### 6q.7 Print Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECURITY FIX — QUEUED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  QUEUED    {N} tasks   ({A} autonomous, {H} HITL)
  SKIPPED   {N} rule groups (already active)

Tasks queued:
  security-{rule}-{repo-slug}-{YYYY-Www} — {rule description}  [hitl: {true|false}]
  ...

{If any skipped:}
Skipped (already active):
  {rule} — task already in queue or in progress

Run /shipwright:dev-task to execute autonomous tasks. HITL tasks (credential rotation,
per-finding authz calls marked hitl:true) are picked up via /shipwright:hitl.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing — this is the sole final output.

---

## Error Handling

- **Task-store query fails** (dedup in 6q.1): log the failure and stop. Do not queue tasks
  without a dedup pass, or you risk duplicate tasks for the same finding group.
- **Bulk append fails** (`/tasks/bulk` non-2xx): log the response body and stop. Do not retry
  blindly; re-running the skill is idempotent because the dedup check will skip already-queued
  rules.
- **No PR-worthy findings**: handled in Step 3 — print the "nothing to queue" message and stop.
- **More than 10 groups**: cap at 10 as described in Step 5. Always queue highest-severity first.
- **No security-report.md**: handled in Step 1 — print guidance to run `/security-scan` first
  and stop.

---

## Constraints (Do Not Violate)

- **One task per rule** — never bundle multiple rule findings into one task.
- **Queue only** — this skill never opens PRs and never leaves the base branch. It only
  writes tasks to the task store; the actual fix lands later via `dev-task` or
  `/shipwright:hitl`.
- **`requires-credential-action` findings always route to HITL and are never
  auto-remediated** — `gitleaks-secret` and `hardcoded-credential` are always filed with
  `hitl: true` and a `## Human steps` section, unconditionally. `security-fix` (and
  `dev-task`, which never picks up `hitl: true` tasks autonomously) must never attempt to
  rotate, revoke, or otherwise "fix" a credential finding in code alone.
- **Repo-namespaced IDs, always** — every task ID is `security-{rule}-{repo-slug}-{YYYY-Www}`,
  reused unchanged from the finding group's own `id` (as produced by `security-scan`) — never
  `{rule}-{YYYY-Www}` — so same-week multi-repo runs never collide (the known `entropy-fix`
  task-ID collision bug).
- **`PR-worthy: false` rules are never queued** — `posture-sbom-missing` and
  `posture-branch-protection-missing` are filtered out in Step 3 and left for manual triage.
- **No cascade** — only queue what's in the current `security-report.md`. Do not re-scan
  during a run.
- **No classification table changes** — the fix skill enforces the Step 2 classification, it
  does not modify it; the table is embedded here as this skill's single source of truth
  rather than loaded from a shared file, since `security-scan`'s rule set has no equivalent
  shared principles file to defer to.
- **security-report.md is not checked off here** — a queued task only means a fix is
  scheduled. The report's findings are checked off when the queued task actually lands its
  fix (or, for HITL tasks, when a human completes it via `/shipwright:hitl`), via a separate
  mechanism, not by this skill.

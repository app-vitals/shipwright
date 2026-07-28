---
description: Execute a human-in-the-loop task — loads task context, assists with infra execution, marks done on exit
argument-hint: "{task-id}"
---

# HITL

Load a human-in-the-loop task from the task store, display its context (title, description,
acceptance criteria, and `## Human steps` section), assist with hands-on execution (no tool
restrictions — terraform, helm, kubectl, gcloud, and all infra tooling are fair game), and
mark the task `done` when the human confirms completion.

**This skill runs interactively. Pause and assist the human through each step.**

> **Task store setup:** This command reads and updates tasks in the Shipwright task store. If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke `/shipwright:task-store` for setup instructions. For local HITL use, create an admin token with the Agent ID field left blank.

---

## Step 1: Parse Arguments

Extract the task ID from `$ARGUMENTS`:

```bash
TASK_ID="$ARGUMENTS"
```

If `$ARGUMENTS` is empty, print and stop:
```
Usage: /shipwright:hitl {task-id}
Example: /shipwright:hitl HIT-3.1
```

---

## Step 2: Load Task

Query the task store by ID:

```bash
TASK_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID")
```

If `TASK_JSON` is empty or an error, print and stop:
```
✗ Task not found: {TASK_ID}
  Check the ID and try again, or run the task store query manually:
  curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks/{TASK_ID}"
```

Extract fields:

```bash
TASK_TITLE=$(echo "$TASK_JSON" | jq -r '.title // empty')
TASK_DESC=$(echo "$TASK_JSON" | jq -r '.description // empty')
TASK_STATUS=$(echo "$TASK_JSON" | jq -r '.status // empty')
TASK_HITL=$(echo "$TASK_JSON" | jq -r '.hitl // empty')
TASK_LAYER=$(echo "$TASK_JSON" | jq -r '.layer // empty')
TASK_AC=$(echo "$TASK_JSON" | jq -r '.acceptanceCriteria // empty | if type == "array" then .[] else . end')
```

---

## Step 3: Check HITL Field

If `TASK_HITL` is empty or not `"true"`:
```
⚠ This task does not have hitl: true — proceeding anyway
```

Continue regardless.

---

## Step 4: Display Task Header

Print the full task context:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HITL TASK: {TASK_ID}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Title:  {TASK_TITLE}
Layer:  {TASK_LAYER or "—"}
Status: {TASK_STATUS}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Description

{TASK_DESC or "(no description)"}

## Acceptance Criteria

{for each item in TASK_AC: "- {item}" | or "(none specified)" if empty}
```

### 4a. Human Steps Section

If `TASK_DESC` contains a `## Human steps` section (case-insensitive), extract and display it
prominently:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Human Steps
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{content of the ## Human steps section}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

To extract the section, find the `## Human steps` heading in `TASK_DESC` and capture
everything up to the next `##` heading (or end of string if none follows).

---

## Step 5: Assist with Execution

Enter interactive assist mode. Help the human execute the task steps.

**No tool restrictions apply.** All of the following are allowed and expected:
- `terraform plan` / `terraform apply`
- `helm upgrade` / `helm install` / `helm diff`
- `kubectl apply` / `kubectl get` / `kubectl logs` / `kubectl exec`
- `gcloud` commands (GKE, Cloud SQL, Cloud Run, IAM, etc.)
- `aws` commands (EC2, ECS, RDS, S3, IAM, etc.)
- `az` commands (Azure CLI)
- Database migrations, SQL queries
- Certificate rotation, secret management
- Any other infra tooling the task requires

Guide the human through each step of the `## Human steps` section (if present) in order.
For each step:
- Explain what the command does before running it
- Help interpret output and diagnose errors
- Suggest next steps if something unexpected happens

If the human asks for help with a step, provide the relevant commands and context.

---

## Step 6: Mark Task Done

When the human confirms the task is complete (e.g. says "done", "finished", "all good",
"mark it done", or similar):

1. First run **Step 6a** below if it applies to this task.
2. Then mark the task done in the task store as described further down.

### 6a. Offer Gitleaksignore Suppression

**Gate:** parse `TASK_DESC` for a trailer line of the form
`Rule: {rule} | Severity: {severity} | Tier: {tier} | HITL: true | requires-credential-action: true`
(this is the exact format `security-fix/SKILL.md` Step 6q.5 writes for credential-rotation
tasks). Extract `{rule}`.

- If `TASK_DESC` has **no `Rule:` line** at all (this HITL task did not originate from
  `/shipwright:security-fix`), **skip this sub-step entirely** and proceed straight to
  marking the task done, unchanged from today.
- If `{rule}` is **not** `gitleaks-secret` or `hardcoded-credential`, skip this sub-step
  entirely and proceed straight to marking the task done.
- Otherwise ({rule} is `gitleaks-secret` or `hardcoded-credential`), continue below.

**Why this exists:** a committed secret's exposure can't be undone by a code edit — the
gitleaks full-history scan will keep re-detecting the same commits every subsequent scan
unless the human's disposition is recorded somewhere gitleaks itself respects
(`.gitleaksignore`). Without this, a human closing the task as a false positive today gets
an identical task re-filed next week.

**Ask the human two distinct questions — do not conflate them:**

1. "Which of the findings listed above (if any) are **confirmed false positives** you want
   to permanently suppress via `.gitleaksignore`?"
2. "Which of the findings (if any) were closed because the **credential was rotated/revoked**?"

These are separate human answers. Suppression is **never offered for rotated credentials** —
never for a finding closed via rotation. An old fingerprint from a rotated secret is
harmless to leave undetected, but suppression must only ever be applied to findings the
human explicitly confirms as false positives. If a finding is rotated, it needs no
`.gitleaksignore` entry at all; just let it be. Only the false-positive-confirmed findings
are candidates for `.gitleaksignore` — even when the same task has a mix of some findings
rotated and some false-positive, ask about suppression only for the false-positive subset.

If the human is still deciding, or all findings in this task were closed via rotation (no
false positives to suppress), **skip suppression** and go straight to marking the task done
— this sub-step is additive, not required.

**If the human confirms one or more findings for suppression:**

1. **Resolve each confirmed finding to a gitleaks fingerprint.** The gitleaks fingerprint
   format is `commit:file:rule:startLine` (verified against gitleaks v8.27.2).
   - If `TASK_DESC` already breaks out full fingerprints for its findings (e.g. a backfill
     task written directly in that format), use those fingerprints directly — no further
     lookup needed.
   - Otherwise, `TASK_DESC`'s findings list is plain `- {file}:{line} — {finding_description}`
     (per `security-fix/SKILL.md` Step 6q.5) with no commit SHA. Ask the human to supply the
     full fingerprint for each confirmed finding, since that is what gitleaks actually
     matches on. If they only have `file:line`, tell them to look up the commit SHA via
     `git blame`/`git log` on that file/line, or via the original `security-report.md` that
     generated the task (security-scan writes the commit SHA per finding there).

2. **Create a worktree for the target repo**, following the standard convention. Use branch
   name `chore/gitleaksignore-suppress-{TASK_ID}` for this suppression PR (a new, distinct
   change from the original credential-rotation task — do not reuse that task's branch):
   ```bash
   git -C repos/{repo} pull
   git -C repos/{repo} worktree add /absolute/path/to/worktrees/{repo}-{branch} origin/main -b {branch}
   ```
   Use an absolute path for the worktree (naming: `{repo}-{branch}`, no timestamps, no
   nesting) per the standard worktree convention.

3. **Append the confirmed fingerprint lines to that repo's root `.gitleaksignore`**,
   creating the file if it doesn't exist. Each appended line carries a comment citing the
   HITL task ID and today's date:
   ```
   # Suppressed via HITL task {TASK_ID} on {YYYY-MM-DD} — confirmed false positive
   {fingerprint}
   ```

4. **Commit, push, and open a PR** in that worktree, using a `fix:` or `docs:` prefix per
   the target repo's own commit-message convention (`fix:` if the repo treats a
   `.gitleaksignore` entry as suppressing a would-be finding/check failure; `docs:` if the
   repo treats it as a non-functional record-keeping change):
   ```bash
   git add .gitleaksignore
   git commit -m "fix: suppress confirmed false-positive gitleaks finding ({TASK_ID})"
   git push -u origin {branch}
   gh pr create --title "fix: suppress confirmed false-positive gitleaks finding ({TASK_ID})" \
     --body "Confirmed false positive during HITL review of {TASK_ID}. See task for finding detail."
   ```

5. Then proceed to mark the task done as normal (below).

**If the human declines suppression** (still deciding, or all findings were rotated rather
than false-positive), skip straight to marking the task done — do not block on this
sub-step.

### 6b. Mark Task Done

Mark the task done in the task store:

```bash
COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID" \
  -d "{\"status\": \"done\", \"completedAt\": \"$COMPLETED_AT\"}" | jq .
```

Print:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ HITL TASK COMPLETE: {TASK_ID}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task:        {TASK_TITLE}
Completed:   {COMPLETED_AT}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

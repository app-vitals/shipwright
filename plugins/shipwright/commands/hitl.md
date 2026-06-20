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

Resolve the task store script and query by ID:

```bash
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | awk -F/ '{print $(NF-2), $0}' | sort -V | tail -1 | cut -d' ' -f2- | xargs dirname 2>/dev/null)
TASK_JSON=$(bun "$PLUGIN_SCRIPTS/task_store.ts" query --id "$TASK_ID" 2>/dev/null)
```

If `TASK_JSON` is empty, an error, or an empty array (`[]`), print and stop:
```
✗ Task not found: {TASK_ID}
  Check the ID and try again, or run the task store query manually:
  bun "$PLUGIN_SCRIPTS/task_store.ts" query --id {TASK_ID}
```

Extract fields from the first result:

```bash
TASK_TITLE=$(echo "$TASK_JSON" | jq -r '.[0].title // empty')
TASK_DESC=$(echo "$TASK_JSON" | jq -r '.[0].description // empty')
TASK_STATUS=$(echo "$TASK_JSON" | jq -r '.[0].status // empty')
TASK_HITL=$(echo "$TASK_JSON" | jq -r '.[0].hitl // empty')
TASK_LAYER=$(echo "$TASK_JSON" | jq -r '.[0].layer // empty')
TASK_AC=$(echo "$TASK_JSON" | jq -r '.[0].acceptanceCriteria // empty | if type == "array" then .[] else . end')
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
"mark it done", or similar), mark the task done in the task store:

```bash
COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
bun "$PLUGIN_SCRIPTS/task_store.ts" update --id "$TASK_ID" \
  --set status=done \
  --set completedAt="$COMPLETED_AT"
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

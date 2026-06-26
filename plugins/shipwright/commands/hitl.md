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
"mark it done", or similar), mark the task done in the task store:

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

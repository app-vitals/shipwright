# Remote Setup

Run Shipwright skills (e.g. `/shipwright:plan-session`) from any Claude Code session — your laptop, a CI job, a separate agent — and push tasks to a shared task store that a cloud agent then executes.

## How it works

```
Your laptop (Claude Code)          Cloud agent (e.g. Warchild)
        │                                       │
        │  /shipwright:plan-session             │
        │  → POST /tasks (token: agent-scoped)  │
        │─────────────────────────────────────► task store
        │                                       │  ◄── picks up ready tasks
        │                                       │  ◄── executes dev-task / review / deploy
```

When you use a token scoped to a specific agent's ID, the task store automatically assigns every task you create to that agent. The cloud agent's execution crons then pick them up without any extra configuration.

## Expected workflow

Remote access is for **planning**, not freeform task injection. The intended pattern is:

```
/shipwright:plan-session   ← run this locally
        │
        ▼
   tasks queued            ← with dependencies, branch names, acceptance criteria
        │
        ▼
  cloud agent executes     ← dev-task → review → deploy
```

Posting tasks directly to the task store API from a laptop — without going through `plan-session` — creates work that skips dependency mapping, branch planning, and acceptance criteria. The cloud agent will pick those tasks up and execute them as-is. Don't do this unless you know exactly what you're adding and why.

---

## Prerequisites

| Requirement | Why |
|---|---|
| Claude Code installed | Runs the plugin |
| Shipwright plugin installed | Provides `/plan-session` and all related skills |
| GitHub CLI (`gh`) authenticated | Required by dev-task, review, and deploy skills when the cloud agent runs them |
| Task store URL | HTTP endpoint — see [Getting the URL](#getting-the-url) below |
| Task store token | Scoped to the agent that will execute your tasks — see [Getting a token](#getting-a-token) below |

### Install the plugin

```bash
/plugin install shipwright@app-vitals/shipwright
```

---

## Getting the URL

The task store is an HTTP service. You need a URL that your laptop can reach.

### Option A: kubectl port-forward (development)

The fastest option — no chart changes required. Works as long as you have kubectl access to the cluster.

```bash
kubectl port-forward -n shipwright service/shipwright-task-store 3002:3000
```

Leave this running in a separate terminal. Use `http://localhost:3002` as your URL.

### Option B: External URL (production / persistent)

The Shipwright Helm chart can expose the task store through the cluster ingress. Ask your Shipwright operator to enable it:

```yaml
# values override
taskStore:
  enabled: true
  ingress:
    enabled: true
    host: task-store.your-domain.com
```

Once deployed, use `https://task-store.your-domain.com` as your URL.

---

## Getting a token

Tokens are agent-scoped: every task you create with a scoped token is automatically assigned to the target agent. You need an admin token to create one.

Get the agent ID of the cloud agent you want to target (ask your Shipwright operator, or check the agent's env: `echo $SHIPWRIGHT_AGENT_ID`).

Then create a scoped token:

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tokens" \
  -d "{\"label\": \"$(whoami)-laptop\", \"agentId\": \"<AGENT_ID>\"}" \
  | jq '{id: .id, rawToken: .rawToken}'
```

**Save the `rawToken` value** — it is shown exactly once and cannot be retrieved again.

> If you do not have an admin token, ask your Shipwright operator to create one or to mint the scoped token for you.

---

## Set the environment variables

```bash
export SHIPWRIGHT_TASK_STORE_URL="http://localhost:3002"   # or your external URL
export SHIPWRIGHT_TASK_STORE_TOKEN="<rawToken from above>"
```

Add these to your shell profile (`.zshrc` / `.bashrc`) to avoid re-setting them each session:

```bash
echo 'export SHIPWRIGHT_TASK_STORE_URL="http://localhost:3002"' >> ~/.zshrc
echo 'export SHIPWRIGHT_TASK_STORE_TOKEN="<rawToken>"' >> ~/.zshrc
```

Verify the connection:

```bash
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?ready=true" | jq '.total'
```

A `0` (or any number) is success. A `401` means the token is wrong. A connection error means the URL is unreachable.

---

## Run plan-session

```bash
cd /path/to/your/repo
claude
```

Then inside Claude Code:

```
/shipwright:plan-session <repo> <session>
```

For example:

```
/shipwright:plan-session shipwright may-billing-refactor
```

Plan-session auto-detects the repo from `git remote get-url origin` if you omit it:

```
/shipwright:plan-session may-billing-refactor
```

Tasks are written to `planning/<session>/PLAN.md` in your local repo and posted to the task store. The cloud agent's execution cron picks up ready tasks automatically.

---

## Troubleshooting

### `curl: (7) Failed to connect` or `Connection refused`

The task store URL is not reachable. If using port-forward, confirm it is still running (`kubectl port-forward ...`). If using an external URL, verify the Helm chart has `taskStore.ingress.enabled: true`.

### `401 Unauthorized`

The token is wrong or revoked. Verify `SHIPWRIGHT_TASK_STORE_TOKEN` is set and matches the `rawToken` returned at creation time. Tokens cannot be retrieved after creation — if lost, create a new one.

### Tasks not picked up by the cloud agent

Check that the token used to create tasks is scoped to the right agent ID:

```bash
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tokens" | jq '.[] | {id, label, agentId}'
```

Compare `agentId` against the cloud agent's `SHIPWRIGHT_AGENT_ID`. If they do not match, create a new scoped token with the correct agent ID.

### Tasks created but `ready=true` returns empty

Check for HITL tasks or unmet dependencies:

```bash
# See all pending tasks (includes blocked ones)
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=pending" | jq '.tasks[] | {id, hitl, dependencies}'
```

Tasks with `hitl: true` are excluded from the ready queue until a human clears the flag. Tasks with unmet `dependencies` are also excluded — check that the referenced task IDs exist and have a terminal status.

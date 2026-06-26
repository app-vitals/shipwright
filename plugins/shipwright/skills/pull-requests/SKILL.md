---
name: pull-requests
description: >
  Query PR records from the task store — filter by repo, PR number, state,
  reviewState, or staged flag, and display results as a readable table.
---

# Pull Requests — Skill

Use this skill to query PR records tracked by the Shipwright task store.
Results are fetched from `GET /prs` and displayed as a table.

---

## Setup

Verify required environment variables before querying:

```bash
echo "URL:   ${SHIPWRIGHT_TASK_STORE_URL:-(missing)}"
echo "Token: ${SHIPWRIGHT_TASK_STORE_TOKEN:+(set)}"
```

Both are provisioned automatically by the agent harness. See the
[task-store skill](../task-store/SKILL.md) for token creation instructions if
either is missing.

---

## Filters

All filters are optional and can be combined. Pass them as query parameters.

| Filter | Type | Description |
|---|---|---|
| `repo` | `org/repo` | Exact match on repository (e.g. `app-vitals/shipwright`) |
| `prNumber` | integer | Specific PR number |
| `state` | string | PR state: `open`, `merged`, `closed` |
| `reviewState` | string | Review state: `pending`, `in_progress`, `posted`, `approved` |
| `staged` | boolean | `true` or `false` — filter by staging flag |

---

## Examples

### List all PRs

```bash
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs" | jq .
```

### Filter by repo

```bash
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?repo=app-vitals%2Fshipwright" | jq .
```

### Filter by state

```bash
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?state=open" | jq .
```

### Filter by reviewState

```bash
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?reviewState=pending" | jq .
```

### Filter by staged flag

```bash
# Staged PRs only
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?staged=true" | jq .

# Unstaged PRs only
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?staged=false" | jq .
```

### Fetch a specific PR by number

```bash
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?prNumber=42" | jq .
```

### Combined filters

```bash
# Open PRs with pending review in a specific repo
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?repo=app-vitals%2Fshipwright&state=open&reviewState=pending" | jq .

# Staged PRs awaiting review posting
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?staged=true&reviewState=in_progress" | jq .
```

---

## Display as a table

After fetching, render results as a readable table. Extract and format each
record using jq:

```bash
curl -sf \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs" \
| jq -r '
  ["id","repo","PR#","reviewState","staged","reviewCycles","patchCycles","commitSha","claimedBy","reviewedAt"],
  (.prs[] | [
    .id,
    .repo,
    (.prNumber | tostring),
    .reviewState,
    (.staged | tostring),
    (.reviewCycles | tostring),
    (.patchCycles | tostring),
    (if .commitSha then .commitSha[0:8] else "-" end),
    (.claimedBy // "-"),
    (.reviewedAt // "-")
  ])
  | @tsv
' | column -t -s $'\t'
```

### Table columns

| Column | Source field | Notes |
|---|---|---|
| id | `.id` | Record identifier |
| repo | `.repo` | `org/repo` format |
| PR# | `.prNumber` | GitHub PR number |
| reviewState | `.reviewState` | `pending` / `in_progress` / `posted` / `approved` |
| staged | `.staged` | `true` / `false` |
| reviewCycles | `.reviewCycles` | Number of completed review cycles |
| patchCycles | `.patchCycles` | Number of patch iterations |
| commitSha | `.commitSha` | First 8 characters of the commit SHA |
| claimedBy | `.claimedBy` | Agent ID that currently holds the claim |
| reviewedAt | `.reviewedAt` | ISO timestamp of last review completion |

---

## Response envelope

```json
{
  "prs": [ /* array of PR records */ ],
  "total": 12,
  "limit": 50,
  "offset": 0
}
```

Use `?limit=N&offset=M` for pagination.

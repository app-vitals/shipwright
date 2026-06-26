---
name: pull-requests
description: >
  Query PR records tracked by the Shipwright task store — filter by repo, PR number, state,
  review state, or staged flag, and display results as a human-readable table. Use to inspect
  where a PR is in the review → patch → deploy pipeline.
---

# Pull Requests — Skill

Query and display PR records from the Shipwright task store.

---

## Authentication

All requests require a Bearer token:

```bash
Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN
```

| Env var | Description |
|---|---|
| `SHIPWRIGHT_TASK_STORE_URL` | Base URL of the task store service |
| `SHIPWRIGHT_TASK_STORE_TOKEN` | Bearer token for this agent |

---

## Usage

Call `GET /prs` with any combination of filter parameters:

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs" | jq .
```

---

## Filters

All filters are optional and can be combined:

| Parameter | Type | Description |
|---|---|---|
| `repo` | string | Filter by repository in `org/repo` format (e.g. `app-vitals/shipwright`) |
| `prNumber` | integer | Filter by a specific PR number |
| `state` | string | Filter by PR state: `open`, `merged`, `closed` |
| `reviewState` | string | Filter by review pipeline phase: `pending`, `in_progress`, `posted`, `approved` |
| `staged` | boolean | Filter by staged flag: `true` (review written, not yet posted) or `false` |
| `limit` | integer | Max records to return (default: 50) |
| `offset` | integer | Pagination offset (default: 0) |

### Examples

```bash
# All open PRs for a repo
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?repo=app-vitals/shipwright&state=open" | jq .

# A specific PR by number
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?repo=app-vitals/shipwright&prNumber=42" | jq .

# PRs pending review
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?reviewState=pending" | jq .

# Staged reviews (written but not posted)
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?staged=true" | jq .
```

---

## Output

The endpoint returns a paginated envelope:

```json
{
  "prs": [...],
  "total": 12,
  "limit": 50,
  "offset": 0
}
```

### Display as a table

Use this jq snippet to render a readable summary table:

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?state=open" \
  | jq -r '
    ["ID", "Repo", "PR#", "ReviewState", "Staged", "RevCycles", "PatchCycles", "SHA", "ClaimedBy", "ReviewedAt"],
    (.prs[] | [
      .id,
      .repo,
      (.prNumber | tostring),
      .reviewState,
      (.staged | tostring),
      (.reviewCycles | tostring),
      (.patchCycles | tostring),
      (if .commitSha then .commitSha[:7] else "-" end),
      (if .claimedBy then .claimedBy else "-" end),
      (if .reviewedAt then .reviewedAt[:10] else "-" end)
    ]) | @tsv
  ' | column -t -s $'\t'
```

**Columns:**

| Column | Field | Notes |
|---|---|---|
| ID | `id` | CUID record identifier |
| Repo | `repo` | `org/repo` format |
| PR# | `prNumber` | GitHub PR number |
| ReviewState | `reviewState` | Current pipeline phase |
| Staged | `staged` | `true` = review written, not yet posted |
| RevCycles | `reviewCycles` | Number of completed review passes |
| PatchCycles | `patchCycles` | Number of patch cycles applied |
| SHA | `commitSha` | Short (7-char) commit SHA, or `-` |
| ClaimedBy | `claimedBy` | Agent ID holding the claim, or `-` |
| ReviewedAt | `reviewedAt` | Date of last completed review, or `-` |

---

## Review states

| State | Meaning |
|---|---|
| `pending` | Awaiting review claim |
| `in_progress` | Review claimed and in progress |
| `posted` | Review posted to GitHub |
| `approved` | PR approved, ready to deploy |

## PR states

| State | Meaning |
|---|---|
| `open` | PR is open on GitHub |
| `merged` | PR has been merged |
| `closed` | PR was closed without merging |

---

## Full API reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/prs` | List PRs (with optional filters) |
| `GET` | `/prs/:id` | Fetch one PR by record ID |
| `PATCH` | `/prs/:id` | Update writable fields (`staged`, `commitSha`, `taskId`, `state`, `mergedAt`, `reviewState`) |
| `POST` | `/prs/claim` | Atomically claim a PR for review |
| `POST` | `/prs/:id/complete` | Mark review posted (`reviewState=posted`) |
| `POST` | `/prs/:id/patch` | Increment patch cycles (`reviewState=pending`) |
| `POST` | `/prs/:id/release` | Release claim (`reviewState=pending`) |
| `POST` | `/prs/:id/heartbeat` | Touch `heartbeatAt` to keep claim alive |

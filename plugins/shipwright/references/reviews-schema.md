# Reviews Schema -- Shipwright Review Tracking

PR tracking state lives in the task store's `PullRequest` model. Each record tracks
an agent's relationship with a PR — claimed commit SHAs, review state, staging status,
and workflow phases. The task store is the source of truth; atomic claims prevent
concurrent review of the same commit.

The review narrative itself (findings, verdict, inline comments) is still written locally
to `state/reviews/PR_REVIEW_{pr}.md` and `state/reviews/pr_review_{pr}.json` for posting
to GitHub.

## API Endpoint

Access PR records via the task store API:

```bash
# List all PR records for a repo
curl -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}"

# List staged records only
curl -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&staged=true"

# Fetch one PR record
curl -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/{id}"

# Claim a PR at its current head
curl -X POST -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d '{"repo": "{org}/{repo}", "prNumber": {number}, "commitSha": "{sha}"}'
```

## Record Schema

```json
{
  "id": "clp1234abcd",
  "repo": "app-vitals/shipwright",
  "prNumber": 123,
  "taskId": "TS-1.1",
  "staged": true,
  "state": "open",
  "reviewState": "posted",
  "commitSha": "abc1234def5678",
  "patchCycles": 0,
  "reviewCycles": 1,
  "agentId": "agent-123",
  "reviewedAt": "2026-04-15T10:45:00Z",
  "patchedAt": null,
  "mergedAt": null,
  "claimedBy": "agent-123",
  "claimedAt": "2026-04-15T10:30:00Z",
  "heartbeatAt": "2026-04-15T10:45:00Z",
  "createdAt": "2026-04-15T08:00:00Z",
  "updatedAt": "2026-04-15T10:45:00Z"
}
```

## State and ReviewState Enums

### `state` — Terminal PR state

| Value | Meaning |
|-------|---------|
| `open` | PR is open on GitHub (default) |
| `merged` | PR was merged; terminal |
| `closed` | PR was closed without merge; terminal |

### `reviewState` — Review workflow phase

| Value | Set by | Meaning |
|-------|--------|---------|
| `pending` | task store (no record yet) or `/prs/{id}/release` | PR not yet reviewed, or a claim was abandoned |
| `in_progress` | review.md Step 4 (claim) | Review in progress — claim acquired |
| `posted` | review.md Step 11 (staged COMMENT) or Step 11b (posted) | Review written (staged) or posted to GitHub — see `staged` to distinguish |
| `approved` | review.md Step 11b (APPROVE verdict) | Review posted with APPROVE verdict |

## Field Reference

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique record ID (CUID) |
| `repo` | string | Repository in `org/repo` format |
| `prNumber` | number | GitHub PR number |
| `taskId` | string \| null | Shipwright task ID (if from a task store task) |
| `staged` | boolean | `true` = review written, not yet posted; `false` = not staged or already posted |
| `state` | enum | Terminal PR state: `open`, `merged`, or `closed` |
| `reviewState` | enum | Workflow phase: `pending`, `in_progress`, `posted`, or `approved` |
| `commitSha` | string \| null | HEAD SHA when the PR was claimed (most recent review point) |
| `patchCycles` | number | Count of patch attempts on this PR |
| `reviewCycles` | number | Count of review passes on this PR |
| `agentId` | string \| null | ID of the agent that posted the review |
| `reviewedAt` | ISO string \| null | When the review was posted to GitHub |
| `patchedAt` | ISO string \| null | When the PR was last patched |
| `mergedAt` | ISO string \| null | When the PR was merged (set during cleanup) |
| `claimedBy` | string \| null | User or agent ID that acquired the claim |
| `claimedAt` | ISO string \| null | When the claim was acquired |
| `heartbeatAt` | ISO string \| null | Last activity timestamp (keep-alive signal) |
| `createdAt` | ISO string | Record creation time |
| `updatedAt` | ISO string | Last update time |

## Key Behaviors

- **Atomic claiming**: the `/prs/claim` endpoint is atomic — two concurrent requests at the same
  commit return 201 (created) for the first, 409 (conflict) for the second. Prevents concurrent
  review of the same commit.

- **`commitSha` tracking**: `commitSha` is the HEAD SHA at which the PR was last reviewed (captured
  during claim in Step 4). Comparing it to the current GitHub head detects "new commits since
  last review" without re-fetching history. Compare against `gh pr view --json headRefOid`.

- **`staged` flag**: when `auto_post_reviews` is false (default), reviews are staged. Set `staged: true`
  on Step 11 (before posting). Explicit `/shipwright:review {org}/{repo}#{pr}` invocation
  posts a staged review (owner confirmation).

- **Workflow phases**: `review.md` is explicit-target-only — it always operates on the one
  PR named in `$ARGUMENTS`, not a self-scanned/ranked queue. `reviewState` still governs
  the dedup decision for that single target PR (review.md Step 14):
  - `in_progress` = another agent is working; the claim attempt 409s and the command stops
  - `posted` / `approved` + unchanged `headRefOid` = already reviewed at this commit; skip
  - `posted` / `approved` + new `headRefOid` = re-review (author pushed real changes)
  - `pending` or no record = first review

- **Terminal states**: when a PR is merged or closed, mark `state: merged` or `closed` (Step 2
  cleanup). `state` is independent of `reviewState` — a record can have `state: merged` while
  `reviewState: posted` (the review was posted before merge).

- `taskId` is nullable — a PR not opened by a shipwright task (e.g. opened by hand) still
  gets reviewed when explicitly targeted; it just has no linked task record.

- **Multi-agent coordination**: the atomic claim + heartbeat mechanism allows multiple agents
  to review different PRs in parallel without coordination overhead.

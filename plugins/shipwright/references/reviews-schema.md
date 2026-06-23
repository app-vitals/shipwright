# Reviews Schema -- Shipwright Review Tracking

Review state is tracked in `state/reviews.json`. Each entry represents an agent's
relationship with a PR -- whether it's been reviewed, posted, merged, or cleaned up.

## Schema

```json
{
  "pr": 123,
  "repo": "app-vitals",
  "org": "app-vitals",
  "title": "Add billing webhook handler",
  "author": "agent-bot",
  "branch": "feat/ts-1.1-billing-webhook",
  "taskId": "TS-1.1",
  "session": "may-billing-refactor",
  "additions": 45,
  "deletions": 12,
  "diffSize": 57,
  "firstSeen": "2026-04-15T08:00:00Z",
  "lastReviewedAt": "2026-04-15T10:45:00Z",
  "lastReviewedCommit": "abc1234def5678",
  "reviewCount": 1,
  "reviewFile": "state/reviews/PR_REVIEW_123.md",
  "verdict": "COMMENT",
  "findingsCount": 3,
  "posted": false,
  "postedAt": null,
  "status": "staged"
}
```

## Status Flow

```
pending -> reviewing -> staged -> posted
```

| Status | Set by | Meaning |
|---|---|---|
| `pending` | review Step 3 | PR discovered, not yet reviewed |
| `reviewing` | review Step 4 | Review in progress (prevents double-review) |
| `staged` | review Step 10 | Review file written, awaiting owner confirmation |
| `posted` | review Step 10/13 | Review posted to GitHub |

**Principle:** Don't track state locally that can be derived from GitHub. PR merge/close
state lives in GH; CHANGES_REQUESTED state lives in GH — re-derive on every run rather
than caching in a local terminal status. Worktree cleanup (`review.md` Step 2) queries GH
directly to find merged/closed PRs instead of relying on a local `merged` status.

**Multi-task PRs:** When multiple tasks share one PR, `taskId` holds only one ID. Task
completion state for the others must be derived from the PR's GH state (open/merged), not
from a local status field.

## Field Reference

| Field | Type | Description |
|---|---|---|
| `pr` | number | PR number |
| `repo` | string | Repository name (e.g., `app-vitals`) |
| `org` | string | GitHub org (e.g., `app-vitals`) |
| `title` | string | PR title |
| `author` | string | PR author login |
| `branch` | string | Head branch name |
| `taskId` | string \| null | Shipwright task ID (from the task store) |
| `session` | string \| null | Shipwright session slug |
| `additions` | number | Lines added at time of discovery |
| `deletions` | number | Lines deleted at time of discovery |
| `diffSize` | number | `additions + deletions` — used for queue prioritization |
| `firstSeen` | ISO string | When the PR was first discovered in the queue |
| `lastReviewedAt` | ISO string | When the last review was performed |
| `lastReviewedCommit` | string | HEAD SHA at time of last review |
| `reviewCount` | number | How many times this PR has been reviewed |
| `reviewFile` | string | Path to PR_REVIEW markdown file |
| `verdict` | string | APPROVE or COMMENT |
| `findingsCount` | number | Number of findings in last review |
| `posted` | boolean | Whether the review has been posted to GitHub |
| `postedAt` | ISO string \| null | When the review was posted |
| `status` | string | See Status Flow above |

## Key Behaviors

- `lastReviewedCommit` enables "new commits since last review" detection without
  re-fetching GitHub history. Compare against `gh pr view --json headRefOid`.
- `diffSize` drives queue prioritization — smallest diffs are reviewed first, keeping
  small PRs from being starved behind large ones. Set at `pending` time from the
  `gh pr list` fetch (`additions + deletions`). Missing on entries created before
  v4.1.0 — populated lazily on next review pass.
- `firstSeen` is the tiebreaker when `diffSize` is equal or missing — oldest first.
- `taskId` is nullable -- PRs not from shipwright todos still get reviewed when
  `review_external_prs` is enabled in agent-policy.md.
- The `reviewing` status prevents concurrent cron runs from double-reviewing the
  same PR. If a review was interrupted (agent restart), the status stays `reviewing`
  and must be manually reset to `pending`.

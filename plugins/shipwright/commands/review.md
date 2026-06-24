---
description: Review open PRs -- deep single-pass review with inline comments, policy-controlled posting
argument-hint: "[org/repo#number]"
---

# Review

Evaluate open PRs and post findings. Scope: review only — no patching, merging, or deploying.

`state/reviews.json` is a local dedup cache. It tracks reviewed commit SHAs to avoid
re-posting on PRs that haven't changed. It is not shared state and is not read by other
agents — each agent maintains its own.

---

## Arguments

Parse `$ARGUMENTS`:
- `org/repo#number` (e.g. `app-vitals/shipwright#123`): target a specific PR. If a staged
  review exists in `state/reviews.json`, post it. Otherwise, review it.
- `number` or `#number`: same, using the repo from the task store API
- No arguments: normal review flow — find the next PR to review from the queue

---

## Step 1: Load Policy

Read `state/agent-policy.md`. If the file doesn't exist, use these conservative defaults:

| Setting | Default |
|---------|---------|
| `auto_post_reviews` | false |
| `allowed_events` | [COMMENT, APPROVE] |
| `review_external_prs` | true |
| `allow_self_review` | true |
| `min_confidence` | 75 |
| `max_findings` | 5 |
| `cleanup_merged_worktrees` | true |
| `cleanup_after_days` | 14 |

Print a one-line policy summary:
```
Policy: {staging|auto-posting} reviews
```

---

## Step 2: Clean Up Worktrees

If `cleanup_merged_worktrees` is true:

1. Read `state/reviews.json` (create as `[]` if missing)
2. For entries with `status` of `staged`, `posted`, or `reviewing`:
   - Check if the PR is merged or closed: `gh pr view {pr} --repo {org}/{repo} --json state -q '.state'`
   - If `MERGED` or `CLOSED`: remove the worktree if it exists (`git -C repos/{repo} worktree remove worktrees/{repo}-{branch-slug} --force 2>/dev/null`), update `status: "merged"`, set `mergedAt`
3. For entries with `status: "merged"`: set `status: "cleaned"` (terminal)
4. Remove stale worktrees older than `cleanup_after_days`:
   ```bash
   find worktrees/ -maxdepth 1 -type d -mtime +{cleanup_after_days} -exec basename {} \;
   ```
   For each, remove via `git worktree remove`.
5. Write updated `state/reviews.json`
6. If any cleaned: print `Cleaned {N} worktrees`

---

## Step 3: Find PRs to Review

Before building the queue, resolve the current GitHub CLI user once and remember the value — substitute it directly into all subsequent commands that need it:

```bash
gh api /user -q '.login'
```

### Step 3a: Drain Staged Queue (interactive mode)

Read `state/reviews.json` for entries with `status: "staged"`.

If any staged reviews exist, present them in priority order:
1. **APPROVE verdicts first** — unblocking is highest value
2. **Then by `diffSize` ascending** — smallest diffs are fastest to confirm

Display:
```
## Staged Reviews ({N})
| PR | Repo | Title | Verdict | Diff | Staged |
|----|------|-------|---------|------|--------|
| #123 | example-repo | Add feature X | APPROVE | +45/-12 (57) | 2h ago |
| #456 | example-repo | Fix bug Y | COMMENT | +120/-30 (150) | 1h ago |

Post staged reviews, or skip to new reviews?
```

**If posting**: work through them one at a time using the Step 14 posting mechanics
(show review summary → confirm → post → move to next). After all staged reviews are
processed or skipped, continue to Step 3b.

**If skipping**: proceed directly to Step 3b.

---

### Step 3b: Build Review Queue

If `review_external_prs` is true, resolve the configured repos and fetch open PRs for each:

```bash
REPOS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/repo" | jq -r '.repo // empty')
```

```bash
gh pr list --state open --repo {org}/{repo} \
  --json number,title,author,headRefName,baseRefName,isDraft,reviews,updatedAt,additions,deletions
```

Exclude:
- Draft PRs
- PRs where `author.login == CURRENT_USER` and `allow_self_review` is false
- PRs where `author.login == "app/dependabot"` — handled exclusively by the dependabot-review plugin

When a PR is checked out for review, also query the task store for a task whose `pr`
field matches the PR number — if found, record the `id` and `session` for metrics enrichment
in Steps 12 and 13:

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?pr=$PR_NUMBER" | jq '.tasks[0] // empty'
```

### Deduplication and Filtering

Read `state/reviews.json`. For each candidate PR:

- **No entry**: eligible (new PR). Create a `pending` entry immediately:
  ```json
  {
    "pr": {number}, "repo": "{repo}", "org": "{org}",
    "title": "{title}", "author": "{author.login}", "branch": "{headRefName}",
    "additions": {additions}, "deletions": {deletions},
    "diffSize": {additions + deletions},
    "firstSeen": "{now ISO}", "status": "pending"
  }
  ```
- **Entry with `status: "reviewing"`**: skip (another run is working on it)
- **Entry with `status: "staged"` or `"posted"`**: check for new commits since last review:
  ```bash
  gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid'
  ```
  If `headRefOid` differs from `lastReviewedCommit`: check whether the update is merge-only before marking eligible:
  ```bash
  gh api repos/{org}/{repo}/pulls/{pr}/commits --paginate
  ```
  Find `lastReviewedCommit` in the commit list. Check if every commit after it has `parents.length >= 2` (i.e., all are merge commits — merge-from-base or merge-from-main). If yes: skip and print `Skipping #{pr} — merge-only update since {lastReviewedCommit[0..7]}`. If no (real code changes exist), or if the anchor commit is not found, or if the API call fails: eligible for re-review.
  If `headRefOid` is the same as `lastReviewedCommit`: skip.
- **Entry with `status: "cleaned"` or `"merged"`**: skip.

If a `pending` entry is missing `diffSize` (created before this field was added), populate
it from the `gh pr list` fetch before sorting.

#### Unresolved Comment Check

> **If `lastReviewedCommit` is set AND `headRefOid != lastReviewedCommit`: stop — do not run this check. Mark the PR eligible and proceed. New commits from the author unconditionally override all unresolved thread skip conditions.**

Only run the check below when BOTH of the following are true:
- `lastReviewedCommit` is not set (first review), OR `headRefOid == lastReviewedCommit` (head has not moved)
- i.e. there is no evidence the author has pushed anything new

Fetch reviews and comment timeline:
```bash
gh pr view {pr} --repo {org}/{repo} --json reviews,comments,commits
```

A **substantive unresolved comment** is one where ALL of the following are true:
- Author login does not contain `[bot]` and is not a known CI account
- Body is not a trivial acknowledgement: not "LGTM", "+1", "thanks", "approved", or emoji-only
- Posted after the most recent commit push date (the author has not pushed since)

Skip this PR if **any** of the following are true:
- Any reviewer (not `CURRENT_USER`, not a bot) has a `CHANGES_REQUESTED` review with no commits since that review
- Any reviewer has a substantive unresolved comment with no commits since that comment

Print: `Skipping #{pr} — unresolved feedback from @{login} ({type} on {date}). No commits since.`

### Pick Next PR

Selection is based on the **value of the review action**, not diff size. Each eligible PR
has a `state/reviews.json` entry with `status`, `posted`, `lastReviewedCommit`, and
`firstSeen`. Compare `lastReviewedCommit` to the PR's current head SHA to detect new
commits since the last review.

**Tier 1 — Re-review of posted reviews** (highest priority)
Entry has `status: "posted"` (or `posted: true`) AND the current head SHA differs from
`lastReviewedCommit`, AND the new commits are not merge-only (as determined by the
deduplication check above). The author pushed real code changes after seeing our feedback —
re-reviewing closes the loop and can unblock a merge.

**Tier 2 — First review of pending PRs**
Entry has `status: "pending"`, or the PR has no entry yet. Never been reviewed — give
it first feedback so every open PR gets coverage.

**Tier 3 — Stale unposted staged reviews — DO NOT auto-process**
Entry has `status: "staged"`, `posted: false`, and head SHA differs from
`lastReviewedCommit`. Do NOT pick these during a cron run: nobody has seen the staged
review yet, so refreshing it just burns the slot. Leave them stale. They are re-reviewed
only on demand via an explicit `/shipwright:review {org}/{repo}#{pr}` invocation (the
`/shipwright:review-staged` walkthrough already skips stale entries and directs the owner
there).

Pick the first PR from the highest non-empty tier. Within each tier, sort by `firstSeen`
ascending (oldest first) so no PR starves. `diffSize` is no longer used for ordering;
it may be used only as a final tie-breaker within the same `firstSeen` value.

If nothing to review:
```
No PRs need review.
```
Stop (with `[silent]` marker for cron).

---

## Step 4: Checkout into Worktree

```bash
git -C repos/{repo} fetch origin
git -C repos/{repo} worktree add worktrees/{repo}-{branch-slug} origin/{branch}
```

Branch slug = branch name with `/` replaced by `-`.

If the worktree already exists (prior interrupted run):
```bash
git -C repos/{repo} worktree remove worktrees/{repo}-{branch-slug} --force
git -C repos/{repo} worktree add worktrees/{repo}-{branch-slug} origin/{branch}
```

Update `state/reviews.json`: add or update the entry with `status: "reviewing"`.

All subsequent steps run from `worktrees/{repo}-{branch-slug}/`.

---

## Step 5: Gather Context

1. **PR metadata**:
   ```bash
   gh pr view {pr} --repo {org}/{repo} \
     --json number,title,author,headRefName,baseRefName,headRefOid,additions,deletions,changedFiles,body
   ```

2. **Diff against the correct base branch** (not always main):
   ```bash
   base=$(gh pr view {pr} --repo {org}/{repo} --json baseRefName -q '.baseRefName')
   git diff "$base"...HEAD
   ```

3. **Changed files**: extract from the diff

4. **CI status** via Actions API (not `gh pr checks` -- broken with PATs):
   ```bash
   gh api "repos/{org}/{repo}/actions/runs?branch={branch}&per_page=5" \
     -q '.workflow_runs[] | "\(.name): \(.status) \(.conclusion)"'
   ```

5. **Existing reviews and comments**:
   ```bash
   gh pr view {pr} --repo {org}/{repo} --json comments,reviews
   ```

6. **CLAUDE.md files**: read root CLAUDE.md + CLAUDE.md files in directories containing changed files

7. **Test-readiness context** (optional): try to read `worktrees/{repo}-{branch-slug}/docs/test-readiness/test-system.md`. If absent, note that no repo-specific test-readiness doc exists. When the changed files include any path that looks like a test file — by common conventions across languages (e.g. files named or located in a way that signals they contain tests, such as files in `test/`, `tests/`, `spec/`, or `__tests__/` directories, or files whose names follow typical test-naming conventions for the project's language), also extract the "## Testing" section from the root CLAUDE.md (if present). Use the project's language and toolchain (visible from the diff and CLAUDE.md) to recognise test files — do not apply a fixed set of glob patterns. Combine both pieces into `testReadinessContext`. If neither produces content, `testReadinessContext` is absent — omit it entirely from the subagent prompt.

Apply the unresolved comment check from Step 3 using the fetched `reviews` and `comments`
(they were just fetched above — no extra API call needed). **If `lastReviewedCommit` is set AND
`headRefOid != lastReviewedCommit`: skip this check entirely and continue — head has moved,
re-review unconditionally.** Only run the check for first reviews (no `lastReviewedCommit`) or
when the head has not moved (`headRefOid == lastReviewedCommit`). If any substantive unresolved
feedback is found: update `state/reviews.json` status to `pending`, skip this PR,
and return to Step 3b to pick the next candidate.

---

## Step 6: Classify Changes by Domain

Before reading individual files, build a structural picture of what kind of work this PR does. Work from the PR body, commit messages, and file list:

- **Why**: What problem is this solving? What's the motivation? (PR body, linked issues, commit messages)
- **What changed**: High-level summary of affected areas — which features, services, or layers are touched
- **View changes**: Any new or modified pages, components, or UI flows — identify business logic changes, not just layout tweaks
- **API changes**: New, removed, or modified endpoints; changed request/response shapes; auth changes; new event streams (SSE, WebSocket)
- **Database changes**: New tables or columns, dropped columns, index changes, migrations, schema-affecting model changes
- **Architecture changes**: New services or packages, new ways of exposing functionality (new route groups, new event types, new integrations), changes to service boundaries
- **Breaking changes**: Any changes that break backwards compatibility — removed endpoints, changed request/response shapes, renamed fields, dropped columns, changed auth semantics, changed event contracts. Assume rolling deployments; clients and servers don't update atomically.
- **Testing changes**: Classify whether the PR is "test-touching" (modifies or adds test files) or "untested logic" (adds production code with no corresponding test additions). Identify test files using the project's language and toolchain — look at the diff context, the CLAUDE.md stack description, and common conventions for that language rather than applying a fixed set of filename patterns. Note which test files were added, modified, or removed. If neither applies (pure refactor of existing tested code, docs-only, etc.), note "none".

Note which categories are present (even if "none") — this drives review focus and the Slack summary.

---

## Step 7: Deep Review (dispatch `shipwright:code-reviewer` subagent)

Delegate the per-file review to the bundled `shipwright:code-reviewer` subagent. This
keeps review context isolated from the main thread (policy, queue, posting).

Dispatch via the Agent tool with `subagent_type: "shipwright:code-reviewer"` and pass
a single prompt block containing:

- **PR metadata** — `number`, `title`, `author`, `headRefName`, `baseRefName`, `headRefOid`
- **Full diff** — the `git diff "$base"...HEAD` output from Step 5.2
- **Changed files** — the list extracted in Step 5.3
- **CLAUDE.md contents** — root CLAUDE.md + any CLAUDE.md in directories containing
  changed files (from Step 5.6). Include each as a labeled block so the subagent knows
  which directory it governs.
- **`acceptanceCriteria`** — if the PR maps to a shipwright task, paste the criteria;
  otherwise omit the field
- **`testReadinessContext`** — contents of `docs/test-readiness/test-system.md` plus the
  Testing section of the repo's CLAUDE.md (gathered in Step 5.7); omit this field entirely
  when no test-readiness content was gathered (the subagent falls back to the universal
  baseline in `references/test-readiness-tenets.md` when the field is absent)
- **Policy** — pass `min_confidence` and `max_findings` from Step 1

The subagent returns a JSON object with `summary`, `findings[]`, `strengths[]`,
`recommendation`, and `recommendation_reason`. Parse it and carry the data into Step 8.

If the subagent returns malformed JSON, retry once with a reminder of the schema. If it
still fails, fall back to an inline review in the main thread using the same rules
(see `agents/code-reviewer.md` for the canonical rule set).

---

## Step 8: Score and Classify Findings

The subagent has already applied confidence scoring and verification (pre-existing
filter, CLAUDE.md endorsement check, silent-failure detection, breaking-API rule,
acceptance-criteria check). This step applies policy thresholds from `state/agent-policy.md`.

| Range | Category | Meaning |
|-------|----------|---------|
| 90-100 | Critical | Bug, CLAUDE.md violation, breaking API change |
| 75-89 | Important | Likely to cause problems |
| 50-74 | Suggestion | Valid concern, lower impact |
| < 50 | Discard | Nitpick or false positive |

Apply policy thresholds to the subagent's `findings[]`:
- Drop findings below `min_confidence` (default 75)
- Trim to `max_findings` (default 5), removing lowest confidence first
- Group remaining findings by their `severity` field (`critical`, `important`, `suggestion`)

**Keep it tight.** A good review has 2-5 actionable items. If the subagent returned
more, trim to the highest-confidence few.

---

## Step 9: Write Review File

Write `state/reviews/PR_REVIEW_{pr}.md`:

```markdown
# PR Review: #{pr} - {title}

**Author**: @{author}
**Branch**: {head} -> {base}
**Date**: {date}
**Reviewed commit**: {head_sha}

## Summary

{Brief description of what this PR does}

## Change Summary

**Why**: {motivation — problem being solved or feature being delivered}

**What changed**: {high-level summary of affected areas}

**View changes**: {new/modified pages or UI flows with business logic impact, or "none"}

**API changes**: {new, removed, or modified endpoints; shape changes; new event mechanisms (SSE, WebSocket), or "none"}

**Database changes**: {schema changes — tables, columns, indexes, migrations, or "none"}

**Architecture changes**: {new services, new ways of exposing functionality, service boundary changes, or "none"}

**Breaking changes**: {removed endpoints, changed shapes, renamed fields, dropped columns, auth changes — or "none"}

**Testing changes**: {test files added/modified/removed and classification: "test-touching", "untested logic", or "none"}

## CI Status

{Current status of checks}

## Critical Issues ({count})

### 1. {Issue title}
- **File**: `path/to/file.ts:123`
- **Confidence**: 95
- **Issue**: {description}
- **Suggestion**: {fix, if applicable}

## Important Issues ({count})

### 1. {Issue title}
...

## Suggestions ({count})

- {suggestion with file:line reference}

## Strengths

- {What's done well -- keep brief}

## Recommendation

{APPROVE or COMMENT}
{One-sentence reasoning}
```

### Re-Review (Update)

If this PR was reviewed before (entry in reviews.json with `reviewCount >= 1`):

Append an update section instead of creating a new file:

```markdown
---

## Review Update - {date}

### New Commits Since Last Review

- {sha}: {message}

### Prior Findings Resolution

| Finding | Status | Evidence |
|---------|--------|----------|
| {issue 1} | Addressed | Fixed in `file.ts:45` |
| {issue 2} | Partial | Logging added but no error ID |
| {issue 3} | Not addressed | Still missing validation |

### New Issues ({count})
...

### Updated Recommendation

{APPROVE or COMMENT}
**Previous**: {previous verdict}
**Now**: {updated verdict with reasoning}
```

---

## Step 10: Build Review JSON

Follow `references/post-review-guide.md` for the full mechanics.

**Self-review event override**: If the PR's `author.login == CURRENT_USER`, set `event: "COMMENT"`
regardless of the review outcome — GitHub rejects self-APPROVE via the API. The actual verdict
(`APPROVE` or `COMMENT`) is still recorded faithfully in the review file so the deploy skill
can read the verdict directly from the GitHub review body.

Write `state/reviews/pr_review_{pr}.json`:

```json
{
  "commit_id": "{head_sha}",
  "body": "{concise verdict}",
  "event": "APPROVE|COMMENT",
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 123,
      "side": "RIGHT",
      "body": "Comment text"
    }
  ]
}
```

**Diff-line mapping**: for each finding with a `file:line` reference, check if the
line is in the diff (`git diff {base}...HEAD -- {file}`). Only lines within diff
hunks are valid for inline comments. Move others to the review body.

**Event selection** (from policy `allowed_events`):
- If **any** finding at `important` (75-89) or `critical` (90-100) severity remains
  after threshold filtering: `COMMENT` — no exceptions
- If all remaining findings are `suggestion` level (50-74) or there are no findings:
  `APPROVE`
- Never `REQUEST_CHANGES`

Inline comments are included regardless of verdict. The verdict signals whether the PR
should be held; the inline comments convey the specific feedback to the author.

---

## Step 11: Post or Stage

### If `auto_post_reviews` is true (policy):

1. Submit via GitHub API:
   ```bash
   gh api -X POST /repos/{org}/{repo}/pulls/{pr}/reviews \
     --input state/reviews/pr_review_{pr}.json
   ```
2. Capture `html_url` from response
3. Update `state/reviews.json`: `posted: true`, `postedAt: now`, `status: "posted"`
4. Print: `Posted review for #{pr}: {html_url}`
5. Post Slack message (see below)

### If `auto_post_reviews` is false (default):

1. Update `state/reviews.json`: `status: "staged"`
2. Post Slack message to the configured channel (see below)
3. Print: `Review staged for #{pr}. Slack notification sent.`

### Slack Message (both paths)

Send to the configured engineering channel:

```
*PR #{pr}: {title}*
{url}

*Why:* {motivation from Change Summary}

*What changed:*
{high-level summary from Change Summary}

*View changes:* {value or "none"}
*API changes:* {value or "none"}
*Database changes:* {value or "none"}
*Architecture changes:* {value or "none"}
*Breaking changes:* {value or "none"}
*Testing changes:* {value or "none"}

*Verdict:* {APPROVE|COMMENT} — {one-line reasoning}
{if staged: Post with: /shipwright:review {org}/{repo}#{pr}}
```

Use the Slack MCP tool if available. If no Slack integration is configured, print the formatted message.

---

## Step 12: Update reviews.json

Update the entry for this PR:

```json
{
  "lastReviewedAt": "{now}",
  "lastReviewedCommit": "{head_sha}",
  "reviewCount": "{increment}",
  "reviewFile": "state/reviews/PR_REVIEW_{pr}.md",
  "verdict": "{APPROVE|COMMENT}",
  "findingsCount": "{count}",
  "posted": "{true|false}",
  "postedAt": "{timestamp|null}",
  "status": "{staged|posted}"
}
```

Write `state/reviews.json`.

**Never update task status when posting a review.** The deploy skill looks up tasks by PR number (expecting `status: 'pr_open'`) to perform post-deployment tracking — changing status here breaks that linkage. Task status transitions are owned by the deploy skill (`pr_open` → `deployed`).

---

## Step 13: Enrich Metrics (if shipwright task)

If the PR maps to a task in the task store (via `taskId`):

1. Find the task's planning folder: `planning/{session}/`
2. Read `planning/{session}/metrics.jsonl`
3. Find the line matching this task ID

4. Compute enrichment fields:

   **Structured findings** (from the subagent `findings[]` returned in Step 7):
   - Map each finding to `{category, severity, resolved}` where:
     - `category`: the finding category (e.g., "silent-failure", "breaking-api", "missing-test", "type-error"). Derive from the finding's type or subject.
     - `severity`: one of `"critical"`, `"important"`, or `"suggestion"` (from Step 8 classification)
     - `resolved`: `false` (at the time of review, findings are unresolved)
   - `findings_count`: integer count of findings (for backward compat — consumers that read `review.findings` as an integer should use this field instead)

   **Review latency** (`review_latency_h`):
   - Read the task's `prCreatedAt` field from the task store
   - Compute: `(Date.now() - Date.parse(prCreatedAt)) / 3600000` — float, hours from PR creation to verdict
   - If `prCreatedAt` is missing or unparseable, omit `review_latency_h`

   **Rework cycles** (`rework_cycles`):
   - Fetch commits and reviews for the PR:
     ```bash
     gh pr view {pr} --repo {org}/{repo} --json commits,reviews
     ```
   - If the `gh` command fails, set `rework_cycles = 0` and emit a warning log: `echo "[shipwright] warning: failed to fetch PR commits/reviews — rework_cycles defaulting to 0" >&2`
   - Find the earliest review event's `submittedAt` timestamp (from the `reviews` array, sorted ascending). If no review events exist, `rework_cycles = 0`.
   - Count commits whose `committedDate` is strictly after that earliest `submittedAt` timestamp.
   - `rework_cycles` = that count (integer)

5. Add the `review` object:
   ```json
   "review": {
     "verdict": "{verdict}",
     "findings": [{"category": "{category}", "severity": "{severity}", "resolved": false}],
     "findings_count": {count of findings array — integer, for backward compat},
     "fixes_applied": 0,
     "agents": ["single-pass"],
     "review_latency_h": {float hours from prCreatedAt to now, or omit if unavailable},
     "rework_cycles": {integer count of commits after first review event}
   }
   ```
6. Write back

Resolve PostHog script (silent):
```bash
POSTHOG_SCRIPT=$(find ~/.claude/plugins/cache -name "posthog_send.py" -path "*/shipwright/*" 2>/dev/null | head -1)
```

If set, fire `shipwright_task_reviewed` (the canonical review event — `shipwright_review_complete` is its historical name; dashboards alias both). Pass the same `fixes_applied`/`agents` written to the `review` object above so PostHog review aggregates match the JSONL:

Build the PostHog argument list, only including optional fields when their values are available:
```bash
POSTHOG_ARGS="pr={pr} verdict={verdict} findings={findingsCount} findings_count={findingsCount} rework_cycles={rework_cycles} fixes_applied=0 'agents=[\"single-pass\"]'"
# Only append review_latency_h when prCreatedAt was available and parseable
if [ -n "{review_latency_h}" ]; then
  POSTHOG_ARGS="$POSTHOG_ARGS review_latency_h={review_latency_h}"
fi
python3 "$POSTHOG_SCRIPT" shipwright_task_reviewed \
  --project {repo} --task {taskId} \
  $POSTHOG_ARGS
```

---

## Step 14: Targeted PR (argument provided)

When invoked with a specific PR (e.g. `/shipwright:review app-vitals/shipwright#123` or
`/shipwright:review 123`):

1. Parse the argument: extract `org`, `repo`, and `pr` number. For bare numbers,
   infer `org/repo` via:
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks/repo" | jq -r '.repo // empty'
   ```
   Fall back to the current workspace repo if the command fails.
2. Read `state/reviews.json`, find the entry for this PR.

**If entry exists with `status: "staged"`** — check for drift, then post:

> **Design note**: When `auto_post_reviews` is false, the cron stages reviews and
> notifies the owner. Explicitly targeting a staged PR (`/shipwright:review {pr}`) IS
> the posting confirmation — the owner ran the command knowing a review is staged.
> No additional confirmation prompt is needed; targeted invocation is the approval gesture.

**2a. Head-SHA drift check** — before anything else, fetch the current head commit:
```bash
gh pr view {pr} --repo {org}/{repo} --json headRefOid --jq '.headRefOid'
```
Compare to `lastReviewedCommit` in the reviews.json entry.

If `headRefOid != lastReviewedCommit` (author pushed new commits since the review was staged):
- Do **not** post the stale review body.
- Update `state/reviews.json`: `status: "reviewing"`
- Print:
  ```
  Staged review is stale — {pr} has new commits since the review was written ({lastReviewedCommit[0..7]} → {headRefOid[0..7]}).
  Re-reviewing now.
  ```
- Continue from **Step 4** (checkout into worktree) with this PR as the target.
  The Step 9 "Re-Review (Update)" mechanics will append an update section to the
  existing `state/reviews/PR_REVIEW_{pr}.md` and re-stage the entry.
- Stop the post flow here.

**2b. Re-fetch for new unresolved feedback** before posting (only reached when head SHA matches):
```bash
gh pr view {pr} --repo {org}/{repo} --json reviews,comments,commits
```
Apply the unresolved comment check from Step 3, but restricted to feedback that arrived
**after `lastReviewedAt`** in the reviews.json entry.

If any substantive unresolved comments or `CHANGES_REQUESTED` reviews arrived since the
review was staged:
- Update `state/reviews.json`: `status: "staged"`, `needsRereviewReason: "{summary}"`
- Print:
  ```
  Not posting — new unresolved feedback arrived since the review was staged:
  - @{login} ({date}): "{first 120 chars of body}"
  ...
  Review remains staged. Address the feedback, then re-run /shipwright:review {org}/{repo}#{pr}.
  ```
- Stop.

3. Read `state/reviews/PR_REVIEW_{pr}.md` and extract the verdict and findings summary
4. Print what is about to be posted so the owner can see it before the API call fires:
   ```
   Posting staged review for #{pr}: {title}
   Verdict: {APPROVE|COMMENT} — {findingsCount} findings
   {One-line key findings summary, or "No blocking issues" if clean}
   Review file: state/reviews/PR_REVIEW_{pr}.md
   ```
5. Read `state/reviews/pr_review_{pr}.json`
6. Submit:
   ```bash
   gh api -X POST /repos/{org}/{repo}/pulls/{pr}/reviews \
     --input state/reviews/pr_review_{pr}.json
   ```
7. Capture `html_url`
8. Update `state/reviews.json`: `posted: true`, `postedAt: now`, `status: "posted"`
9. Print: `Posted review for #{pr}: {html_url}`
10. Post Slack message using the format from Step 11

**If no entry or entry is not staged** — review it:
3. Skip Step 3 (queue building) and go directly to Step 4 (checkout) with this
   specific PR as the target.

---

## Review Quality Rules

These rules are non-negotiable regardless of policy settings:

- **Verify before flagging**: check actual code, not just the diff. Confirm library
  versions, check if both branches of a conditional do the same thing.
- **Check scope**: `git show {base}:{file}` -- if the issue exists on the base branch,
  it's out of scope.
- **Don't echo CI**: don't call out failing tests unless confident your findings are
  the cause.
- **Don't contradict CLAUDE.md**: don't suggest patterns the project explicitly avoids.
- **No filler language**: no "FYI", "Note:", "Just a heads up". Be direct.
- **Keep it tight**: 2-5 actionable items. Drop low-confidence suggestions and nitpicks.
- **Organize by file and line**: list issues in diff order.
- **Never REQUEST_CHANGES**: only APPROVE or COMMENT.
- **APPROVE means clean**: any finding at important or critical severity means COMMENT —
  APPROVE is reserved for PRs with no blocking concerns (suggestions only, or none at all).
- **Check for unresolved feedback first**: don't approve over substantive unresolved feedback from others.
- **Concise approvals**: if all items are addressed with no new issues, a brief APPROVE
  to unblock is more valuable than a detailed duplicate review.
- **Breaking API changes**: assume rolling deployments. Flag removed endpoints, changed
  shapes, renamed fields as critical.

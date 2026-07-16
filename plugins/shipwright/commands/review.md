---
description: Review a specific open PR -- deep single-pass review with inline comments, policy-controlled posting
argument-hint: "org/repo#number"
---

# Review

Evaluate open PRs and post findings. Scope: review only — no patching, merging, or deploying.

PR tracking state — claimed commit SHAs, review state, and staging status — lives in the
task store PR API (`$SHIPWRIGHT_TASK_STORE_URL/prs`). This is shared state across agents:
claims are atomic, so two agents won't review the same commit simultaneously. The review
narrative itself is still written locally to `state/reviews/PR_REVIEW_{pr}.md` and
`state/reviews/pr_review_{pr}.json` for posting.

> **Task store setup:** This command updates task status in the Shipwright task store after review. If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke `/shipwright:task-store` for setup instructions.

---

## Arguments

`$ARGUMENTS` is **required** — this command always targets one specific PR. There is no
self-scan/queue-building mode; the caller (loop orchestrator or a human) must name the PR.

Parse `$ARGUMENTS`:
- `org/repo#number` (e.g. `app-vitals/shipwright#123`): target a specific PR. If a staged
  review exists and has gone stale (new commits since staging), refresh it. Otherwise
  review it fresh. This command never posts a staged review — use `/shipwright:review-staged`
  for that.
- `number` or `#number`: same, using the repo from the task store API

**No arguments**: respond `[silent]` and stop immediately — before any GitHub or task
store query (i.e. before Step 1). This is the expected outcome for a manual invocation
without a target; the loop orchestrator always passes a PR id, so this path is only hit
when a human runs `/shipwright:review` with no argument.

---

## Step 1: Load Policy

Read `state/agent-policy.md`. If the file doesn't exist, use these conservative defaults:

| Setting | Default |
|---------|---------|
| `auto_post_reviews` | false |
| `allowed_events` | [COMMENT, APPROVE] |
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

1. List PR records for each configured repo:
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}" | jq -c '.prs[]'
   ```
2. For each record whose `reviewState` is `in_progress`, `posted`, or `approved`:
   - Check if the PR is merged or closed: `gh pr view {pr} --repo {org}/{repo} --json state -q '.state'`
   - If `MERGED` or `CLOSED`:
     - Remove the worktree if it exists: `git -C repos/{repo} worktree remove worktrees/{repo}-{branch-slug} --force 2>/dev/null`
     - Mark the record terminal in one PATCH:
       ```bash
       curl -sf -X PATCH \
         -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
         -H "Content-Type: application/json" \
         "$SHIPWRIGHT_TASK_STORE_URL/prs/{record.id}" \
         -d "{\"state\": \"merged\", \"mergedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >/dev/null
       ```
       `state: "merged"` is the terminal state — no further status progression is needed.
3. Remove stale worktrees older than `cleanup_after_days`:
   ```bash
   find worktrees/ -maxdepth 1 -type d -mtime +{cleanup_after_days} -exec basename {} \;
   ```
   For each, remove via `git worktree remove`.
4. If any cleaned: print `Cleaned {N} worktrees`

---

## Step 3: Resolve Current User and Target

Resolve the current GitHub CLI user once and remember the value — substitute it directly
into all subsequent commands that need it:

```bash
gh api /user -q '.login'
```

Staged reviews (`staged: true` records) are entirely out of scope for this command —
listing, walking, and posting them is owned exclusively by `/shipwright:review-staged`.
This command only ever produces or refreshes review content; see Step 14 for the one
exception (refreshing a stale staged review on explicit targeted invocation).

The target PR is `$ARGUMENTS`, already validated as present in the Arguments section
above. Step 14 parses it into `org`/`repo`/`pr`, fetches the PR record, and runs the
dedup check before checkout — see Step 14 for the full targeted flow.

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

### Claim using pre-captured commit SHA

`LAST_REVIEWED_COMMIT` was already captured in Step 14 from the PR record fetched during
the dedup check (empty if no record existed). The claim will overwrite `commitSha` with the
new head — `LAST_REVIEWED_COMMIT` preserves the pre-claim value without an extra fetch.
Use it in Steps 5 and 9.

Then claim the PR atomically at the current head. Fetch the head SHA first:
```bash
headRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```
```bash
PR_CLAIM=$(curl -s -o /tmp/pr_claim.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"{headRefOid}\"$([ -n \"{taskId}\" ] && echo \", \\\"taskId\\\": \\\"{taskId}\\\"\" || true)}")
```
- `201` (new) or `200` (update): claimed. Capture `.id` from `/tmp/pr_claim.json` as
  `PR_RECORD_ID`; the claim sets `reviewState: "in_progress"`.
- `409` (conflict): another agent holds the claim at this commit. Remove the worktree
  (`git -C repos/{repo} worktree remove worktrees/{repo}-{branch-slug} --force 2>/dev/null`),
  respond `[silent]`, and stop — there is no other PR to fall back to in explicit-target mode.

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

`lastReviewedCommit` is the `LAST_REVIEWED_COMMIT` value saved from the pre-claim record in
Step 14 (the record's `commitSha` before the claim overwrote it).

#### Unresolved Comment Check

Before writing the review, check whether a human is already mid-conversation on this PR and
hasn't pushed since — don't talk over them.

**If `lastReviewedCommit` is set AND `headRefOid != lastReviewedCommit`: skip this check
entirely and continue — head has moved, re-review unconditionally.** New commits from the
author unconditionally override all unresolved thread skip conditions. Only run the check
below for first reviews (no `lastReviewedCommit`) or when the head has not moved
(`headRefOid == lastReviewedCommit`).

Using the `reviews` and `comments` fetched above (no extra API call needed), a
**substantive unresolved comment** is one where ALL of the following are true:
- Author login does not contain `[bot]` and is not a known CI account
- Body is not a trivial acknowledgement: not "LGTM", "+1", "thanks", "approved", or emoji-only
- Posted after the most recent commit push date (the author has not pushed since)

If **any** of the following are true, this PR has substantive unresolved feedback:
- Any reviewer (not `CURRENT_USER`, not a bot) has a `CHANGES_REQUESTED` review with no commits since that review
- Any reviewer has a substantive unresolved comment with no commits since that comment

If substantive unresolved feedback is found: print
`Skipping #{pr} — unresolved feedback from @{login} ({type} on {date}). No commits since.`,
release the claim so the record returns to `pending`
(`POST $SHIPWRIGHT_TASK_STORE_URL/prs/{PR_RECORD_ID}/release`), respond `[silent]`, and stop.

8. **Renew the claim heartbeat**: context-gathering plus the deep review that follows can
   together run longer than the claim TTL, so renew the heartbeat now, before starting the
   review-writing phase — this keeps the claim alive so the stale-claim reaper does not reset
   it back to `pending` mid-review:
   ```bash
   curl -s -o /dev/null -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/{PR_RECORD_ID}/heartbeat"
   ```

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
  baseline in the testing-domain entries of `references/principles.md` when the field is
  absent)
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

If this agent reviewed this PR before — detected by the local file `state/reviews/PR_REVIEW_{pr}.md`
already existing (`test -f state/reviews/PR_REVIEW_{pr}.md`):

Append an update section instead of creating a new file. (Do not use `reviewCycles` from the
task store — another agent may have incremented it without this agent ever reviewing, so the
local file is the authoritative signal that *this* agent has a prior review to append to.)

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

**The `body` field MUST contain the literal phrase `Verdict: APPROVE` or `Verdict: COMMENT`**,
matching whichever verdict was selected below in Event selection — not just implied wording or
free-form approval prose. `check-patch.ts`'s `isSelfCleanApprove` (`VERDICT_APPROVE_LABEL =
/verdict\**\s*:\s*\**approve\b/i`) scans the GitHub-posted review body for this exact phrase to
recognize a clean self-approve on a self-authored PR (where `event` is forced to `COMMENT` above,
since GitHub blocks self-APPROVE via the API). A body like "Clean conversion, all routes
verified, no blocking issues." reads as a genuine approval to a human but contains neither
`APPROVE` nor `Verdict: APPROVE`, so `isSelfCleanApprove` never matches it — the patch cron then
treats it as an unaddressed finding forever. Always lead the body with the literal `Verdict: ...`
label, on both the initial-review and re-review paths (Steps 10/11 run identically for both;
see Step 14's re-review flow).

Write `state/reviews/pr_review_{pr}.json`:

```json
{
  "commit_id": "{head_sha}",
  "body": "Verdict: APPROVE — Looks good, approved.",
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

For a COMMENT verdict, the `body` follows the same convention, e.g.
`"body": "Verdict: COMMENT — {one-line summary of the most important finding}"`.

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
3. Run Step 11b to mark the PR record posted.
4. Print: `Posted review for #{pr}: {html_url}`
5. Post Slack message (see below)

### If `auto_post_reviews` is false (default):

1. Mark the PR record staged, persisting the verdict so the APPROVE-first sort in
   `/shipwright:review-staged` works correctly. Both branches also release the claim
   (`claimedBy`/`claimedAt`/`heartbeatAt`/`phase` all cleared to `null`, mirroring
   `pull-request-service.ts`'s `patch()` claim-clearing) — the review-writing work is
   done regardless of posting status, so nothing should keep holding the claim:

   If `{verdict}` is `APPROVE`:
   ```bash
   curl -sf -X PATCH \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}" \
     -d '{"staged": true, "reviewState": "approved", "claimedBy": null, "claimedAt": null, "heartbeatAt": null, "phase": null}' >/dev/null
   ```

   If `{verdict}` is `COMMENT`:
   ```bash
   curl -sf -X PATCH \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}" \
     -d '{"staged": true, "reviewState": "posted", "claimedBy": null, "claimedAt": null, "heartbeatAt": null, "phase": null}' >/dev/null
   ```

   (`PR_RECORD_ID` is the claim response `.id` from Step 4.)
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

## Step 11b: Mark PullRequest Record Posted

Run this step immediately after posting a review. The only place this command posts is Step 11's `auto_post_reviews: true` path; `/shipwright:review-staged`'s `post it` action also runs this step (after its own staged-flag clear, which is the one thing this step doesn't do) since posting-then-completing is identical either way. Skip this step when the review is staged (not posted).

Use `{verdict}` and `PR_RECORD_ID` — from Step 10 and the claim in Step 4 respectively when called from this command; `record.reviewState == "approved" ? APPROVE : COMMENT` and `record.id` respectively when called from `/shipwright:review-staged`.

### 1. Confirm the record ID

```bash
if [ -z "$PR_RECORD_ID" ]; then
  echo "Warning: no PR record ID available — skipping"
else
```

Wrap steps 2–3 in the `else` branch and close with `fi` after step 3.

### 2. Mark review as posted

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "${SHIPWRIGHT_TASK_STORE_URL}/prs/${PR_RECORD_ID}/complete" >/dev/null 2>&1
```

### 3. Set agentId (and reviewState for APPROVE)

Set `agentId` from `$SHIPWRIGHT_AGENT_ID`. For APPROVE verdicts, also set `reviewState=approved`; for COMMENT/CHANGES_REQUESTED, set agentId only:

```bash
if [ "{verdict}" = "APPROVE" ]; then
  PATCH_DATA="{\"agentId\": \"$SHIPWRIGHT_AGENT_ID\", \"reviewState\": \"approved\"}"
else
  PATCH_DATA="{\"agentId\": \"$SHIPWRIGHT_AGENT_ID\"}"
fi
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "${SHIPWRIGHT_TASK_STORE_URL}/prs/${PR_RECORD_ID}" \
  -d "$PATCH_DATA" >/dev/null 2>&1
fi
```

**Never update task status when posting a review.** The deploy skill looks up tasks by PR number (expecting `status: 'pr_open'`) to perform post-deployment tracking — changing task status here breaks that linkage. Task status transitions are owned by the deploy skill (`pr_open` → `deployed`). This applies to the task store *task* record only; the PR *record* updates above (`complete`, `agentId`, `reviewState`) are expected.

---
## Step 14: Resolve and Claim the Target PR

This command always runs against a single explicitly-named PR (e.g.
`/shipwright:review app-vitals/shipwright#123` or `/shipwright:review 123`) — see the
Arguments section for the required no-argument `[silent]` stop.

1. Parse the argument: extract `org`, `repo`, and `pr` number. For bare numbers,
   infer `org/repo` via:
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
     "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -r '.repos[0] // empty'
   ```
   Fall back to the current workspace repo if the command fails.
   **Limitation**: bare numbers only check the first configured repo (`repos[0]`). Multi-repo agents should use the full `org/repo#number` form to target a PR in any repo beyond the first.
2. Fetch the PR record from the task store:
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&prNumber={pr}" | jq -c '.prs[0] // empty'
   ```
   Capture the record's `id` as `PR_RECORD_ID` and `commitSha` as `lastReviewedCommit`.

**This command never posts a staged review — posting a staged review is owned exclusively
by `/shipwright:review-staged`.** `/shipwright:review` only ever produces or refreshes
review content. The one thing a targeted invocation does with an existing staged record
is refresh it if it's gone stale — nothing more.

**If a record exists with `staged: true`**:

Fetch the current head commit and compare to `record.commitSha` (`lastReviewedCommit`):
```bash
gh pr view {pr} --repo {org}/{repo} --json headRefOid --jq '.headRefOid'
```

- **`headRefOid == record.commitSha`** (no new commits — the staged review is still
  current, nothing to refresh). Translate `record.reviewState` to a verdict the same way
  `/shipwright:review-staged` does (`approved` → APPROVE, `posted`/`in_progress` → COMMENT),
  then print:
  ```
  #{pr} already has a staged review ({verdict}) waiting on a decision.
  Run /shipwright:review-staged to post, skip, or discuss it.
  ```
  Stop.
- **`headRefOid != record.commitSha`** (author pushed new commits since staging — the
  staged review is stale and needs a refresh). Re-claim the record at the new head to
  flip it to `in_progress`:
  ```bash
  curl -sf -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
    -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"{headRefOid}\"}" >/dev/null
  ```
  Print:
  ```
  Staged review is stale — {pr} has new commits since the review was written ({record.commitSha[0..7]} → {headRefOid[0..7]}).
  Re-reviewing now.
  ```
  Continue from **Step 4** (checkout into worktree) with this PR as the target. The
  Step 9 "Re-Review (Update)" mechanics append an update section to the existing
  `state/reviews/PR_REVIEW_{pr}.md`, and Step 11 re-stages the record — the same
  policy-gated staging path any other review goes through. This command never posts
  it; running `/shipwright:review-staged` afterward is how the owner acts on it.

**If no record or record is not staged** — review it:

3. **Check if the PR was already reviewed at the current commit** (defense-in-depth dedup):

   If a record exists (from Step 14.2, `lastReviewedCommit` is non-empty) AND
   `record.reviewState` is `posted` or `approved` (a review was actually posted, not just
   claimed and abandoned — see `release()`, which sets `reviewState: "pending"` on an
   incomplete claim), fetch the current head commit:
   ```bash
   gh pr view {pr} --repo {org}/{repo} --json headRefOid --jq '.headRefOid'
   ```
   Compare to `record.commitSha` (`lastReviewedCommit`). If `headRefOid == record.commitSha`
   (the commit has already been reviewed and there are no new commits):
   - Print:
     ```
     Skipping #{pr} — already reviewed at this commit ({headRefOid[0..7]}), nothing to do.
     ```
   - Stop.

   If no record exists (first review), or `record.reviewState` is `pending` (claimed but
   never completed — never actually reviewed), or `headRefOid` differs from
   `record.commitSha` (new commits exist), proceed to Step 4 below.

4. Go directly to Step 4 (checkout) with this specific PR as the target.

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

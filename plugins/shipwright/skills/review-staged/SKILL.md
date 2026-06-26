---
name: review-staged
description: Walk through staged PR reviews from the task store conversationally — APPROVEs first, then COMMENTs, smallest diff to largest within each. For each PR, present a concise summary and accept owner direction (post, skip, draft, discuss). Use when asked to "drain the staged reviews", "walk through staged reviews", or "what's staged".
---

# Review Staged

Conversational walkthrough of staged reviews. The owner sees one PR at a time
and steers each with a verb. No reviews are posted without an explicit "post it".

This skill assumes `/shipwright:review` has already staged the reviews into the
task store (`staged: true`) and written review files to `state/reviews/PR_REVIEW_{pr}.md`
and `state/reviews/pr_review_{pr}.json`. It does **not** review new PRs and does
**not** merge anything — merging is handled exclusively by `/shipwright:deploy`.

---

## 1. Load state

Fetch staged PR records from the task store for each configured repo:

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&staged=true" | jq -c '.prs[]'
```

For each record, fetch current GitHub metadata (title, additions, deletions, headRefOid, url):

```bash
gh pr view {prNumber} --repo {org}/{repo} \
  --json number,title,author,headRefName,baseRefName,headRefOid,isDraft,reviews,commits,additions,deletions,url
```

`diffSize` = `additions + deletions`. Treat a record with `reviewState: "approved"` as an
APPROVE verdict; `reviewState: "posted"` as a COMMENT verdict. `reviewState: "in_progress"`
also maps to COMMENT — backwards compatibility for records staged before the verdict-persist
fix (those records had their verdict omitted from the staging PATCH).

If no staged records exist across all repos: print `No staged reviews. Run /shipwright:review to stage some.` and stop.

Resolve the current GitHub user once and remember it for the rest of the run:

```bash
gh api /user -q '.login'
```

---

## 2. Build the walkthrough order

Sort the staged entries:

1. **APPROVEs first** (`reviewState: "approved"`), then **COMMENTs** (`reviewState: "posted"`
   or `reviewState: "in_progress"` — the latter for backwards-compat with records staged
   before the verdict-persist fix)
2. Within each group, **smallest `diffSize` to largest**

Print the queue header so the owner sees what's coming:

```
Staged reviews ({N}) — APPROVEs first, smallest diff first within each group.

| # | PR | Repo | Title | Verdict | Diff |
|---|----|------|-------|---------|------|
| 1 | #123 | example-repo | Add feature X | APPROVE | +45/-12 (57) |
| 2 | #456 | example-repo | Fix bug Y | COMMENT | +120/-30 (150) |
```

---

## 3. For each PR — refresh, gate, present

Walk the queue in order. For each entry:

### 3a. Refresh PR state from GitHub

```bash
gh pr view {prNumber} --repo {org}/{repo} \
  --json number,title,author,headRefName,baseRefName,headRefOid,isDraft,reviews,commits,additions,deletions,url
```

### 3b. Apply skip gates (announce + skip, do not present)

- **Draft PR** (`isDraft == true`) — skip with: `Skipping #{pr} — PR is now a draft.`
- **Savepoint commits** — if any commit message in the recent commit list contains
  `savepoint`, `wip`, or `WIP` (case-insensitive), skip with:
  `Skipping #{pr} — savepoint/WIP commit on branch ({sha}: "{message}").`
- **Open CHANGES_REQUESTED from a teammate** — flag and skip with:
  `Skipping #{pr} — @{login} requested changes on {date} and there are no commits since.`
  (Use the same teammate-comment logic from `/shipwright:review` Step 3b: not a bot,
  not `CURRENT_USER`, no commits pushed after the review.)
- **Stale staged review** — if `record.commitSha` differs from the current `headRefOid`,
  skip with: `Skipping #{pr} — new commits since review was staged. Re-run /shipwright:review {org}/{repo}#{pr}.`

When a PR is skipped for any reason, leave its task store record untouched
(`staged: true` stays set). CHANGES_REQUESTED state is re-derived from GitHub on every run.

### 3c. Dependabot cross-check

If `author.login == "dependabot[bot]"` (or the entry has `author: "app/dependabot"`):

Read `state/dependabot-reviews.json`. If an entry exists for this PR, capture
`{status, recommendation}` and surface it in the presentation block (Step 3d) as
a `*Dependabot:*` line.

### 3d. Present the PR

Read `state/reviews/PR_REVIEW_{pr}.md` and extract:

- Title, author, branch
- Change Summary section (Why, What changed, Web view, API, Database, Architecture)
- Critical / Important / Suggestion findings (counts + headlines)
- Recommendation line

Fetch CI status:

```bash
gh api "repos/{org}/{repo}/actions/runs?branch={branch}&per_page=5" \
  -q '.workflow_runs[] | "\(.name): \(.status) \(.conclusion)"'
```

Print this block (and only this block — no extra commentary):

```
*PR #{pr}: {title}* — {url}
@{author} · {branch} → {base} · +{additions}/-{deletions} ({diffSize})

*Why:* {motivation}

*Changes*
- Web view:   {value or "none"}
- API:        {value or "none"}
- Database:   {value or "none"}
- Breaking:   {value or "none"}
- Arch:       {value or "none"}

*CI:* {one-line summary — e.g. "all green" / "lint failing" / "1 failure: build"}
{if dependabot: "*Dependabot:* tracked in dependabot-review ({status}, recommendation: {recommendation})"}

*Concerns ({count})*
- {Critical/Important findings, each on one line with file:line}
- ({N} suggestions/nits — show on request)

*Verdict:* {APPROVE | COMMENT} — {one-line reasoning from review file}
```

Then prompt:

```
What do you want to do? (post it / skip / next / draft it / discuss)
```

Stop and wait for the owner's response.

---

## 4. Handle the action

Match the owner's response:

### `post it`

Use the existing posting mechanics from `/shipwright:review` Step 14 (re-fetch
for new teammate feedback, then `gh api -X POST /repos/{org}/{repo}/pulls/{pr}/reviews`
with `state/reviews/pr_review_{pr}.json`).

After posting successfully, update the task store record:

1. Clear the staged flag:
   ```bash
   curl -sf -X PATCH \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/{record.id}" \
     -d '{"staged": false}' >/dev/null
   ```

2. Mark the review complete:
   ```bash
   curl -sf -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/{record.id}/complete" >/dev/null
   ```

3. Re-assert agentId and reviewState. `complete()` unconditionally sets `reviewState: "posted"`,
   so for APPROVE verdicts (where the staged record had `reviewState: "approved"`), explicitly
   re-assert `"approved"` in this PATCH — mirroring review.md Step 11b:
   ```bash
   if [ "{record.reviewState}" = "approved" ]; then
     PATCH_DATA="{\"agentId\": \"$SHIPWRIGHT_AGENT_ID\", \"reviewedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"reviewState\": \"approved\"}"
   else
     PATCH_DATA="{\"agentId\": \"$SHIPWRIGHT_AGENT_ID\", \"reviewedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
   fi
   curl -sf -X PATCH \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/{record.id}" \
     -d "$PATCH_DATA" >/dev/null
   ```

Print the posted review URL.

Move to the next PR.

### `skip`

Leave the task store record as `staged: true`. Do nothing. Move to the next PR.

### `next`

Same as `skip` — move on without action.

### `draft it`

Print the full review body and inline comments from `state/reviews/pr_review_{pr}.json`
(the JSON destined for the GitHub API). Format the inline comments as a list:
`{path}:{line} — {body}`. **Do not post.** Re-prompt for an action verb.

### Anything else (discussion)

Treat the response as a question or pushback. Engage conversationally — explain a
finding, look up code, run `git show` or `gh pr diff` as needed. **Do not post.**
After the discussion settles, re-prompt with the action verbs.

---

## 5. CI patch offer

When CI is failing on a staged PR, classify the failure:

- **Trivial** — formatting, linting, import ordering, type-only fixes
- **Non-trivial** — test failures, build errors, runtime issues

If trivial, offer:

```
CI is failing on {workflow}. Looks like a {format/lint} fix — want me to patch it?
(yes / no — I'll just flag it in the review)
```

If `yes`:
1. Check out the branch into a worktree (use the workspace's worktree convention:
   `~/worktrees/{repo}-{branch-slug}`)
2. Run the project's lint/format auto-fixer (per the toolchain — `bunx biome check --write`,
   `cargo fmt`, `golangci-lint run --fix`, etc.)
3. Commit with a clear message: `fix(ci): apply lint/format auto-fix`
4. Push to the PR branch
5. Print: `Pushed lint/format fix to {branch}. CI should re-run shortly. I'll wait.`
6. Loop back to 3a (refresh state) before re-presenting

If `no` or non-trivial: include the CI failure as a finding and continue with the
normal action prompt.

---

## 6. End of queue

When all staged entries have been processed (acted on or skipped):

```
Done. {posted}/{N} posted, {skipped}/{N} skipped.
```

---

## Notes

- This skill never auto-posts. Every post requires an explicit "post it" from the owner.
- This skill never merges. Merging is handled exclusively by `/shipwright:deploy`.
- This skill never re-reviews. If the head SHA has moved (current `headRefOid` differs from
  `record.commitSha`), it skips and points to `/shipwright:review {org}/{repo}#{pr}`.
- Use `gh` CLI for all GitHub interactions. Respect the active `GH_TOKEN` / `gh auth` context.
- The task store is the source of truth for staged state. No `state/reviews.json` reads or
  writes occur in this skill.

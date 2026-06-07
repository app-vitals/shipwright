---
name: triage-dependabot-prs
description: Scan all repos in `repos/` for open Dependabot PRs, triage new ones, and stage patrol-style comments for review. Use when asked to triage, scan, or review open Dependabot PRs across multiple repos. Does not post to GitHub — staged comments are reviewed conversationally before posting.
---

# Triage All Dependabot PRs

Scan every repo in `repos/` for open Dependabot PRs, triage new ones, and stage comments for review.

## 1. Load state

Read `state/dependabot-reviews.json`. Create `[]` if missing.

## 2. Sync closed and merged PRs

For each entry with `status` of `staged` or `posted`:

```bash
gh pr view {pr} --repo {org}/{repo} --json state -q '.state'
```

- `MERGED` → set `status: "merged"`, `mergedAt: <now>`
- `CLOSED` → set `status: "closed"`

## 3. Discover open Dependabot PRs

For each directory in `repos/`:

```bash
# Get owner/repo for this directory
git -C repos/{dirname} remote get-url origin
# Parse owner/repo from the URL (strip .git suffix, handle both https and ssh formats)

# List open Dependabot PRs
gh pr list --repo {owner}/{repo} --author "app/dependabot" --state open --json number,title,headRefName
```

For each open PR not already present in state with a non-terminal status (`pending`, `staged`, `posted`):
- Add a new entry: `{ pr, repo, org, title, branch, status: "pending", firstSeen: <now>, lastTriagedAt: null, recommendation: null, stagedFile: null, postedAt: null, mergedAt: null }`

## 4. Triage pending PRs

For each entry with `status: "pending"`:

Invoke the `triage-dependabot-pr` skill with `{pr} --repo {org}/{repo}`.

The skill writes the staged comment file and updates the state entry to `staged`. Collect the recommendation from the skill output.

Process serially — merging one PR can affect others.

## 5. Save state

Write the updated `state/dependabot-reviews.json`.

## 6. Report

Output a summary table of all active entries (skip `merged` and `closed`):

```
## Dependabot Triage Summary

| Repo | PR | Title | Recommendation | Status |
|------|-----|-------|---------------|--------|
| my-repo | #42 | Bump axios 1.6→1.7 | ✅ merge | staged |
| my-repo | #41 | Bump webpack 4→5 | 🛑 hold | staged |

New this run: N staged
Already staged: M
Merged/closed: P
```

If nothing to do: "No pending Dependabot PRs. All up to date."

Staged reviews are ready for conversational walkthrough — run through them with the agent to review and post.

## Notes

- Process PRs serially — don't parallelize, as merging one PR can create conflicts in others.
- If a PR has merge conflicts, note it in the summary — it may need a rebase first (`gh pr comment <number> --body "@dependabot rebase" --repo {owner}/{repo}`).
- Use `gh` CLI for all GitHub interactions. Respect the current `GH_TOKEN` / `gh auth` context.

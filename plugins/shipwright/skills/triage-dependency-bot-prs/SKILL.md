---
name: triage-dependency-bot-prs
description: Scan all repos in `repos/` for open PRs from Dependabot or Renovate, triage new ones, and post (or stage, per policy) patrol-style comments for review. Use when asked to triage, scan, or review open dependency-bot PRs across multiple repos.
---

# Triage All Dependency Bot PRs

Scan every repo in `repos/` for open PRs authored by Dependabot or Renovate, triage new ones, and post (or stage) comments for review.

## 1. Load state

Read `state/dependency-bot-reviews.json`. Create `[]` if missing.

## 2. Sync closed and merged PRs

For each entry with `status` of `staged` or `posted`:

```bash
gh pr view {pr} --repo {org}/{repo} --json state -q '.state'
```

- `MERGED` → set `status: "merged"`, `mergedAt: <now>`
- `CLOSED` → set `status: "closed"`

## 3. Discover open dependency-bot PRs

For each directory in `repos/`:

```bash
# Get owner/repo for this directory
git -C repos/{dirname} remote get-url origin
# Parse owner/repo from the URL (strip .git suffix, handle both https and ssh formats)

# List open PRs, once per bot author, then merge results
gh pr list --repo {owner}/{repo} --author "app/dependabot" --state open --json number,title,headRefName
gh pr list --repo {owner}/{repo} --author "app/renovate" --state open --json number,title,headRefName
```

Merge the two author-filtered lists, deduping by repo+PR number (a PR has exactly one author,
so the lists shouldn't overlap, but guard against double-counting regardless) — mirroring the
`check-dependency-bot-triage.ts` precheck script's own merge logic.

For each open PR not already present in state with a non-terminal status (`pending`, `staged`, `posted`):
- Add a new entry: `{ pr, repo, org, title, branch, status: "pending", bot: "dependabot" | "renovate", triagedCommitSha: null, firstSeen: <now>, lastTriagedAt: null, recommendation: null, stagedFile: null, postedAt: null, mergedAt: null }` — `bot` is whichever author list surfaced this PR.

## 4. Triage pending PRs

For each entry with `status: "pending"`:

Invoke the `triage-dependency-bot-pr` skill with `{pr} --repo {org}/{repo}`.

The skill posts (or stages, per policy) the comment and updates the state entry to `posted` or `staged` accordingly, along with `triagedCommitSha`. Collect the recommendation from the skill output.

Process serially — merging one PR can affect others.

## 5. Save state

Write the updated `state/dependency-bot-reviews.json`.

## 6. Report

Output a summary table of all active entries (skip `merged` and `closed`), reflecting each
entry's actual status:

```
## Dependency Bot Triage Summary

| Repo | PR | Title | Recommendation | Status |
|------|-----|-------|---------------|--------|
| my-repo | #42 | Bump axios 1.6→1.7 | ✅ merge | posted |
| my-repo | #41 | Bump webpack 4→5 | 🛑 hold | staged |

New this run: N posted, M staged
Already triaged: P
Merged/closed: Q
```

If nothing to do: "No pending dependency-bot PRs. All up to date."

## Notes

- Process PRs serially — don't parallelize, as merging one PR can create conflicts in others.
- If a PR has merge conflicts, note it in the summary — it may need a rebase first (`gh pr comment <number> --body "@dependabot rebase" --repo {owner}/{repo}` for Dependabot PRs, `@renovate rebase` for Renovate PRs).
- Use `gh` CLI for all GitHub interactions. Respect the current `GH_TOKEN` / `gh auth` context.

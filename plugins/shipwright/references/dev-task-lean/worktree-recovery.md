# Worktree and prior-session recovery (Step 4)

Moved from `commands/dev-task.md`. Paths: `${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo-slug}`,
`${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo-slug}-{branch-slug}` (branch slug: `/` → `-`).
Derive `GH_REPO` from `git remote get-url origin` (CWD is the workspace, not the repo).

## Reality check (always, regardless of task-store status)
A crashed session can leave a complete unpushed branch or a green open PR while the task still reads
`in_progress` or `pending`. `git pull`, then check: local branch (`branch --list`), remote branch
(`ls-remote --heads origin`), open PR (`gh pr list --head {branch} --state open`). None exist → fresh start.

If any exist, compare `git diff main...{branch}` to the acceptance criteria; if a PR exists also require
green CI (Actions API on the head SHA).
- **Complete and correct:** do not close or delete. Local-only → rebase and continue. PR exists → PATCH
  `{"status":"pr_open","pr":N}`, reuse/create the worktree, skip Step 5, resume at Step 6 (or Step 10 if CI green).
- **Incomplete, stale, or off-brief:** close the PR with a cleanup comment, delete the remote branch, remove
  any worktree for the branch (`worktree remove --force`, before `branch -D`, since git refuses to delete a
  checked-out branch), delete the local branch, then fresh start.

## Creating the worktree
- Branch absent on remote: `git -C {repo} worktree add {path} origin/main -b {branch}`.
- Present on remote with a merged PR (stale bundle branch): `git push origin --delete {branch}`, then fresh start.
- Present with an open PR or none (bundled task): `fetch origin`, then `worktree add {path} origin/{branch} --track -b {branch}`.
- Worktree already on disk: `worktree remove --force` first, then add.

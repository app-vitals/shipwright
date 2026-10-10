# Push, PR, and CI gate (Steps 9–9b)

Moved from `commands/dev-task.md`.

## Push and PR
Pre-push: `GET /verification-checks?taskId={id}&limit=1`; empty → record outcomes now (never blocks).
Existing open PR for the branch (bundled task) → push adds commits; set `pr`/`prCreatedAt` on the task; skip creation.
Otherwise write the body (Summary, Acceptance Criteria table, Test Plan) to `/tmp/shipwright-pr-body-{task-id}.txt` (task id
in the path; `/tmp` is shared across worktrees), `gh pr create --title ... --body-file ...`, then remove it. No heredocs in
the command string (they defeat permission glob matching).

## PR failure cleanup
PR creation fails after 2 retries → close orphaned PRs on the branch, delete the remote branch, remove the local branch,
print a cleanup summary, PATCH `{"status":"blocked","blockedReason":"pr_creation_failed"}`.

## CI gate
1. `gh pr view N --json mergeStateStatus`. `DIRTY` → fix loop (merge `origin/main`, resolve, push). `BEHIND` is fine; merge
   main only to resolve a real conflict.
2. Poll with the Actions API (agent PATs lack Checks API, so `gh pr checks` fails):
   `gh api "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=20"`. Chained in-Bash sleep loop, 30 s × 20 polls — never a
   scheduled wakeup (same heartbeat/reaper reason as `pre-ship-checks.md`, AGH-1.1). Judge the highest `run_number` per
   `workflow_id`. No runs after 60 s → `⏭ No CI checks configured`. Poll timeout counts as failure.
3. On failure collect per-job results and `gh run view {id} --log --failed | tail -200` (fall back without `--failed`);
   record `ci_checks` and a ≤100-char `ci_failures` line.
4. Fix loop: max 6 attempts; each a fresh `general-purpose` subagent (`run_in_background: false`) given the logs, the PR diff,
   and numbered prior attempts ("try a different approach"); it fixes, validates, commits `fix: ...`, pushes. Re-check merge
   state and CI after each.
5. Exhausted → print `CI GATE FAILED`, run PR failure cleanup, PATCH `{"status":"blocked","blockedReason":"ci_max_retries_exhausted"}`.

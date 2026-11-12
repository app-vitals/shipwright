# Plan: platform-release-fix

Repo: app-vitals/shipwright. Trigger: run 41556856044 / issue #4754.

## Root cause
The XPF-1.4 guard (scripts/platform-bump-branch-guard.ts, #4746) lists `origin/main..origin/chore/platform-release`.
After a squash-merge the PR's original commits (including patch-pass fixes) never appear in main by SHA, so a
leftover bump branch looks like it holds foreign commits forever. Nothing deletes the branch: `gh pr merge --squash --admin`
runs without `--delete-branch` and the repo has delete_branch_on_merge=false. The guard is meant to protect an *open*
bump PR, but fires with no PR open.

## Design
1. Guard only applies when an open PR exists on the bump branch; no open PR => stale branch, force-push allowed.
   Open-PR behavior (XPF-1.4) unchanged. Gate merge adds `--delete-branch`.
2. Remove the automated failure-issue pattern (open/comment on failure, close on success, `issues: write`) from all four
   workflows that use it: platform-release, platform-release-retry, check-chart-drift, library-chart-release. The retry
   workflow keeps its `<!-- platform-bump-exhausted -->` PR marker comment, so the PR carries the signal. Runs still go red.

## Tasks
| Task | Depends on | HITL |
|---|---|---|
| PBF-1.1 fix: bump branch guard only protects an open PR's branch | - | |
| PBF-1.2 ci: drop failure issues from platform-release + retry | PBF-1.1 (same file) | |
| PBF-1.3 ci: drop failure issues from chart-drift + library-chart-release | - | |

Safe to deploy standalone: yes for all. No breaking changes; no new secrets; no .claude/** paths.

## Decision Log
- Unblock for 1.1.0: deleted stale branch + re-dispatched (run 41558818444) at Dan's "whatever is easiest".
- Issue removal scope: Dan confirmed all jobs.

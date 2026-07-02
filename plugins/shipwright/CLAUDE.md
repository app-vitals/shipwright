# Shipwright Plugin — Design Constitution

This file is the design constitution for the Shipwright plugin. Before modifying any skill
file, evaluate the change against the principles below. Any change that violates a principle
needs an explicit justification and a corresponding update to the principle itself.

**Terminology note:** `dev-task`, `review`, `patch`, and `deploy` are implemented as commands
(`commands/`), not skills (`skills/`). This document uses "skill" as a conceptual label for
any invocable workflow unit.

---

## Independence Principles

Shipwright skills are designed to operate without requiring preconditions set by other
skills. A user or agent can invoke any skill at any time — against any PR, on any repo —
and the skill will discover what it needs from live state.

### 1. GitHub is the Source of Truth

Skills query GitHub directly for PR state, CI status, authorship, and review decisions.
Local file `state/reviews.json` is a cache — a convenient shortcut
when available, but never load-bearing.

Applies to: **review**, **deploy**, **patch**, **dev-task**

### 2. Task Store PR Record Is the Dedup Source

The task store `PullRequest` record (accessible via `GET /prs?repo=X`) is the source of
truth for review deduplication. `commitSha` on the record is compared to the current
`headRefOid` from GitHub to detect "new commits since last review" without re-fetching
history. Skills must not fail or behave incorrectly when no PR record exists — a missing
record means the PR has not been reviewed yet and should be treated as eligible.

Local files (`state/reviews/PR_REVIEW_{pr}.md`, `state/reviews/pr_review_{pr}.json`) hold
the review narrative (findings, verdict, inline comments) for posting to GitHub. They are
written by `/shipwright:review` and consumed by `/shipwright:review-staged`. They are not
dedup state — the task store record owns that.

Applies to: **review** (dedup by `commitSha`), **review-staged** (stale check via `commitSha`
vs current `headRefOid`), **deploy** (falls back to `gh pr view --json reviewDecision`
when no task store APPROVE record exists)

### 3. A PR Created Outside Shipwright Is Fully Serviceable

A PR opened by hand — directly via `gh pr create`, the GitHub UI, or any other tool — is
fully serviceable by Shipwright. It can be reviewed, patched, and deployed without any
prior setup. The skills discover the PR from GitHub and treat it identically to a PR they
created. No skill requires the PR to have been opened by `dev-task` or any other Shipwright
command.

**Scope note:** `review` operates across all open PRs in the repo — it is not limited to
PRs authored by the authenticated user. `patch` and `deploy` are scoped to the
authenticated user's own open PRs (matching by PR author), because they take write actions
(pushing fixes, merging) that should only be performed on PRs the agent owns.

Applies to: **review**, **patch**, **deploy**

### 4. Manual Human Actions Do Not Break Automation

Manual actions taken outside of Shipwright — a human approving a PR on GitHub, merging a
branch, pushing a fix, or resolving review comments directly — must not break automation.
Each skill checks current state at runtime rather than trusting the state it last recorded.

Applies to: **review** (re-checks headRefOid before re-posting), **deploy** (checks live
reviewDecision and CI before merging), **patch** (re-queries review threads and CI before
applying fixes)

### 5. No Skill Depends on Another Having Run First

Skills are invocable in any order. `deploy` does not require `review` to have run first.
`patch` does not require `dev-task` to have run first. `review` does not require
`plan-session` to have produced a task first. Each skill discovers its inputs independently
from GitHub and the file system at the time it runs.

Applies to: **all skills** — review, deploy, patch, dev-task, plan-session, research,
prd, refresh-plan

### 6. Skills Are Idempotent

Running the same skill twice against the same PR is idempotent — it produces the same
observable outcome. A second `review` run on an unchanged PR posts nothing (same
headRefOid already recorded). A second `deploy` run on an already-merged PR detects the
merged state and exits cleanly. A second `dev-task` run on a `pr_open` task does not open
a duplicate PR.

Applies to: **all skills** — review, deploy, patch, dev-task

---

## Precheck Contract

Precheck scripts (`scripts/check-review.ts`, `scripts/check-deploy.ts`,
`scripts/check-dev-task.ts`, `scripts/check-patch.ts`) are cron guards. They run before
a skill is invoked and exit 1 (no output) when there is clearly nothing to do, saving
an unnecessary Claude session.

### Rules

**Scripts are best-effort filters, not correctness gates.**
A precheck may exit 0 even when the skill ultimately finds nothing to do. That is expected
and acceptable. A false positive (unnecessary skill invocation) is far cheaper than a false
negative (skipping work that needed to happen).

**The skill is authoritative on what qualifies.**
The precheck approximates the skill's qualification logic using cheap GitHub queries. The
skill's own qualification checks are the canonical definition of readiness. If they
disagree, the skill wins — not the precheck.

**When skill qualification changes, the corresponding precheck must be audited.**
If `deploy.md` adds a new qualification requirement (e.g. a label check), `check-deploy.ts`
must be reviewed to ensure it does not over-filter. The precheck is a dependent of the
skill's qualification logic, not independent of it.

**Err permissive over restrictive.**
When uncertain whether a PR qualifies, the precheck should exit 0 and let the skill decide.
An over-trigger wastes one Claude session. An under-trigger silently skips work. The asymmetry
favors permissive: false positives are visible and self-correcting; false negatives are not.

### Scripts and What They Check

| Script | Guards | What it checks |
|---|---|---|
| `check-review.ts` | `review` cron | Open PRs with unreviewed commits (by headRefOid dedup against task store `/prs` records); respects `allow_self_review` policy |
| `check-deploy.ts` | `deploy` cron | Open PRs with `APPROVED` review decision and green CI; respects `allow_self_review` for self-authored PRs; skips a repo with an active Deploy workflow run, scoped per repo — a busy repo does not block ready PRs in other configured repos |
| `check-dev-task.ts` | `dev-task` cron | Pending tasks with all dependencies satisfied (task store `ready: true` query) |
| `check-patch.ts` | `patch` cron | Auto-updates BEHIND branches via `gh pr update-branch`; signals patch skill for unaddressed review findings, stuck-BEHIND branches (update-branch failures), merge conflicts, and failing CI; queries GitHub directly — does NOT read `state/reviews.json` |
| `check-review-patch.ts` | `review-patch` cron | Delegates to `check-patch.ts` + `check-review.ts`; exits 0 if either exits 0, covering the full scope of the review-patch orchestrator (unaddressed findings, failing CI, BEHIND branches, merge conflicts, and unreviewed commits) |

---

## System Cron Changes

System crons are the crons defined in `SYSTEM_CRONS` — they cover both the core shipwright loop (dev-task, review, patch, deploy) and maintenance tasks (entropy patrol, docs freshness, etc.). When a shipwright change adds, removes, or restructures any system cron, flag two questions during planning:

1. **Backward compatibility.** Will existing agents break when the new code ships but before their crons are updated? If yes, the PR needs a migration path baked in (flag, fallback, graceful no-op) so agents degrade cleanly rather than silently error.

2. **Agent migration.** Which agents are running the old cron pattern and need to be updated? There is no automated migration tooling yet — plan how the rollout will happen before committing to the change.

**New system crons always ship disabled.** Any cron added to `SYSTEM_CRONS` must have `enabled: false`. Enable it per-agent when ready. This avoids new crons firing unexpectedly on agents that haven't opted in. The exception is crons explicitly replacing a prior cron — but even then, add disabled, verify, then enable and disable the old one.

**review and patch are opt-in.** `shipwright-review-patch` is the default combined workflow and ships `enabled: true`. `shipwright-review` and `shipwright-patch` ship `enabled: false` — they exist for agents that want to run the two phases independently. To switch: disable `review-patch`, enable whichever individual crons you want.

---

## Environment Variables

See [`docs/configuration.md`](../../docs/configuration.md) for the full reference — plugin env vars (`SHIPWRIGHT_REPO_DIR`, `SHIPWRIGHT_WORKTREE_DIR`, task-store vars, etc.), agent env vars, and policy config.

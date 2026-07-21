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
skills. `dev-task`, `review`, `patch`, and `deploy` are explicit-target-only executors —
each requires an explicit argument (a task id for `dev-task`; an `org/repo#number` PR for
`review`/`patch`/`deploy`) and responds `[silent]` and stops immediately if invoked with no
argument. None of the four self-scans or discovers its own work. Candidate selection happens
once, upstream, before any of these commands is even dispatched (see "Candidate Selection"
below); what each command does independently of the others is re-validate the *current
state* of its named target against live GitHub/task-store data rather than trusting stale
state — not discover the target itself.

### 1. GitHub is the Source of Truth

Skills query GitHub directly for PR state, CI status, authorship, and review decisions.
Local state files are a cache — a convenient shortcut when available, but never
load-bearing.

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

**Scope note:** `review` is explicit-target-only — the caller (loop orchestrator or a human)
always names a specific PR (`org/repo#number`); there is no self-scan/queue-building mode.
Any PR is serviceable when named this way, regardless of author — it is not limited to PRs
authored by the authenticated user. `patch` and `deploy` are scoped to the authenticated
user's own open PRs (matching by PR author), because they take write actions (pushing fixes,
merging) that should only be performed on PRs the agent owns.

Applies to: **review**, **patch**, **deploy**

### 4. Manual Human Actions Do Not Break Automation

Manual actions taken outside of Shipwright — a human approving a PR on GitHub, merging a
branch, pushing a fix, or resolving review comments directly — must not break automation.
Each skill checks current state at runtime rather than trusting the state it last recorded.

Applies to: **review** (re-checks headRefOid before re-posting), **deploy** (checks live
reviewDecision and CI before merging), **patch** (re-queries review threads and CI before
applying fixes)

### 5. No Skill Depends on Another Having Run First

Skills do not require preconditions set by other skills. `deploy` does not require `review`
to have run first. `patch` does not require `dev-task` to have run first. `review` does not
require `plan-session` to have produced a task first. This is no longer about skills
self-discovering inputs in any order, though — `dev-task`, `review`, `patch`, and `deploy`
are dispatched with an explicit, already-selected target (a task id or a PR), chosen either
by a human invoking the command directly or by the `shipwright-loop` cron's
`loop-orchestrator.ts`, which merges candidates from `agent/src`'s per-phase qualification
functions (`check-dev-task.ts`, `check-review.ts`, `check-patch.ts`, `check-deploy.ts`) and
picks exactly one winning item via `work-selector.ts`'s `selectNextWorkItem` (strict
age-based FIFO). What "no dependency between skills" means in practice: none of the four
commands' *qualification logic* depends on another command's prior run — a PR can be
`deploy`ed without `review` having produced task-store state first, as long as it is
independently approved and green on GitHub.

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

## Candidate Selection Contract

Selection of *what* to work on no longer happens inside `dev-task`, `review`, `patch`, or
`deploy` themselves. It happens once, upstream, in `agent/src`'s native TypeScript
candidate providers — `check-dev-task.ts` (`getDevTaskCandidates`), `check-review.ts`
(`getReviewCandidates`), `check-patch.ts` (`getPatchCandidates`), and `check-deploy.ts`
(`getDeployCandidates`). The `shipwright-loop` cron's `loop-orchestrator.ts` calls the
providers for every enabled phase each tick, merges their results, and picks exactly one
winning item via `work-selector.ts`'s `selectNextWorkItem` (strict age-based FIFO across
task and PR candidates, no phase-priority bias). It then dispatches the one matching
one-shot command with the winning item's id/PR embedded directly in the prompt — e.g.
`/shipwright:dev-task {task-id}` or `/shipwright:review {org/repo#number}`.

### Rules

**The `agent/src` candidate providers are authoritative on what qualifies.**
This is not a best-effort pre-filter the invoked command can override — there is no
second, independent qualification pass inside the command. By the time
`/shipwright:dev-task {id}` or `/shipwright:review {pr}` runs, the item has already been
selected. The command does not re-run candidate qualification logic.

**The command re-validates current-state safety immediately before acting — not
requalification.** Time passes between selection and dispatch (the Claude session has to
spin up), so live state can change. `dev-task`'s Step 2 performs an atomic claim
(`POST /tasks/{id}/claim`, which 409s if another agent claimed the task since selection).
`review`, `patch`, and `deploy` re-check live GitHub state — mergeability, CI status, review
decision — before taking a write action. This check is narrow: it confirms the target is
still safe/current to act on, it does not re-decide whether the target qualifies in the
first place.

**When a provider's qualification logic changes, the corresponding command's Arguments/Step
0-2 assumptions should be reviewed.** If `check-deploy.ts` adds a new qualification
requirement, `deploy.md`'s current-state re-validation should be checked to make sure it
still makes sense against the new qualification bar.

**Selection and dispatch are both driven by explicit targets, human or automated.** A human
can also invoke any of the four commands directly with an explicit task id or PR — the
Independence Principles above still apply to that path. The only thing that no longer
exists is a mode where the command scans for its own candidates.

---

## System Cron Changes

System crons are the crons defined in `SYSTEM_CRONS` — they cover both the core shipwright loop (dev-task, review, patch, deploy) and maintenance tasks (entropy patrol, docs freshness, etc.). When a shipwright change adds, removes, or restructures any system cron, flag two questions during planning:

1. **Backward compatibility.** Will existing agents break when the new code ships but before their crons are updated? If yes, the PR needs a migration path baked in (flag, fallback, graceful no-op) so agents degrade cleanly rather than silently error.

2. **Agent migration.** Which agents are running the old cron pattern and need to be updated? There is no automated migration tooling yet — plan how the rollout will happen before committing to the change.

**New system crons always ship disabled.** Any cron added to `SYSTEM_CRONS` must have `enabled: false`. Enable it per-agent when ready. This avoids new crons firing unexpectedly on agents that haven't opted in. The exception is crons explicitly replacing a prior cron — but even then, add disabled, verify, then enable and disable the old one.

**dev-task, review, patch, and deploy are phases dispatched by `shipwright-loop`, not independent self-discovering crons.** `shipwright-dev-task`, `shipwright-review`, `shipwright-patch`, and `shipwright-deploy` are registered in `SYSTEM_CRONS` with `parentCron: "shipwright-loop"` (see `admin/src/system-crons.ts`). `shipwright-loop`'s `loop-orchestrator.ts` is the sole dispatcher — see the Candidate Selection Contract above: it calls each phase's candidate provider every tick, merges the results, picks exactly one winning item via `selectNextWorkItem`, and runs the one matching command with the target embedded. `dev-task`, `review`, and `patch` ship `enabled: true` by default; `deploy` ships `enabled: false` (explicit opt-in). None of the four scans for its own candidates.

---

## Environment Variables

See [`docs/configuration.md`](../../docs/configuration.md) for the full reference — plugin env vars (`SHIPWRIGHT_REPO_DIR`, `SHIPWRIGHT_WORKTREE_DIR`, task-store vars, etc.), agent env vars, and policy config.
